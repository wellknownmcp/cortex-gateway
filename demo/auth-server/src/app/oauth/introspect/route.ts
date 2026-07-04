/**
 * POST /oauth/introspect — RFC 7662 token introspection.
 *
 * Consulted by the gateway (OAUTH_INTROSPECT_URL) to detect revocation before
 * a token's natural expiry. Requires confidential-client Basic auth: the
 * introspect client is configured via env (INTROSPECT_CLIENT_ID /
 * INTROSPECT_CLIENT_SECRET) — it is the gateway's service credential, not a
 * DCR client.
 *
 * Secret comparison is timing-safe (never `!==` on secrets).
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';
import { safeCompare } from '@/lib/oauth/crypto';
import { verifyAccessToken } from '@/lib/oauth/tokens';

function checkBasicAuth(request: NextRequest): boolean {
  const expectedId = process.env.INTROSPECT_CLIENT_ID;
  const expectedSecret = process.env.INTROSPECT_CLIENT_SECRET;
  if (!expectedId || !expectedSecret) return false;

  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Basic ')) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const sep = decoded.indexOf(':');
  if (sep === -1) return false;
  const id = decoded.slice(0, sep);
  const secret = decoded.slice(sep + 1);
  return safeCompare(id, expectedId) && safeCompare(secret, expectedSecret);
}

export async function POST(request: NextRequest) {
  const rl = checkRateLimit('oauth-introspect', getClientIp(request), 120, 60_000);
  if (!rl.allowed) return NextResponse.json({ active: false }, { status: 429 });

  if (!checkBasicAuth(request)) {
    return NextResponse.json(
      { error: 'invalid_client', error_description: 'Basic client authentication required' },
      { status: 401 },
    );
  }

  const form = await request.formData();
  const token = form.get('token');
  if (typeof token !== 'string' || !token) {
    return NextResponse.json({ active: false });
  }

  const claims = await verifyAccessToken(token);
  if (!claims) return NextResponse.json({ active: false });

  return NextResponse.json({
    active: true,
    sub: claims.sub,
    client_id: claims.client_id,
    scope: claims.scope,
    exp: claims.exp,
    iat: claims.iat,
    aud: claims.aud,
    iss: claims.iss,
    token_type: 'Bearer',
  });
}
