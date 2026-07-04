/**
 * Protected Resource Metadata — RFC 9728.
 *
 * Consumed by MCP clients to discover the Authorization Server associated
 * with this resource and the available scopes.
 *
 * `scopes_supported` is derived from the federated catalog at runtime:
 * adding a tool / prompt / template with a new scope in a backend makes that
 * scope appear here automatically (no gateway change). On a cold boot the
 * catalog may be empty; discovery then simply returns no scopes until the
 * first refresh completes.
 */

import { NextResponse } from 'next/server';
import { getCatalog, listPrompts, listResourceTemplates } from '@/lib/federator';
import { canonicalUri } from '@/lib/oauth-validator';

function collectScopes(): string[] {
  const set = new Set<string>();
  for (const { tool } of getCatalog().tools.values()) {
    if (tool.scope) set.add(tool.scope);
  }
  for (const e of listPrompts()) {
    if (e.prompt.scope) set.add(e.prompt.scope);
  }
  for (const e of listResourceTemplates()) {
    if (e.template.scope) set.add(e.template.scope);
  }
  return Array.from(set).sort();
}

export async function GET(): Promise<NextResponse> {
  const issuer = process.env.OAUTH_ISSUER;
  return NextResponse.json(
    {
      resource: canonicalUri(),
      authorization_servers: issuer ? [issuer] : [],
      bearer_methods_supported: ['header'],
      scopes_supported: collectScopes(),
      resource_documentation: 'https://github.com/wellknownmcp/cortex-gateway',
    },
    {
      headers: {
        // Short cache: the federated catalog can change within minutes
        // (backend deploy, new tool). 60s absorbs discovery bursts without
        // lagging behind the internal refresh (60s as well).
        'Cache-Control': 'public, max-age=60',
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
