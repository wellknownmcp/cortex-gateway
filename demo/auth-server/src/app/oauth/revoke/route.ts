/**
 * POST /oauth/revoke — RFC 7009 token revocation.
 *
 * RFC 7009 §2.1 mandates client authentication: without it, anyone who knows
 * a token value can revoke it (DoS on legitimate sessions). Public clients
 * authenticate by client_id + ownership check — revocation only touches
 * tokens issued to THAT client.
 *
 * Per RFC §2.2 the endpoint returns 200 even when the token is unknown.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';
import { getClientByPublicId } from '@/lib/oauth/client';
import { revokeAccessToken, revokeRefreshToken } from '@/lib/oauth/tokens';

export async function POST(request: NextRequest) {
  const rl = checkRateLimit('oauth-revoke', getClientIp(request), 30, 60_000);
  if (!rl.allowed) {
    return NextResponse.json({ error: 'temporarily_unavailable' }, { status: 429 });
  }

  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('application/x-www-form-urlencoded')) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'Content-Type must be application/x-www-form-urlencoded' },
      { status: 400 },
    );
  }

  const form = await request.formData();
  const token = form.get('token');
  const clientIdParam = form.get('client_id');

  if (typeof token !== 'string' || !token) {
    return NextResponse.json({ error: 'invalid_request', error_description: 'Missing token' }, { status: 400 });
  }
  if (typeof clientIdParam !== 'string' || !clientIdParam) {
    return NextResponse.json(
      { error: 'invalid_client', error_description: 'client_id required' },
      { status: 401 },
    );
  }

  const client = await getClientByPublicId(clientIdParam);
  if (!client) {
    return NextResponse.json({ error: 'invalid_client', error_description: 'Unknown client' }, { status: 401 });
  }

  // Ownership enforced inside: WHERE clientId = client.id. Revoking a token
  // that belongs to another client silently touches zero rows (RFC §2.2).
  await revokeAccessToken(token, client.id);
  await revokeRefreshToken(token, client.id);

  return new NextResponse(null, { status: 200 });
}
