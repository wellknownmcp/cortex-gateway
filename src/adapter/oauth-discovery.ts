/**
 * Downstream OAuth plumbing for proxied native MCP servers.
 *
 * - RFC 9728 : the MCP server's protected-resource metadata names its
 *   authorization server(s)
 * - RFC 8414 : the AS metadata gives authorize/token/registration endpoints
 * - RFC 7591 : Dynamic Client Registration when no static client is configured
 * - PKCE (RFC 7636) helpers for the linking flow
 *
 * Discovered/registered clients are persisted in the `adapter_oauth_clients`
 * table so DCR happens once per provider.
 */

import { createHash, randomBytes } from 'node:crypto';
import { getPrismaCortex } from '@/lib/prisma';
import { canonicalUri } from '@/lib/oauth-validator';
import { encrypt, decrypt } from './crypto';
import type { McpServerConfig } from './config';

export interface DownstreamAuthServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
}

export interface DownstreamClient extends DownstreamAuthServer {
  clientId: string;
  clientSecret: string | null;
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Discovers the authorization server of a downstream MCP endpoint.
 *
 * Tries RFC 9728 protected-resource metadata (path-aware then root), then
 * falls back to treating the MCP origin itself as the issuer.
 */
export async function discoverAuthServer(mcpUrl: string): Promise<DownstreamAuthServer> {
  const u = new URL(mcpUrl);
  const origin = `${u.protocol}//${u.host}`;
  const path = u.pathname === '/' ? '' : u.pathname;

  let issuer = origin;
  const prm =
    (await fetchJson(`${origin}/.well-known/oauth-protected-resource${path}`)) ??
    (await fetchJson(`${origin}/.well-known/oauth-protected-resource`));
  if (prm && Array.isArray(prm.authorization_servers) && typeof prm.authorization_servers[0] === 'string') {
    issuer = (prm.authorization_servers[0] as string).replace(/\/$/, '');
  }

  const meta =
    (await fetchJson(`${issuer}/.well-known/oauth-authorization-server`)) ??
    (await fetchJson(`${issuer}/.well-known/openid-configuration`));
  if (!meta || typeof meta.authorization_endpoint !== 'string' || typeof meta.token_endpoint !== 'string') {
    throw new Error(`Could not discover OAuth metadata for ${mcpUrl} (issuer tried: ${issuer})`);
  }

  return {
    issuer,
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    registrationEndpoint: typeof meta.registration_endpoint === 'string' ? meta.registration_endpoint : null,
  };
}

/** Redirect URI of the linking flow for a provider, on this gateway's origin. */
export function linkRedirectUri(providerId: string): string {
  const base = new URL(canonicalUri());
  return `${base.protocol}//${base.host}/api/link/${providerId}/callback`;
}

/**
 * Returns a usable OAuth client for the provider, in order of preference:
 * 1. static client from env (CORTEX_MCP_<ID>_CLIENT_ID/_CLIENT_SECRET)
 * 2. previously registered client from the DB
 * 3. fresh Dynamic Client Registration (persisted)
 */
export async function ensureClient(server: McpServerConfig): Promise<DownstreamClient> {
  const auth = await discoverAuthServer(server.url);

  if (server.clientId) {
    return { ...auth, clientId: server.clientId, clientSecret: server.clientSecret ?? null };
  }

  const prisma = getPrismaCortex();
  const existing = await prisma.adapterOAuthClient.findUnique({ where: { provider: server.id } });
  if (existing && existing.issuer === auth.issuer) {
    return {
      ...auth,
      clientId: existing.clientId,
      clientSecret: existing.clientSecret ? decrypt(existing.clientSecret) : null,
    };
  }

  if (!auth.registrationEndpoint) {
    throw new Error(
      `Provider ${server.id}: no static client configured and its AS does not support Dynamic Client Registration — set CORTEX_MCP_${server.id.toUpperCase()}_CLIENT_ID`,
    );
  }

  const res = await fetch(auth.registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: process.env.CORTEX_SERVER_NAME ?? 'cortex-gateway',
      redirect_uris: [linkRedirectUri(server.id)],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // public client + PKCE
    }),
  });
  if (!res.ok) {
    throw new Error(`Provider ${server.id}: DCR failed with status ${res.status}`);
  }
  const reg = (await res.json()) as { client_id?: string; client_secret?: string };
  if (!reg.client_id) {
    throw new Error(`Provider ${server.id}: DCR response missing client_id`);
  }

  await prisma.adapterOAuthClient.upsert({
    where: { provider: server.id },
    create: {
      provider: server.id,
      issuer: auth.issuer,
      clientId: reg.client_id,
      clientSecret: reg.client_secret ? encrypt(reg.client_secret) : null,
      authorizationEndpoint: auth.authorizationEndpoint,
      tokenEndpoint: auth.tokenEndpoint,
      registrationEndpoint: auth.registrationEndpoint,
    },
    update: {
      issuer: auth.issuer,
      clientId: reg.client_id,
      clientSecret: reg.client_secret ? encrypt(reg.client_secret) : null,
      authorizationEndpoint: auth.authorizationEndpoint,
      tokenEndpoint: auth.tokenEndpoint,
      registrationEndpoint: auth.registrationEndpoint,
    },
  });

  return { ...auth, clientId: reg.client_id, clientSecret: reg.client_secret ?? null };
}

// ─── PKCE ─────────────────────────────────────────────────────────────────

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** Exchanges an authorization code (or refresh token) at the token endpoint. */
export async function tokenRequest(
  client: { tokenEndpoint: string; clientId: string; clientSecret: string | null },
  params: Record<string, string>,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number; scope?: string }> {
  const body = new URLSearchParams({ ...params, client_id: client.clientId });
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (client.clientSecret) {
    headers.Authorization =
      'Basic ' + Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64');
    body.delete('client_id');
    body.set('client_id', client.clientId);
  }
  const res = await fetch(client.tokenEndpoint, { method: 'POST', headers, body: body.toString() });
  const json = (await res.json().catch(() => null)) as
    | { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string }
    | null;
  if (!res.ok || !json?.access_token) {
    throw new Error(`Token endpoint error (${res.status}): ${json?.error ?? 'no access_token'}`);
  }
  return json as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
}
