/**
 * OAuth crypto primitives: PKCE S256 verification, SHA256 hashing, random
 * generation, timing-safe comparisons.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** SHA256 digest as lowercase hex. Tokens are ALWAYS hashed before DB storage. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** URL-safe random string (base64url, no padding). 32 bytes ≈ 43 chars. */
export function randomBase64url(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Constant-time comparison. Hashes BOTH inputs to fixed-length SHA-256
 * buffers BEFORE comparing — a naive early-return on length mismatch leaks
 * the stored secret's byte length through response timing.
 */
export function safeCompare(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Verifies a presented client secret against a stored SHA-256 hex hash.
 * Never compare with `!==` — timing oracle.
 */
export function verifyClientSecret(secret: string, storedHash: string): boolean {
  if (!secret || !storedHash) return false;
  const computed = Buffer.from(sha256Hex(secret));
  const stored = Buffer.from(storedHash);
  if (computed.length !== stored.length) return false;
  return timingSafeEqual(computed, stored);
}

/**
 * Verifies a PKCE code_verifier against a code_challenge (S256 only — OAuth
 * 2.1 forbids 'plain'). Challenge length is public (43 chars), so the
 * length-aware compare leaks nothing.
 */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  const computed = createHash('sha256').update(verifier).digest('base64url');
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
