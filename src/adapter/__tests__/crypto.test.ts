import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encrypt, decrypt, sealJson, openJson } from '../crypto';

describe('vault crypto (AES-256-GCM)', () => {
  beforeEach(() => {
    process.env.CORTEX_VAULT_KEY = randomBytes(32).toString('base64');
  });

  it('round-trips a token', () => {
    const secret = 'ya29.a0AfH6SMB-example-downstream-token';
    expect(decrypt(encrypt(secret))).toBe(secret);
  });

  it('produces distinct ciphertexts for the same plaintext (random IV)', () => {
    expect(encrypt('same')).not.toBe(encrypt('same'));
  });

  it('rejects tampered payloads (GCM auth)', () => {
    const sealed = encrypt('payload');
    const tampered = sealed.slice(0, -2) + (sealed.endsWith('AA') ? 'BB' : 'AA');
    expect(() => decrypt(tampered)).toThrow();
  });

  it('round-trips JSON state blobs', () => {
    const state = { sub: 'u1', provider: 'canva', verifier: 'v'.repeat(43), exp: 123 };
    expect(openJson(sealJson(state))).toEqual(state);
  });

  it('refuses a key of the wrong size', () => {
    process.env.CORTEX_VAULT_KEY = Buffer.from('short').toString('base64');
    expect(() => encrypt('x')).toThrow(/32 bytes/);
  });

  it('refuses to run without a key', () => {
    delete process.env.CORTEX_VAULT_KEY;
    expect(() => encrypt('x')).toThrow(/CORTEX_VAULT_KEY/);
  });
});
