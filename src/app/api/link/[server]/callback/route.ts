/**
 * Linking flow — step 2: OAuth callback from the downstream provider.
 *
 * Exchanges the authorization code (PKCE) at the provider's token endpoint
 * and stores the grant, encrypted, in the token vault keyed by the Cortex
 * user's sub. From here on the adapter silently refreshes — the user never
 * sees this provider's consent screen again.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getMcpServer } from '@/adapter/config';
import { ensureClient, linkRedirectUri, tokenRequest } from '@/adapter/oauth-discovery';
import { openJson } from '@/adapter/crypto';
import { storeGrant } from '@/adapter/vault';
import type { LinkState } from '../start/route';

function page(status: number, title: string, detail: string): NextResponse {
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui,sans-serif;max-width:560px;margin:80px auto;padding:0 24px">
<h1 style="font-size:22px">${title}</h1><p style="color:#555">${detail}</p></body>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ server: string }> },
): Promise<NextResponse> {
  const { server: serverId } = await ctx.params;
  const server = getMcpServer(serverId);
  if (!server) return page(404, 'Unknown provider', `No proxied MCP server named "${serverId}".`);

  const code = req.nextUrl.searchParams.get('code');
  const stateRaw = req.nextUrl.searchParams.get('state');
  const providerError = req.nextUrl.searchParams.get('error');
  if (providerError) {
    return page(400, 'Linking refused', `The provider returned: ${providerError}.`);
  }
  if (!code || !stateRaw) {
    return page(400, 'Invalid callback', 'Missing code or state parameter.');
  }

  let state: LinkState;
  try {
    state = openJson<LinkState>(stateRaw);
  } catch {
    return page(400, 'Invalid state', 'The state blob could not be verified.');
  }
  if (state.provider !== server.id || state.exp < Date.now()) {
    return page(400, 'Expired state', 'Restart the linking flow.');
  }

  try {
    const client = await ensureClient(server);
    const grant = await tokenRequest(client, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: linkRedirectUri(server.id),
      code_verifier: state.verifier,
    });
    await storeGrant(state.sub, server.id, client.tokenEndpoint, grant);
  } catch (err) {
    return page(502, 'Linking failed', err instanceof Error ? err.message : 'Token exchange failed.');
  }

  return page(
    200,
    `${server.id} linked ✓`,
    'You can close this tab. Agents connected to the gateway now reach this provider with your account.',
  );
}
