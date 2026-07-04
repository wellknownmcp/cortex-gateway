/**
 * Generic OAuth 2.1 resource-server verifier.
 *
 * Verifies Bearer JWTs against the authorization server's JWKS
 * (`<issuer>/.well-known/jwks.json` by default), checks issuer + audience +
 * expiration + optional required scopes, and optionally consults an
 * RFC 7662 introspection endpoint to detect revoked tokens (with a local
 * LRU cache to avoid hammering the AS).
 *
 * Claims convention (all optional beyond `sub` and `jti`):
 * - `scope`    : space-separated scopes (RFC 8693 style)
 * - `email`    : user email
 * - `name`     : display name
 * - `pool`     : audience pool/realm, if your AS segments user populations
 * - `client_id`: OAuth client that obtained the token
 * - `metadata` : free-form object (e.g. `{ role: 'admin' }`)
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { LruCache } from './lru-cache';

export interface VerifiedOAuthToken {
  sub: string;
  clientId: string;
  scopes: string[];
  pool: string;
  email: string;
  name: string;
  jti: string;
  metadata?: Record<string, unknown>;
  raw: JWTPayload;
}

/**
 * Optional RFC 7662 introspection configuration.
 *
 * When provided, the verifier consults the authorization server after
 * cryptographic verification to confirm the token has not been revoked.
 * Results are cached locally (LRU). Classic revocation-window/perf
 * trade-off: the 60s default is reasonable for most cases.
 */
export interface OAuthIntrospectConfig {
  /** Absolute URL of the introspection endpoint. */
  url: string;
  /** Confidential OAuth client allowed to introspect (Basic auth). */
  clientId: string;
  clientSecret: string;
  /** Local cache TTL in seconds. Default 60. */
  cacheTtlSeconds?: number;
  /** Max cache size. Default 10 000. */
  cacheMaxEntries?: number;
  /** fetch implementation (testability). Default globalThis.fetch. */
  fetchFn?: typeof fetch;
}

export interface OAuthVerifyConfig {
  issuer: string;
  audience: string;
  jwksUrl?: string;
  requiredScopes?: string[];
  /** For tests: inject a pre-built JWKS getter instead of fetching the remote URL. */
  jwks?: JWTVerifyGetKey;
  /** Enables the revocation blocklist check through RFC 7662 introspection. */
  introspect?: OAuthIntrospectConfig;
}

export class InvalidTokenError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'InvalidTokenError';
    this.code = code;
  }
}

export class InsufficientScopeError extends Error {
  readonly required: string[];
  readonly granted: string[];
  constructor(required: string[], granted: string[]) {
    super('Missing scopes: ' + required.filter((s) => !granted.includes(s)).join(' '));
    this.name = 'InsufficientScopeError';
    this.required = required;
    this.granted = granted;
  }
}

export interface OAuthVerifier {
  verify: (authorizationHeader: string | null | undefined) => Promise<VerifiedOAuthToken>;
}

interface IntrospectResult {
  active: boolean;
}

/**
 * Calls the introspection endpoint. Returns {active: true} on network errors
 * so legitimate requests are not blocked (fail-open) — a revocation will be
 * detected at the next cache expiry.
 *
 * If you prefer fail-close (reject all tokens when the AS is down), wrap the
 * caller and catch InvalidTokenError code='introspect_unavailable'.
 */
async function introspectToken(config: OAuthIntrospectConfig, token: string): Promise<IntrospectResult> {
  const fetcher = config.fetchFn ?? fetch;
  const auth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const body = new URLSearchParams({ token }).toString();
  try {
    const res = await fetcher(config.url, {
      method: 'POST',
      headers: {
        authorization: `Basic ${auth}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!res.ok) {
      // 401/403 means the introspect client is misconfigured: surface it
      // instead of silently failing open.
      if (res.status === 401 || res.status === 403) {
        throw new InvalidTokenError(
          'introspect_misconfigured',
          `Introspection rejected with status ${res.status} — check client credentials`,
        );
      }
      // 5xx: temporary fail-open
      return { active: true };
    }
    const json = (await res.json()) as { active?: boolean };
    return { active: json.active === true };
  } catch (e) {
    if (e instanceof InvalidTokenError) throw e;
    // network error: fail-open
    return { active: true };
  }
}

export function createOAuthVerifier(config: OAuthVerifyConfig): OAuthVerifier {
  const jwksUrl = config.jwksUrl ?? config.issuer.replace(/\/$/, '') + '/.well-known/jwks.json';
  const jwks = config.jwks ?? createRemoteJWKSet(new URL(jwksUrl));

  // Introspection cache: keyed by jti, value = active boolean.
  const introspectCache = config.introspect
    ? new LruCache<string, boolean>({
        maxEntries: config.introspect.cacheMaxEntries ?? 10_000,
        defaultTtlMs: (config.introspect.cacheTtlSeconds ?? 60) * 1000,
      })
    : null;

  return {
    async verify(authorizationHeader) {
      if (!authorizationHeader) {
        throw new InvalidTokenError('missing_token', 'Authorization header missing');
      }
      const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
      if (!match) {
        throw new InvalidTokenError('invalid_scheme', 'Authorization header must be Bearer');
      }
      const token = match[1];

      let payload: JWTPayload;
      try {
        const result = await jwtVerify(token, jwks, {
          issuer: config.issuer,
          audience: config.audience,
          algorithms: ['RS256'],
        });
        payload = result.payload;
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'invalid token';
        throw new InvalidTokenError('invalid_token', msg);
      }

      const scopeString = typeof payload.scope === 'string' ? payload.scope : '';
      const granted = scopeString.split(/\s+/).filter(Boolean);

      if (config.requiredScopes && config.requiredScopes.length > 0) {
        const missing = config.requiredScopes.filter((s) => !granted.includes(s));
        if (missing.length > 0) {
          throw new InsufficientScopeError(config.requiredScopes, granted);
        }
      }

      if (!payload.sub) {
        throw new InvalidTokenError('invalid_token', 'Missing sub claim');
      }
      if (!payload.jti) {
        throw new InvalidTokenError('invalid_token', 'Missing jti claim');
      }

      // Revocation blocklist check (when introspection is configured).
      if (config.introspect && introspectCache) {
        const jti = String(payload.jti);
        const cached = introspectCache.get(jti);
        let active: boolean;
        if (cached !== undefined) {
          active = cached;
        } else {
          const result = await introspectToken(config.introspect, token);
          active = result.active;
          introspectCache.set(jti, active);
        }
        if (!active) {
          throw new InvalidTokenError('token_revoked', 'Token revoked by authorization server');
        }
      }

      return {
        sub: payload.sub,
        clientId: String(payload.client_id ?? ''),
        scopes: granted,
        pool: String(payload.pool ?? ''),
        email: String(payload.email ?? ''),
        name: String(payload.name ?? ''),
        jti: String(payload.jti),
        metadata: (payload.metadata as Record<string, unknown> | undefined) ?? undefined,
        raw: payload,
      };
    },
  };
}
