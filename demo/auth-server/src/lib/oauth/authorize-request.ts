/**
 * Authorize-request JWT.
 *
 * /oauth/authorize validates the request params then redirects the user to
 * the consent screen. Instead of persisting the in-flight request in a
 * transient table, the validated params are signed into a short-lived JWT
 * (5 min) passed as `?req=<jwt>`. The consent page verifies the signature
 * (no DB hit) and can trust the params were pre-validated.
 */

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { getPrivateKey, getPublicKey, getKeyId, OAUTH_SIGNING_ALG } from './keys';

export const AUTHORIZE_REQUEST_TTL_SECONDS = 5 * 60;
const AUDIENCE = 'cortex-demo:oauth-consent';
const ISSUER = 'cortex-demo:oauth-server';

export interface AuthorizeRequestClaims extends JWTPayload {
  client_id: string; // public client_id
  client_db_id: string; // oauth_clients.id (avoids a lookup on the consent page)
  client_name: string;
  client_uri?: string | null;
  logo_uri?: string | null;
  redirect_uri: string;
  scopes: string[]; // already filtered to known + client-allowed
  state?: string;
  code_challenge: string;
  code_challenge_method: 'S256';
}

export async function signAuthorizeRequest(claims: AuthorizeRequestClaims): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: OAUTH_SIGNING_ALG, kid: getKeyId() })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + AUTHORIZE_REQUEST_TTL_SECONDS)
    .sign(await getPrivateKey());
}

export async function verifyAuthorizeRequest(token: string): Promise<AuthorizeRequestClaims | null> {
  try {
    const { payload } = await jwtVerify(token, await getPublicKey(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: [OAUTH_SIGNING_ALG],
    });
    return payload as AuthorizeRequestClaims;
  } catch {
    return null;
  }
}
