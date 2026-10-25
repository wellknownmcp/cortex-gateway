import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time comparison of a provided secret against the expected one.
 * An empty expected value never matches: an unset secret must not open a door.
 */
export function safeEqual(provided: string | null | undefined, expected: string | null | undefined): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Length first: timingSafeEqual throws on a mismatch.
  return a.length === b.length && timingSafeEqual(a, b);
}
