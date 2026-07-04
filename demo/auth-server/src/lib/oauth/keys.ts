/**
 * OAuth 2.1 signing key management.
 *
 * Loads the RSA 2048 keypair from env vars, exposes cached CryptoKeys + the
 * JWKS. RS256 asymmetric signing lets resource servers (the gateway) verify
 * tokens through /.well-known/jwks.json without any shared secret.
 *
 * Generate the keypair with `bash scripts/generate-oauth-keys.sh`.
 * The private key MUST only live in env vars — never in git.
 */

import { importPKCS8, importSPKI, exportJWK, type JWK } from 'jose';

const ALG = 'RS256';

// jose v6+ uses the native CryptoKey type (KeyLike was removed).
let privateKeyCache: CryptoKey | null = null;
let publicKeyCache: CryptoKey | null = null;
let jwksCache: { keys: JWK[] } | null = null;

function getEnvKey(name: string): string {
  const raw = process.env[name];
  if (!raw) {
    throw new Error(`Missing env var ${name}. Generate a keypair with 'bash scripts/generate-oauth-keys.sh'.`);
  }
  // Env vars store PEM with literal \n escapes; convert to real newlines.
  return raw.replace(/\\n/g, '\n');
}

export function getKeyId(): string {
  return process.env.OAUTH_KEY_ID || 'cortex-demo-auth-default';
}

/**
 * Public URL of this authorization server. Always from env — behind a reverse
 * proxy, `url.origin` resolves to the internal upstream, not the public host.
 */
export function getIssuer(): string {
  return (process.env.OAUTH_ISSUER || 'http://localhost:3220').replace(/\/$/, '');
}

export async function getPrivateKey(): Promise<CryptoKey> {
  if (privateKeyCache) return privateKeyCache;
  privateKeyCache = (await importPKCS8(getEnvKey('OAUTH_SIGNING_PRIVATE_KEY'), ALG)) as CryptoKey;
  return privateKeyCache;
}

export async function getPublicKey(): Promise<CryptoKey> {
  if (publicKeyCache) return publicKeyCache;
  publicKeyCache = (await importSPKI(getEnvKey('OAUTH_SIGNING_PUBLIC_KEY'), ALG)) as CryptoKey;
  return publicKeyCache;
}

/** JWKS published at /.well-known/jwks.json — public key only. */
export async function getJwks(): Promise<{ keys: JWK[] }> {
  if (jwksCache) return jwksCache;
  const jwk = await exportJWK(await getPublicKey());
  jwk.alg = ALG;
  jwk.use = 'sig';
  jwk.kid = getKeyId();
  jwksCache = { keys: [jwk] };
  return jwksCache;
}

export const OAUTH_SIGNING_ALG = ALG;
