/**
 * MCP→backend proxy adapter — backend contract endpoint.
 *
 * `POST /api/mcp-adapter/<server>/backend` makes a downstream native MCP
 * server look like an ordinary Cortex backend. Federate it with a loopback
 * entry:
 *
 *   CORTEX_BACKENDS=...,canva
 *   CORTEX_BACKEND_CANVA_URL=http://127.0.0.1:3213
 *   CORTEX_BACKEND_CANVA_PATH=/api/mcp-adapter/canva/backend
 *
 * Auth (same two-tier model as any backend):
 * - static technical token → catalog methods only. list_tools uses the
 *   downstream token of CORTEX_MCP_<ID>_CATALOG_SUB when the downstream MCP
 *   requires auth to list tools (most do).
 * - user OAuth JWT → tool invocations, resolved through the token vault
 *   (per-user downstream tokens). Unlinked account → 403 without `required`
 *   (ACL shape), telling the user to visit the linking flow.
 */

import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { validateRequest } from '@/lib/oauth-validator';
import { isStaticTokenMethodAllowed } from '@/contract';
import { getMcpServer } from '@/adapter/config';
import { getValidToken, isLinked } from '@/adapter/vault';
import { bridgeListTools, bridgeCallTool, BridgeToolError } from '@/adapter/backend-bridge';
import { McpDownstreamUnauthorized, McpDownstreamError } from '@/adapter/mcp-client';

function isStaticToken(bearer: string | null): boolean {
  const expected = process.env.CORTEX_TECHNICAL_TOKEN ?? '';
  if (!bearer || !expected) return false;
  const a = Buffer.from(bearer);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(status: number, body: unknown): NextResponse {
  return NextResponse.json(body as Record<string, unknown>, { status });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ server: string }> },
): Promise<NextResponse> {
  const { server: serverId } = await ctx.params;
  const server = getMcpServer(serverId);
  if (!server) {
    return json(404, { error: `Unknown proxied MCP server: ${serverId}` });
  }

  let body: { method?: string; params?: Record<string, unknown> };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }
  const method = body.method ?? '';
  if (!method) return json(400, { error: 'method required' });

  const authHeader = req.headers.get('authorization');
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  // ── Tier 1: static technical token → catalog methods only ──────────────
  if (isStaticToken(bearer)) {
    if (!isStaticTokenMethodAllowed(method)) {
      return json(403, { error: 'Static token is restricted to catalog methods' });
    }
    if (method === 'list_prompts') return json(200, { prompts: [] });
    if (method === 'list_resource_templates') return json(200, { resourceTemplates: [] });
    if (method === 'get_snapshot') {
      return json(200, {
        backend: server.id,
        generatedAt: new Date().toISOString(),
        title: `Proxied MCP — ${server.id}`,
        headline: [],
      });
    }
    // list_tools — needs a downstream token when the MCP requires auth
    try {
      const catalogToken = server.catalogSub
        ? await getValidToken(server.catalogSub, server)
        : null;
      const result = await bridgeListTools(server, catalogToken ?? '');
      return json(200, result);
    } catch (err) {
      if (err instanceof McpDownstreamUnauthorized) {
        return json(502, {
          error: `Downstream MCP ${server.id} requires auth for tools/list — link an account and set CORTEX_MCP_${server.id.toUpperCase()}_CATALOG_SUB`,
        });
      }
      return json(502, { error: err instanceof Error ? err.message : 'Downstream discovery failed' });
    }
  }

  // ── Tier 2: user OAuth JWT → data methods ───────────────────────────────
  const auth = await validateRequest(req);
  if (!auth.ok) {
    return json(auth.status, { error: auth.error });
  }
  const sub = auth.context.sub;

  if (method === 'whoami') {
    const linked = await isLinked(sub, server.id).catch(() => false);
    return json(200, {
      provider: server.id,
      linked,
      ...(linked ? {} : { linkUrl: `/api/link/${server.id}/start` }),
    });
  }
  if (method === 'list_prompts') return json(200, { prompts: [] });
  if (method === 'list_resource_templates') return json(200, { resourceTemplates: [] });
  if (method === 'list_tools') {
    try {
      const token = await getValidToken(sub, server);
      if (!token) return json(403, { error: `Account not linked to ${server.id} — visit /api/link/${server.id}/start` });
      return json(200, await bridgeListTools(server, token));
    } catch (err) {
      return json(502, { error: err instanceof Error ? err.message : 'Downstream discovery failed' });
    }
  }

  // Any other method = a downstream tool invocation.
  let token: string | null;
  try {
    token = await getValidToken(sub, server);
  } catch (err) {
    // Refresh failed → ACL-shaped 403 (no `required`): the gateway surfaces
    // the reason verbatim to the agent.
    return json(403, { error: err instanceof Error ? err.message : 'Downstream token refresh failed' });
  }
  if (!token) {
    return json(403, {
      error: `Your account is not linked to ${server.id}. Open /api/link/${server.id}/start (authenticated) to connect it, then retry.`,
    });
  }

  try {
    const result = await bridgeCallTool(server, token, method, body.params ?? {});
    return json(200, result as Record<string, unknown>);
  } catch (err) {
    if (err instanceof McpDownstreamUnauthorized) {
      return json(403, { error: `Downstream ${server.id} rejected the token — re-link your account via /api/link/${server.id}/start` });
    }
    if (err instanceof BridgeToolError) {
      return json(400, { error: err.message });
    }
    if (err instanceof McpDownstreamError) {
      return json(502, { error: err.message });
    }
    return json(500, { error: err instanceof Error ? err.message : 'Adapter error' });
  }
}
