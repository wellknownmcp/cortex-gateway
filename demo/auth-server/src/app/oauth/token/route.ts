/**
 * POST /oauth/token — OAuth 2.1 token endpoint.
 *
 * Grants: authorization_code (code + PKCE verifier → token pair) and
 * refresh_token (strict rotation with theft detection).
 * Body: application/x-www-form-urlencoded (RFC 6749 §4.1.3).
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { checkRateLimit, getClientIp, truncateIp } from '@/lib/rate-limit';
import { getClientByPublicId } from '@/lib/oauth/client';
import { sha256Hex, verifyPkceS256 } from '@/lib/oauth/crypto';
import { parseScopeString } from '@/lib/oauth/scopes';
import { issueTokenPair, rotateRefreshToken } from '@/lib/oauth/tokens';

export async function POST(request: NextRequest) {
  const rl = checkRateLimit('oauth-token', getClientIp(request), 30, 60_000);
  if (!rl.allowed) return tokenError('temporarily_unavailable', 'Rate limit exceeded', 429);

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('application/x-www-form-urlencoded')) {
    return tokenError('invalid_request', 'Content-Type must be application/x-www-form-urlencoded');
  }

  const form = await request.formData();
  const grantType = form.get('grant_type');
  if (grantType === 'authorization_code') return handleAuthorizationCode(form, request);
  if (grantType === 'refresh_token') return handleRefreshToken(form);
  return tokenError('unsupported_grant_type', `grant_type "${grantType}" not supported`);
}

async function handleAuthorizationCode(form: FormData, request: NextRequest) {
  const code = form.get('code');
  const redirectUri = form.get('redirect_uri');
  const clientIdParam = form.get('client_id');
  const codeVerifier = form.get('code_verifier');

  if (typeof code !== 'string' || !code) return tokenError('invalid_request', 'Missing code');
  if (typeof redirectUri !== 'string' || !redirectUri) return tokenError('invalid_request', 'Missing redirect_uri');
  if (typeof clientIdParam !== 'string' || !clientIdParam) return tokenError('invalid_request', 'Missing client_id');
  if (typeof codeVerifier !== 'string' || !codeVerifier) {
    return tokenError('invalid_request', 'Missing code_verifier (PKCE mandatory)');
  }

  const client = await getClientByPublicId(clientIdParam);
  if (!client) return tokenError('invalid_client', 'Unknown or disabled client');

  const authCode = await prisma.oauthAuthorizationCode.findUnique({
    where: { codeHash: sha256Hex(code) },
  });
  if (!authCode) return tokenError('invalid_grant', 'Authorization code not found');
  if (authCode.usedAt) return tokenError('invalid_grant', 'Authorization code already used');
  if (authCode.expiresAt < new Date()) return tokenError('invalid_grant', 'Authorization code expired');
  if (authCode.clientId !== client.id) {
    return tokenError('invalid_grant', 'Authorization code was issued to a different client');
  }
  if (authCode.redirectUri !== redirectUri) {
    return tokenError('invalid_grant', 'redirect_uri does not match authorization request');
  }
  if (!verifyPkceS256(codeVerifier, authCode.codeChallenge)) {
    return tokenError('invalid_grant', 'PKCE verification failed');
  }

  const user = await prisma.user.findUnique({
    where: { id: authCode.userId },
    select: { id: true, email: true },
  });
  if (!user) return tokenError('invalid_grant', 'User no longer exists');

  // Single-use enforcement
  await prisma.oauthAuthorizationCode.update({
    where: { id: authCode.id },
    data: { usedAt: new Date() },
  });

  const issued = await issueTokenPair({
    clientDbId: client.id,
    clientPublicId: client.clientId,
    userId: user.id,
    userEmail: user.email,
    scopes: authCode.scopes,
    ipAddress: truncateIp(getClientIp(request)),
    userAgent: request.headers.get('user-agent'),
  });

  return NextResponse.json(
    {
      access_token: issued.accessToken,
      token_type: 'Bearer',
      expires_in: issued.expiresIn,
      refresh_token: issued.refreshToken,
      scope: authCode.scopes.join(' '),
    },
    { status: 200, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } },
  );
}

async function handleRefreshToken(form: FormData) {
  const refreshToken = form.get('refresh_token');
  const clientIdParam = form.get('client_id');
  const scopeParam = form.get('scope');

  if (typeof refreshToken !== 'string' || !refreshToken) {
    return tokenError('invalid_request', 'Missing refresh_token');
  }
  if (typeof clientIdParam !== 'string' || !clientIdParam) {
    return tokenError('invalid_request', 'Missing client_id');
  }
  const client = await getClientByPublicId(clientIdParam);
  if (!client) return tokenError('invalid_client', 'Unknown or disabled client');

  const requestedScopes = typeof scopeParam === 'string' ? parseScopeString(scopeParam) : undefined;

  try {
    const issued = await rotateRefreshToken(refreshToken, requestedScopes);
    if (!issued) return tokenError('invalid_grant', 'Refresh token invalid, expired, or revoked');
    return NextResponse.json(
      {
        access_token: issued.accessToken,
        token_type: 'Bearer',
        expires_in: issued.expiresIn,
        refresh_token: issued.refreshToken,
      },
      { status: 200, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } },
    );
  } catch (e) {
    if (e instanceof Error && e.message === 'THEFT_DETECTED') {
      return tokenError('invalid_grant', 'Refresh token reuse detected; all tokens revoked');
    }
    throw e;
  }
}

function tokenError(error: string, description: string, status = 400) {
  return NextResponse.json(
    { error, error_description: description },
    { status, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } },
  );
}
