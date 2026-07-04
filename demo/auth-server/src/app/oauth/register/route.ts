/**
 * POST /oauth/register — RFC 7591 Dynamic Client Registration.
 *
 * Public endpoint: any MCP client (Claude Desktop, claude.ai, Cursor) can
 * self-register. Rate limited to 5/h/IP. Public clients only (PKCE, no
 * secret). Open auto-approval is a deliberate demo-server deviation — see
 * lib/oauth/client.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';
import { validateDcrPayload, createDcrClient } from '@/lib/oauth/client';

export async function POST(request: NextRequest) {
  const rl = checkRateLimit('oauth-register', getClientIp(request), 5, 60 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'too_many_requests', error_description: 'Registration rate limit exceeded' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid_client_metadata', error_description: 'Request body must be valid JSON' },
      { status: 400 },
    );
  }

  const validated = validateDcrPayload(body as Record<string, unknown>);
  if ('error' in validated) {
    return NextResponse.json(validated, { status: 400 });
  }

  const client = await createDcrClient(validated);

  return NextResponse.json(
    {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      client_name: client.clientName,
      client_uri: client.clientUri,
      logo_uri: client.logoUri,
      redirect_uris: client.redirectUris,
      grant_types: client.grantTypes,
      response_types: client.responseTypes,
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      scope: client.scopesAllowed.join(' '),
    },
    { status: 201 },
  );
}
