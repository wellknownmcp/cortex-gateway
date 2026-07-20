/**
 * MCP server card (SEP-2127) — /.well-known/mcp/server-card.json
 *
 * The card an agent reads to learn what this host is before authenticating.
 * A route rather than a static file in public/, because every field worth
 * publishing is deployment-specific: the endpoint URL, the server name, the
 * version. A checked-in file would ship one deployment's identity to every
 * other one.
 *
 * Everything is derived from configuration already required to run:
 * CORTEX_CANONICAL_URI is the endpoint (and its origin, this host),
 * CORTEX_SERVER_NAME the identity used everywhere else in the gateway.
 * Nothing new to configure for the card to be correct.
 *
 * One exception, CORTEX_SERVER_CARD_NAME. The card's `name` is a registry
 * identifier — the one a client uses to match this server against a registry
 * entry (`io.github.owner/repo`) — while CORTEX_SERVER_NAME is the label MCP
 * clients display ("Acme Gateway"). They are usually not the same string, and
 * publishing the display name here makes the card disagree with the registry
 * entry it is supposed to correspond to. Set the card name when the server is
 * published to a registry; otherwise the display name is a reasonable default.
 */

import { NextResponse } from 'next/server';
import { canonicalUri } from '@/lib/oauth-validator';
import { SERVER_VERSION, SERVER_PROTOCOL_VERSION, serverName } from '@/lib/mcp-methods';

export async function GET(): Promise<NextResponse> {
  const endpoint = canonicalUri();

  return NextResponse.json(
    {
      $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
      name: process.env.CORTEX_SERVER_CARD_NAME || serverName(),
      version: SERVER_VERSION,
      description:
        'Federated MCP gateway: one OAuth 2.1-protected MCP server in front of N backend ' +
        'applications. The caller’s identity is propagated to each backend, so every ' +
        'call runs under that user’s own permissions.',
      websiteUrl: process.env.CORTEX_WEBSITE_URL || undefined,
      remotes: [
        {
          type: 'streamable-http',
          url: endpoint,
          // Same constant `initialize` answers with — the card cannot drift
          // from what the endpoint actually negotiates.
          supportedProtocolVersions: [SERVER_PROTOCOL_VERSION],
        },
      ],
    },
    {
      headers: {
        // The card only changes on redeploy — unlike the discovery metadata,
        // which tracks the federated catalog. An hour is safe.
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
      },
    },
  );
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
