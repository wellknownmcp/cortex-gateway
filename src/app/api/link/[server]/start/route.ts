/**
 * Linking flow — step 1: redirect the user to the downstream provider's
 * consent screen.
 *
 * `GET /api/link/<server>/start` — authenticated with the user's Cortex JWT
 * (Authorization header, or `?token=` for browser navigation since browsers
 * cannot set headers on a redirect chain).
 *
 * The OAuth `state` is self-contained: an AES-GCM-sealed blob carrying
 * {sub, provider, PKCE verifier, expiry}. No server-side state to store,
 * tamper-proof by construction (GCM auth tag).
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateRequest } from '@/lib/oauth-validator';
import { getMcpServer } from '@/adapter/config';
import { ensureClient, linkRedirectUri, pkcePair } from '@/adapter/oauth-discovery';
import { sealJson } from '@/adapter/crypto';

export interface LinkState {
  sub: string;
  provider: string;
  verifier: string;
  exp: number;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ server: string }> },
): Promise<NextResponse> {
  const { server: serverId } = await ctx.params;
  const server = getMcpServer(serverId);
  if (!server) {
    return NextResponse.json({ error: `Unknown proxied MCP server: ${serverId}` }, { status: 404 });
  }

  // Accept the JWT from the Authorization header or from ?token= (browser flow)
  const queryToken = req.nextUrl.searchParams.get('token');
  const authedReq = queryToken
    ? new Request(req.url, { headers: { ...Object.fromEntries(req.headers), authorization: `Bearer ${queryToken}` } })
    : req;
  const auth = await validateRequest(authedReq);
  if (!auth.ok) {
    return NextResponse.json(
      { error: 'Authenticate with your Cortex token (Authorization header or ?token=)' },
      { status: auth.status },
    );
  }

  let client;
  try {
    client = await ensureClient(server);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'OAuth discovery failed' },
      { status: 502 },
    );
  }

  const { verifier, challenge } = pkcePair();
  const state = sealJson({
    sub: auth.context.sub,
    provider: server.id,
    verifier,
    exp: Date.now() + 10 * 60 * 1000,
  } satisfies LinkState);

  const authorize = new URL(client.authorizationEndpoint);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', client.clientId);
  authorize.searchParams.set('redirect_uri', linkRedirectUri(server.id));
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('state', state);
  // RFC 8707: bind the requested token to the downstream MCP resource.
  authorize.searchParams.set('resource', server.url);
  if (server.oauthScope) authorize.searchParams.set('scope', server.oauthScope);

  return NextResponse.redirect(authorize.toString(), 302);
}
