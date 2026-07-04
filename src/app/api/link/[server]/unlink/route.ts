/**
 * Linking flow — revocation: deletes the stored downstream grant.
 *
 * `POST /api/link/<server>/unlink` — authenticated with the user's Cortex JWT.
 * The provider-side authorization (visible in the provider's account
 * settings) should be revoked there by the user; this endpoint removes our
 * copy of the tokens, which is what the adapter uses.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateRequest } from '@/lib/oauth-validator';
import { getMcpServer } from '@/adapter/config';
import { deleteGrant } from '@/adapter/vault';

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ server: string }> },
): Promise<NextResponse> {
  const { server: serverId } = await ctx.params;
  const server = getMcpServer(serverId);
  if (!server) {
    return NextResponse.json({ error: `Unknown proxied MCP server: ${serverId}` }, { status: 404 });
  }

  const auth = await validateRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const deleted = await deleteGrant(auth.context.sub, server.id);
  return NextResponse.json({ provider: server.id, unlinked: deleted });
}
