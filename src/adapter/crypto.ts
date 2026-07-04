/**
 * Vault encryption — AES-256-GCM with a single symmetric key.
 *
 * `CORTEX_VAULT_KEY` = 32 bytes, base64-encoded (generate with
 * `openssl rand -base64 32`). It protects downstream OAuth tokens at rest and
 * the self-contained OAuth `state` blobs of the linking flow. Rotating it
 * invalidates stored tokens (users just re-link).
 *
 * Wire format: base64url( iv[12] | authTag[16] | ciphertext ).
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function key(): Buffer {
  const raw = process.env.CORTEX_VAULT_KEY;
  if (!raw) {
    throw new Error('CORTEX_VAULT_KEY is required for the MCP adapter (32 bytes, base64)');
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error('CORTEX_VAULT_KEY must decode to exactly 32 bytes');
  }
  return buf;
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64url');
}

export function decrypt(payload: string): string {
  const buf = Buffer.from(payload, 'base64url');
  if (buf.length < 12 + 16 + 1) throw new Error('Vault payload too short');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** Encrypts a JSON value (used for the OAuth state blob). */
export function sealJson(value: unknown): string {
  return encrypt(JSON.stringify(value));
}

/** Decrypts a JSON value; throws on tampering (GCM auth) or bad JSON. */
export function openJson<T>(payload: string): T {
  return JSON.parse(decrypt(payload)) as T;
}
