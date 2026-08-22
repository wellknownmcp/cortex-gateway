/**
 * Signed, time-boxed tokens for the login form.
 *
 * A magic-link form is an open email-sending surface: whoever can POST to it
 * makes the server send mail to an address of their choosing. The token proves
 * the POST follows a real GET of the form and that a human-plausible delay
 * elapsed. It is not a CAPTCHA — it stops scripted posters that never fetch
 * the page, which is what the abuse observed on this demo actually looks like.
 *
 * The HMAC key is derived from the OAuth signing key: no extra secret to
 * provision, and no hardcoded fallback that would silently disable the check.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Below this, nobody read the page and typed an address. */
const MIN_AGE_MS = 1_000;
/** Above this the form is stale — the user gets a "reload and retry" message. */
const MAX_AGE_MS = 60 * 60_000;

let keyCache: Buffer | null = null;

function hmacKey(): Buffer {
  if (keyCache) return keyCache;
  const seed = process.env.OAUTH_SIGNING_PRIVATE_KEY;
  if (!seed) {
    throw new Error('Missing env var OAUTH_SIGNING_PRIVATE_KEY (login form token key derivation).');
  }
  keyCache = createHash('sha256').update(`cortex-demo-login-form|${seed}`).digest();
  return keyCache;
}

function sign(issuedAt: string): string {
  return createHmac('sha256', hmacKey()).update(issuedAt).digest('base64url');
}

export interface FormToken {
  issuedAt: string;
  signature: string;
}

export function issueFormToken(): FormToken {
  const issuedAt = String(Date.now());
  return { issuedAt, signature: sign(issuedAt) };
}

export type FormTokenVerdict = 'ok' | 'invalid' | 'too-fast' | 'expired';

export function verifyFormToken(issuedAt: string, signature: string): FormTokenVerdict {
  if (!/^\d{10,16}$/.test(issuedAt) || !signature) return 'invalid';
  const expected = Buffer.from(sign(issuedAt));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return 'invalid';
  const age = Date.now() - Number(issuedAt);
  if (age < MIN_AGE_MS) return 'too-fast';
  if (age > MAX_AGE_MS) return 'expired';
  return 'ok';
}

/**
 * Name of the honeypot field. Rendered off-screen and left empty by anyone
 * using a browser; form-filling bots populate every input they find.
 */
export const HONEYPOT_FIELD = 'website';
