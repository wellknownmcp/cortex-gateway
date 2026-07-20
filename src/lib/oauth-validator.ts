/**
 * OAuth validation of incoming MCP requests.
 *
 * Wraps the generic verifier with:
 * - audience check (= OAUTH_AUDIENCE, falling back to CORTEX_CANONICAL_URI —
 *   RFC 8707 audience-per-resource pattern)
 * - user context extraction (pool, role) for propagation to backends
 * - local dev bypass via the X-Dev-Mode header (non-production only)
 */

import { createOAuthVerifier, InvalidTokenError, InsufficientScopeError } from './oauth';
import type { OAuthVerifier, OAuthIntrospectConfig } from './oauth';

export interface ValidatedRequest {
  /** JWT sub — identifies the end user. */
  sub: string;
  /** User email (JWT `email` claim, empty string when absent). */
  email: string;
  /** Application role (JWT `metadata.role` claim, empty when absent). */
  role: string;
  /** OAuth pool/realm (JWT `pool` claim, empty when absent). */
  pool: string;
  /** Scopes granted by the token. */
  scopes: readonly string[];
  /** OAuth client that obtained the token (for audit). */
  clientId: string;
  /** Token jti (for audit + revocation). */
  jti: string | null;
  /** Raw token — propagated to backends, which re-validate it themselves. */
  bearerToken: string;
  /** Dev bypass mode (not a real OAuth token)? */
  isDevBypass: boolean;
}

export function canonicalUri(): string {
  return process.env.CORTEX_CANONICAL_URI ?? 'http://localhost:3213/mcp';
}

function issuer(): string {
  const value = process.env.OAUTH_ISSUER;
  if (!value) {
    throw new Error('OAUTH_ISSUER is required (URL of your OAuth 2.1 authorization server)');
  }
  return value;
}

let _verifier: OAuthVerifier | null = null;
function getVerifier(): OAuthVerifier {
  if (_verifier) return _verifier;
  const audience = process.env.OAUTH_AUDIENCE ?? canonicalUri();

  // Optional RFC 7662 introspection (revocation detection).
  let introspect: OAuthIntrospectConfig | undefined;
  const introspectUrl = process.env.OAUTH_INTROSPECT_URL;
  const introspectClientId = process.env.OAUTH_INTROSPECT_CLIENT_ID;
  const introspectClientSecret = process.env.OAUTH_INTROSPECT_CLIENT_SECRET;
  if (introspectUrl && introspectClientId && introspectClientSecret) {
    introspect = {
      url: introspectUrl,
      clientId: introspectClientId,
      clientSecret: introspectClientSecret,
      cacheTtlSeconds: Number.parseInt(process.env.OAUTH_INTROSPECT_CACHE_TTL_SECONDS ?? '60', 10),
    };
  }

  // Optional floor scope, checked before any dispatch. Per-tool scopes are the
  // real authorization model, but the gateway builtins (`whoami`,
  // `list_cortex_resources`, ...) deliberately require none — so without this,
  // any syntactically valid token for this audience reaches them. Set
  // OAUTH_REQUIRED_SCOPES to demand a baseline (e.g. `mcp:access`).
  const requiredScopes = (process.env.OAUTH_REQUIRED_SCOPES ?? '')
    .split(/[,\s]+/)
    .filter(Boolean);

  _verifier = createOAuthVerifier({
    issuer: issuer(),
    audience,
    jwksUrl: process.env.OAUTH_JWKS_URL || undefined,
    requiredScopes: requiredScopes.length > 0 ? requiredScopes : undefined,
    introspect,
  });
  return _verifier;
}

function isLocalOrigin(req: Request): boolean {
  const host = req.headers.get('host') ?? '';
  return host.startsWith('localhost') || host.startsWith('127.0.0.1') || host.startsWith('[::1]');
}

/**
 * Validates the request and extracts the user context. On failure the caller
 * returns 401/403 with the appropriate WWW-Authenticate header.
 */
export async function validateRequest(req: Request): Promise<
  | { ok: true; context: ValidatedRequest }
  | { ok: false; status: 401 | 403; wwwAuthenticate?: string; error: string }
> {
  // Dev bypass (localhost + non-production only). Lets you exercise the
  // gateway without a running OAuth server:
  //   CORTEX_DEV_BYPASS_TOKEN=secret CORTEX_DEV_BYPASS_SCOPES=mcp:demo:read
  //   curl -H "X-Dev-Mode: secret" ...
  const devToken = process.env.CORTEX_DEV_BYPASS_TOKEN;
  const devHeader = req.headers.get('x-dev-mode');
  if (
    devToken &&
    devHeader &&
    process.env.NODE_ENV !== 'production' &&
    isLocalOrigin(req) &&
    devHeader === devToken
  ) {
    // eslint-disable-next-line no-console
    console.warn('[cortex] OAuth dev bypass active — NEVER enable in production');
    const devScopes = (process.env.CORTEX_DEV_BYPASS_SCOPES ?? '')
      .split(/[,\s]+/)
      .filter(Boolean);
    return {
      ok: true,
      context: {
        sub: 'dev:local',
        email: 'dev@localhost',
        role: process.env.CORTEX_DEV_BYPASS_ROLE ?? 'admin',
        pool: process.env.CORTEX_REQUIRED_POOL ?? '',
        scopes: devScopes,
        clientId: 'dev-bypass',
        jti: null,
        bearerToken: devToken,
        isDevBypass: true,
      },
    };
  }

  const authHeader = req.headers.get('authorization');
  try {
    const verified = await getVerifier().verify(authHeader);
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    // The application role is an optional custom claim your authorization
    // server may inject under `metadata.role`. When absent, backends decide
    // rights from their own tables.
    const role = typeof verified.metadata?.role === 'string' ? verified.metadata.role : '';
    return {
      ok: true,
      context: {
        sub: verified.sub,
        email: verified.email,
        role,
        pool: verified.pool,
        scopes: verified.scopes,
        clientId: verified.clientId,
        jti: verified.jti,
        bearerToken,
        isDevBypass: false,
      },
    };
  } catch (err) {
    if (err instanceof InsufficientScopeError) {
      return { ok: false, status: 403, error: 'insufficient_scope' };
    }
    if (err instanceof InvalidTokenError) {
      return {
        ok: false,
        status: 401,
        wwwAuthenticate: buildWwwAuthenticate(),
        error: 'invalid_token',
      };
    }
    return {
      ok: false,
      status: 401,
      wwwAuthenticate: buildWwwAuthenticate(),
      error: 'unauthorized',
    };
  }
}

/**
 * WWW-Authenticate header per RFC 9728 §5.1: points to the protected
 * resource metadata document.
 */
export function buildWwwAuthenticate(): string {
  const base = new URL(canonicalUri());
  const metadataUrl = `${base.protocol}//${base.host}/.well-known/oauth-protected-resource`;
  return `Bearer resource_metadata="${metadataUrl}"`;
}
