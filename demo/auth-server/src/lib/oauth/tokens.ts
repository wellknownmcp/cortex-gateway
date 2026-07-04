/**
 * OAuth 2.1 access & refresh token lifecycle.
 *
 * Access tokens are RS256-signed JWTs (stateless verification through JWKS)
 * AND their SHA256 hash is stored in DB so individual tokens can be revoked
 * before natural expiry (hybrid stateless + revocable pattern).
 *
 * Refresh tokens are opaque 32-byte strings, hashed in DB, rotated on every
 * use. Reuse of a rotated refresh token triggers full-chain revocation
 * (OAuth 2.1 theft detection).
 *
 * JWT claims are shaped for cortex-gateway's resource verifier:
 * sub, jti, scope (space-separated), email, pool.
 */

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { prisma } from '../prisma';
import { getPrivateKey, getPublicKey, getKeyId, getIssuer, OAUTH_SIGNING_ALG } from './keys';
import { sha256Hex, randomBase64url } from './crypto';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Audience of access tokens = the gateway's canonical MCP URI (RFC 8707). */
export function getMcpAudience(): string {
  const aud = process.env.OAUTH_MCP_AUDIENCE;
  if (!aud) throw new Error('OAUTH_MCP_AUDIENCE is required (the gateway canonical URI, e.g. https://mcp.<domain>/mcp)');
  return aud;
}

export interface AccessTokenClaims extends JWTPayload {
  iss: string;
  sub: string; // user id (UUID)
  aud: string;
  jti: string;
  client_id: string;
  email: string;
  pool: string;
  scope: string;
}

export interface IssueTokenParams {
  clientDbId: string; // oauth_clients.id (DB UUID)
  clientPublicId: string; // RFC client_id value (JWT claim)
  userId: string;
  userEmail: string;
  scopes: string[];
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface IssuedTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

async function signAccessJwt(params: {
  clientPublicId: string;
  userId: string;
  userEmail: string;
  scopes: string[];
  nowSec: number;
  expSec: number;
  jti: string;
}): Promise<string> {
  const privateKey = await getPrivateKey();
  return new SignJWT({
    client_id: params.clientPublicId,
    email: params.userEmail,
    pool: 'demo',
    scope: params.scopes.join(' '),
  })
    .setProtectedHeader({ alg: OAUTH_SIGNING_ALG, kid: getKeyId() })
    .setIssuer(getIssuer())
    .setSubject(params.userId)
    .setAudience(getMcpAudience())
    .setIssuedAt(params.nowSec)
    .setExpirationTime(params.expSec)
    .setJti(params.jti)
    .sign(privateKey);
}

/** Issues a fresh access + refresh pair and stores their hashes. */
export async function issueTokenPair(params: IssueTokenParams): Promise<IssuedTokenPair> {
  const now = Math.floor(Date.now() / 1000);
  const accessExp = now + ACCESS_TOKEN_TTL_SECONDS;
  const refreshExp = now + REFRESH_TOKEN_TTL_SECONDS;

  const accessToken = await signAccessJwt({
    clientPublicId: params.clientPublicId,
    userId: params.userId,
    userEmail: params.userEmail,
    scopes: params.scopes,
    nowSec: now,
    expSec: accessExp,
    jti: randomBase64url(16),
  });
  const refreshToken = randomBase64url(32);

  await prisma.$transaction([
    prisma.oauthAccessToken.create({
      data: {
        tokenHash: sha256Hex(accessToken),
        clientId: params.clientDbId,
        userId: params.userId,
        scopes: params.scopes,
        expiresAt: new Date(accessExp * 1000),
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent?.slice(0, 500) ?? null,
      },
    }),
    prisma.oauthRefreshToken.create({
      data: {
        tokenHash: sha256Hex(refreshToken),
        clientId: params.clientDbId,
        userId: params.userId,
        scopes: params.scopes,
        expiresAt: new Date(refreshExp * 1000),
      },
    }),
  ]);

  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

/** Pure-crypto JWT verification (no DB hit). */
export async function verifyAccessTokenJwt(token: string): Promise<AccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, await getPublicKey(), {
      issuer: getIssuer(),
      audience: getMcpAudience(),
      algorithms: [OAUTH_SIGNING_ALG],
    });
    return payload as AccessTokenClaims;
  } catch {
    return null;
  }
}

