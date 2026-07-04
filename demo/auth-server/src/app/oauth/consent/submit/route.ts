/**
 * POST /oauth/consent/submit — consent form handler.
 *
 * approve → issues a single-use PKCE-bound authorization code, optionally
 * remembers the grant (30d), redirects to the client with ?code=.
 * deny → redirects with ?error=access_denied.
 *
 * Both the request JWT and the session are re-verified (defense in depth —
 * the user may have sat on the consent page past the JWT's 5-min TTL).
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { verifyAuthorizeRequest } from '@/lib/oauth/authorize-request';
import { randomBase64url, sha256Hex } from '@/lib/oauth/crypto';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';
import { getSessionUser } from '@/lib/session';
import { getIssuer } from '@/lib/oauth/keys';

const CODE_TTL_SECONDS = 10 * 60;
const CONSENT_GRANT_TTL_DAYS = 30;

export async function POST(request: NextRequest) {
  const rl = checkRateLimit('oauth-consent', getClientIp(request), 20, 60_000);
  if (!rl.allowed) return consentError(null, 'Rate limit exceeded');

  const form = await request.formData();
  const reqToken = form.get('req');
  const decision = form.get('decision');
  const remember = form.get('remember') === '1';

  if (typeof reqToken !== 'string' || !reqToken) return consentError(null, 'Missing request parameter');
  if (decision !== 'approve' && decision !== 'deny') return consentError(reqToken, 'Invalid decision');

  const claims = await verifyAuthorizeRequest(reqToken);
  if (!claims) return consentError(reqToken, 'Request expired — restart from your MCP client');

  const user = await getSessionUser();
  if (!user) return consentError(reqToken, 'Session expired — sign in again');

  if (decision === 'deny') {
    const url = new URL(claims.redirect_uri);
    url.searchParams.set('error', 'access_denied');
    url.searchParams.set('error_description', 'User denied the authorization request');
    if (claims.state) url.searchParams.set('state', claims.state);
    return NextResponse.redirect(url.toString(), { status: 302 });
  }

  // Grant only the intersection of requested scopes and the user's own.
  const scopes = claims.scopes.filter((s) => user.scopes.includes(s));
  if (scopes.length === 0) return consentError(reqToken, 'Your account holds none of the requested permissions');

  const code = randomBase64url(32);
  await prisma.oauthAuthorizationCode.create({
    data: {
      codeHash: sha256Hex(code),
      clientId: claims.client_db_id,
      userId: user.id,
      redirectUri: claims.redirect_uri,
      scopes,
      codeChallenge: claims.code_challenge,
      codeChallengeMethod: 'S256',
      expiresAt: new Date(Date.now() + CODE_TTL_SECONDS * 1000),
    },
  });

  if (remember) {
    const grantExpiresAt = new Date(Date.now() + CONSENT_GRANT_TTL_DAYS * 24 * 60 * 60 * 1000);
    await prisma.oauthConsentGrant.upsert({
      where: { userId_clientId: { userId: user.id, clientId: claims.client_db_id } },
      update: { scopes, expiresAt: grantExpiresAt, revokedAt: null },
      create: { userId: user.id, clientId: claims.client_db_id, scopes, expiresAt: grantExpiresAt },
    });
  }

  await prisma.oauthClient.update({
    where: { id: claims.client_db_id },
    data: { lastUsedAt: new Date() },
  });

  const url = new URL(claims.redirect_uri);
  url.searchParams.set('code', code);
  if (claims.state) url.searchParams.set('state', claims.state);
  return NextResponse.redirect(url.toString(), { status: 302 });
}

function consentError(reqToken: string | null, message: string) {
  const url = new URL(`${getIssuer()}/oauth/consent`);
  if (reqToken) url.searchParams.set('req', reqToken);
  url.searchParams.set('error', message);
  return NextResponse.redirect(url.toString(), { status: 302 });
}
