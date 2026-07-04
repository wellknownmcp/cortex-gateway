/**
 * Token vault — per-user, per-provider downstream OAuth tokens, encrypted at
 * rest (AES-256-GCM, see crypto.ts), with silent refresh.
 *
 * This is the security-critical component of the adapter: it holds the keys
 * to third-party accounts. Cortex's own JWT never leaves the OAuth perimeter
 * it was issued for; the vault is what translates "our user" into "their
 * token" at the adapter boundary.
 */

import { getPrismaCortex } from '@/lib/prisma';
import { encrypt, decrypt } from './crypto';
import { ensureClient, tokenRequest } from './oauth-discovery';
import type { McpServerConfig } from './config';

export interface StoredGrant {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
}

export async function storeGrant(
  sub: string,
  provider: string,
  tokenEndpoint: string,
  grant: { access_token: string; refresh_token?: string; expires_in?: number; scope?: string },
): Promise<void> {
  const prisma = getPrismaCortex();
  const expiresAt = grant.expires_in ? new Date(Date.now() + grant.expires_in * 1000) : null;
  await prisma.linkedAccount.upsert({
    where: { sub_provider: { sub, provider } },
    create: {
      sub,
      provider,
      accessToken: encrypt(grant.access_token),
      refreshToken: grant.refresh_token ? encrypt(grant.refresh_token) : null,
      expiresAt,
      scope: grant.scope ?? null,
      tokenEndpoint,
    },
    update: {
      accessToken: encrypt(grant.access_token),
      refreshToken: grant.refresh_token ? encrypt(grant.refresh_token) : null,
      expiresAt,
      scope: grant.scope ?? null,
      tokenEndpoint,
    },
  });
}

export async function deleteGrant(sub: string, provider: string): Promise<boolean> {
  const prisma = getPrismaCortex();
  const res = await prisma.linkedAccount.deleteMany({ where: { sub, provider } });
  return res.count > 0;
}

export async function isLinked(sub: string, provider: string): Promise<boolean> {
  const prisma = getPrismaCortex();
  const row = await prisma.linkedAccount.findUnique({ where: { sub_provider: { sub, provider } } });
  return row !== null;
}

/**
 * Returns a valid downstream access token for (sub, provider), refreshing it
 * when expired (60s early). Returns null when the account is not linked.
 * Throws when the refresh fails (the caller should tell the user to re-link).
 */
export async function getValidToken(sub: string, server: McpServerConfig): Promise<string | null> {
  const prisma = getPrismaCortex();
  const row = await prisma.linkedAccount.findUnique({
    where: { sub_provider: { sub, provider: server.id } },
  });
  if (!row) return null;

  const fresh = !row.expiresAt || row.expiresAt.getTime() > Date.now() + 60_000;
  if (fresh) return decrypt(row.accessToken);

  if (!row.refreshToken) {
    throw new Error(`Downstream token for ${server.id} expired and no refresh token was granted — re-link the account`);
  }

  const client = await ensureClient(server);
  const grant = await tokenRequest(
    { tokenEndpoint: row.tokenEndpoint || client.tokenEndpoint, clientId: client.clientId, clientSecret: client.clientSecret },
    { grant_type: 'refresh_token', refresh_token: decrypt(row.refreshToken) },
  );
  await storeGrant(sub, server.id, row.tokenEndpoint || client.tokenEndpoint, {
    ...grant,
    // Some providers rotate refresh tokens; keep the old one when not rotated.
    refresh_token: grant.refresh_token ?? decrypt(row.refreshToken),
  });
  return grant.access_token;
}