/**
 * Full verification: JWT signature + DB revocation check.
 * Used by /oauth/introspect (the gateway consults it to detect revocation).
 */
export async function verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
  const claims = await verifyAccessTokenJwt(token);
  if (!claims) return null;
  const record = await prisma.oauthAccessToken.findUnique({
    where: { tokenHash: sha256Hex(token) },
    select: { revokedAt: true, expiresAt: true },
  });
  if (!record || record.revokedAt || record.expiresAt < new Date()) return null;
  return claims;
}

/**
 * Strict OAuth 2.1 refresh rotation, atomic. Reuse of an already-rotated
 * token triggers full-chain revocation (theft detection).
 *
 * @throws Error('THEFT_DETECTED') on rotated-token reuse
 */
export async function rotateRefreshToken(
  refreshToken: string,
  requestedScopes?: string[],
): Promise<IssuedTokenPair | null> {
  const record = await prisma.oauthRefreshToken.findUnique({
    where: { tokenHash: sha256Hex(refreshToken) },
    include: {
      client: { select: { id: true, clientId: true } },
      user: { select: { id: true, email: true } },
    },
  });

  if (!record) return null;
  if (record.expiresAt < new Date()) return null;

  if (record.rotatedToId) {
    await revokeRefreshChain(record.userId, record.client.id);
    throw new Error('THEFT_DETECTED');
  }
  if (record.revokedAt) return null;

  // Refresh may narrow scopes, never widen.
  const scopes = requestedScopes && requestedScopes.length > 0 ? requestedScopes : record.scopes;
  if (requestedScopes) {
    const allowed = new Set(record.scopes);
    if (!requestedScopes.every((s) => allowed.has(s))) return null;
  }

  const now = Math.floor(Date.now() / 1000);
  const accessExp = now + ACCESS_TOKEN_TTL_SECONDS;
  const refreshExp = now + REFRESH_TOKEN_TTL_SECONDS;

  // JWT signing happens before the transaction (no DB access).
  const accessToken = await signAccessJwt({
    clientPublicId: record.client.clientId,
    userId: record.user.id,
    userEmail: record.user.email,
    scopes,
    nowSec: now,
    expSec: accessExp,
    jti: randomBase64url(16),
  });
  const newRefreshToken = randomBase64url(32);

  // Atomic: create new pair AND retire the old refresh in one transaction —
  // anything less leaves a double-use window on the old token.
  await prisma.$transaction(async (tx) => {
    await tx.oauthAccessToken.create({
      data: {
        tokenHash: sha256Hex(accessToken),
        clientId: record.client.id,
        userId: record.user.id,
        scopes,
        expiresAt: new Date(accessExp * 1000),
      },
    });
    const newRefresh = await tx.oauthRefreshToken.create({
      data: {
        tokenHash: sha256Hex(newRefreshToken),
        clientId: record.client.id,
        userId: record.user.id,
        scopes,
        expiresAt: new Date(refreshExp * 1000),
      },
    });
    await tx.oauthRefreshToken.update({
      where: { id: record.id },
      data: { rotatedToId: newRefresh.id, revokedAt: new Date() },
    });
  });

  return { accessToken, refreshToken: newRefreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

/** Revokes every live token of (user, client) — theft response. */
async function revokeRefreshChain(userId: string, clientDbId: string): Promise<void> {
  const now = new Date();
  await prisma.$transaction([
    prisma.oauthRefreshToken.updateMany({
      where: { userId, clientId: clientDbId, revokedAt: null },
      data: { revokedAt: now },
    }),
    prisma.oauthAccessToken.updateMany({
      where: { userId, clientId: clientDbId, revokedAt: null },
      data: { revokedAt: now },
    }),
  ]);
}

/** Revokes a single access token by value, scoped to the owning client. */
export async function revokeAccessToken(token: string, clientDbId: string): Promise<void> {
  await prisma.oauthAccessToken.updateMany({
    where: { tokenHash: sha256Hex(token), clientId: clientDbId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Revokes a single refresh token by value, scoped to the owning client. */
export async function revokeRefreshToken(token: string, clientDbId: string): Promise<void> {
  await prisma.oauthRefreshToken.updateMany({
    where: { tokenHash: sha256Hex(token), clientId: clientDbId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
