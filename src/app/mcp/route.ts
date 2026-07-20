/**
 * MCP endpoint — `/mcp`.
 *
 * Spec: Model Context Protocol 2025-06-18 (Streamable HTTP transport).
 *
 * - POST   : JSON-RPC (initialize, tools/list, tools/call, resources/*, prompts/*, ping)
 * - GET    : SSE stream — pushes unsolicited JSON-RPC notifications
 *            (notifications/tools/list_changed, resources/list_changed...)
 *            The client must send `Accept: text/event-stream`.
 * - DELETE : terminates an Mcp-Session-Id session
 * - OPTIONS: CORS preflight
 *
 * Auth: OAuth 2.1 Bearer JWT issued by your authorization server.
 * 401 responses carry a WWW-Authenticate header pointing at
 * .well-known/oauth-protected-resource (RFC 9728).
 *
 * Security isolation: Origin check (anti DNS-rebinding), MCP-Protocol-Version
 * check, optional pool sandbox (CORTEX_REQUIRED_POOL).
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';
import { validateRequest, buildWwwAuthenticate } from '@/lib/oauth-validator';
import { isOriginAllowed } from '@/lib/origins';
import { createSession, terminateSession, validateSession } from '@/lib/sessions';
import { handleMethod, BUILTIN_TOOL_NAMES, type JsonRpcResponse } from '@/lib/mcp-methods';
import { logAudit, hashEmail, hashParams } from '@/lib/audit-log';
import { startPeriodicRefresh, lookupTool, findBackendForUri } from '@/lib/federator';
import { subscribe as subscribeEvents } from '@/lib/event-bus';

// Boot: start the periodic refresh of the federated catalog
startPeriodicRefresh();

const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-03-26']);
const DEFAULT_PROTOCOL_VERSION = '2025-03-26'; // fallback when the header is absent (spec §Protocol Version)

const CORS_BASE = {
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Accept, X-Dev-Mode, X-Cortex-Backends, X-Cortex-Tool-Mode',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
};

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    ...CORS_BASE,
    'Access-Control-Allow-Origin': origin ?? '*',
    Vary: 'Origin',
  };
}

// ─── OPTIONS (CORS preflight) ─────────────────────────────────────────────

export async function OPTIONS(req: NextRequest): Promise<NextResponse> {
  const origin = req.headers.get('origin');
  if (!isOriginAllowed(req)) {
    return new NextResponse(null, { status: 403 });
  }
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

// ─── GET (spec §Listening) ────────────────────────────────────────────────
// SSE stream pushing unsolicited JSON-RPC notifications.
// MCP spec 2025-06-18: the server MUST accept GET with
// `Accept: text/event-stream` for capabilities that emit listChanged.

const KEEPALIVE_INTERVAL_MS = 30_000;

export async function GET(req: NextRequest): Promise<Response> {
  const origin = req.headers.get('origin');

  if (!isOriginAllowed(req)) {
    return new NextResponse(null, { status: 403, headers: corsHeaders(origin) });
  }

  // The client must explicitly ask for text/event-stream (spec)
  const accept = req.headers.get('accept') ?? '';
  if (!accept.includes('text/event-stream')) {
    return new NextResponse(null, {
      status: 405,
      headers: { ...corsHeaders(origin), Allow: 'POST, GET, DELETE, OPTIONS' },
    });
  }

  // OAuth (same flow as POST)
  const auth = await validateRequest(req);
  if (!auth.ok) {
    const headers = { ...corsHeaders(origin) } as Record<string, string>;
    if (auth.wwwAuthenticate) headers['WWW-Authenticate'] = auth.wwwAuthenticate;
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let eventId = 0;
      let closed = false;

      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      // Initial comment to force header flush on the client side
      safeEnqueue(`: cortex mcp sse ${new Date().toISOString()}\n\n`);

      // Subscribe to the event bus
      const unsubscribe = subscribeEvents((event) => {
        eventId += 1;
        const payload = JSON.stringify({ jsonrpc: '2.0', method: event.method, params: event.params });
        safeEnqueue(`id: ${eventId}\nevent: message\ndata: ${payload}\n\n`);
      });

      // Keep-alive comment every 30s — avoids proxy timeouts
      const keepalive = setInterval(() => {
        safeEnqueue(`: keepalive ${Date.now()}\n\n`);
      }, KEEPALIVE_INTERVAL_MS);

      // Cleanup on client disconnect
      const abort = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      req.signal.addEventListener('abort', abort);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...corsHeaders(origin),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering (when present)
    },
  });
}

// ─── DELETE (terminate session) ───────────────────────────────────────────

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const origin = req.headers.get('origin');
  if (!isOriginAllowed(req)) {
    return new NextResponse(null, { status: 403 });
  }
  // Auth is mandatory: without a valid JWT, anyone knowing an Mcp-Session-Id
  // could terminate someone else's session.
  const auth = await validateRequest(req);
  if (!auth.ok) {
    const headers = { ...corsHeaders(origin) } as Record<string, string>;
    if (auth.wwwAuthenticate) headers['WWW-Authenticate'] = auth.wwwAuthenticate;
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers });
  }
  const sessionId = req.headers.get('mcp-session-id');
  const session = validateSession(sessionId);
  if (session && session.sub !== auth.context.sub) {
    // Someone else's session: 404 (not 403) so we do not confirm the
    // existence of a third-party session.
    return new NextResponse(null, { status: 404, headers: corsHeaders(origin) });
  }
  terminateSession(sessionId);
  return new NextResponse(null, { status: 202, headers: corsHeaders(origin) });
}

// ─── POST (main JSON-RPC) ─────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  const startTs = Date.now();
  const origin = req.headers.get('origin');

  // 1. Origin (anti DNS-rebinding)
  if (!isOriginAllowed(req)) {
    return NextResponse.json({ error: 'forbidden_origin' }, { status: 403, headers: corsHeaders(origin) });
  }

  // 2. Protocol version
  const protocolVersion = req.headers.get('mcp-protocol-version') ?? DEFAULT_PROTOCOL_VERSION;
  if (!SUPPORTED_PROTOCOL_VERSIONS.has(protocolVersion)) {
    return NextResponse.json(
      { error: 'unsupported_protocol_version', supported: Array.from(SUPPORTED_PROTOCOL_VERSIONS) },
      { status: 400, headers: corsHeaders(origin) },
    );
  }

  // 3. Auth
  const auth = await validateRequest(req);
  if (!auth.ok) {
    const headers = { ...corsHeaders(origin) } as Record<string, string>;
    if (auth.wwwAuthenticate) headers['WWW-Authenticate'] = auth.wwwAuthenticate;
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers });
  }
  const userCtx = auth.context;

  // 3bis. Rate limit per jti (unique per token) with IP fallback.
  // Default 200 req/min: interactive MCP clients typically issue 5-10 calls
  // per user action, so 200/min leaves ample headroom for normal usage while
  // stopping an agent stuck in a loop (50-100 req/s) after ~2s.
  // Dev bypass exempted: useful for local test scripts.
  if (!userCtx.isDevBypass) {
    const maxPerMinute = Number.parseInt(process.env.CORTEX_RATE_LIMIT_PER_MINUTE ?? '200', 10);
    const rlKey = userCtx.jti ?? getClientIp(req);
    const rl = checkRateLimit('mcp-request', rlKey, maxPerMinute, 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Rate limit exceeded' } },
        {
          status: 429,
          headers: {
            ...corsHeaders(origin),
            'Retry-After': String(Math.ceil((rl.retryAfterMs ?? 60_000) / 1000)),
          },
        },
      );
    }
  }

  // 4. Optional pool sandbox: when CORTEX_REQUIRED_POOL is set, only tokens
  // carrying that `pool` claim are accepted. Useful when your authorization
  // server segments user populations and this gateway serves only one.
  const requiredPool = process.env.CORTEX_REQUIRED_POOL;
  if (requiredPool && userCtx.pool && userCtx.pool !== requiredPool && !userCtx.isDevBypass) {
    return NextResponse.json(
      { error: 'invalid_audience', detail: `This gateway requires pool=${requiredPool}` },
      { status: 403, headers: { ...corsHeaders(origin), 'WWW-Authenticate': buildWwwAuthenticate() } },
    );
  }

  // 5. Parse the JSON-RPC body
  let body: { method?: string; params?: unknown; id?: string | number | null; jsonrpc?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { status: 400, headers: corsHeaders(origin) },
    );
  }
  const id = body.id ?? null;

  // Notifications (method without id) → 202 no-body (spec §Sending Messages)
  const isNotification = body.id === undefined || body.id === null;
  if (isNotification && body.method === 'notifications/initialized') {
    return new NextResponse(null, { status: 202, headers: corsHeaders(origin) });
  }
  if (isNotification) {
    // Other notifications (cancelled, etc.): silent 202
    return new NextResponse(null, { status: 202, headers: corsHeaders(origin) });
  }

  if (!body.method) {
    return NextResponse.json(
      { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid request: method required' } },
      { status: 400, headers: corsHeaders(origin) },
    );
  }

  // 6. Session
  const sessionHeader = req.headers.get('mcp-session-id');
  const isInitialize = body.method === 'initialize';

  if (!isInitialize && sessionHeader) {
    // Spec: non-initialize methods with an invalid session id → 404.
    // A valid session belonging to another sub is treated as invalid: the
    // session carries no rights, but the isolation avoids audit pollution
    // and cross-caller id sharing.
    const session = validateSession(sessionHeader);
    if (!session || session.sub !== userCtx.sub) {
      return NextResponse.json(
        { jsonrpc: '2.0', id, error: { code: -32001, message: 'Invalid or expired session' } },
        { status: 404, headers: corsHeaders(origin) },
      );
    }
  }

  // 7. Dispatch
  //
  // `X-Cortex-Backends` header: when present, filters `tools/list` down to
  // the listed backends (CSV: "docs,billing"). Gateway builtins always stay
  // visible. Empty string = explicitly no federated backend — useful to
  // discover the builtins without federation noise. Absent = no filter.
  //
  // NOT a security boundary. It shapes what the agent is shown, not what the
  // token may call: a caller that sends `X-Cortex-Backends: docs` can still
  // invoke `billing_*` if its scopes allow. Authorization lives in the
  // per-tool scope check in handleToolsCall — deliberately, so that trimming
  // context can never be mistaken for revoking access.
  const backendsHeader = req.headers.get('x-cortex-backends');
  const backendsFilter: ReadonlySet<string> | undefined =
    backendsHeader === null
      ? undefined
      : new Set(
          backendsHeader
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter((s) => s.length > 0),
        );

  // Compact `tools/list` mode (Tool Search Tool pattern, see docs/tool-search-mode.md).
  // 'search' = compact tools/list (names + 1-line descs) + a find_tools(query|names)
  //            builtin returning full schemas on demand. ~80% smaller payload.
  // 'normal' (default) = full schemas in tools/list. Maximum client compatibility.
  const toolModeHeader = req.headers.get('x-cortex-tool-mode')?.toLowerCase();
  const toolMode: 'normal' | 'search' = toolModeHeader === 'search' ? 'search' : 'normal';

  let rpcRes: JsonRpcResponse;
  try {
    rpcRes = await handleMethod({
      method: body.method,
      params: body.params,
      id,
      userCtx,
      backendsFilter,
      toolMode,
    });
  } catch (err) {
    rpcRes = {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: err instanceof Error ? err.message : 'Internal error',
      },
    };
  }

  // 8. Response headers (new session id on initialize)
  const responseHeaders: Record<string, string> = {
    ...corsHeaders(origin),
    'Content-Type': 'application/json',
  };
  if (isInitialize && 'result' in rpcRes) {
    const sessionId = createSession({
      sub: userCtx.sub,
      clientId: userCtx.clientId,
      protocolVersion,
    });
    responseHeaders['Mcp-Session-Id'] = sessionId;
  }

  // 9. Audit log
  const success = 'result' in rpcRes;
  const errorCode = !success && 'error' in rpcRes ? String(rpcRes.error.code) : null;
  const toolName = body.method === 'tools/call' && typeof body.params === 'object' && body.params !== null
    ? (body.params as { name?: string }).name ?? null
    : null;

  const responseSize = JSON.stringify(rpcRes).length;

  // Which backend actually served the call, and under which scope. Resolved
  // from the federated catalog rather than threaded through the dispatch, so
  // the audit trail answers "who reached what" without an extra plumbing
  // layer. `gateway` marks the builtins — they federate to no backend.
  const { targetApp, scopeUsed } = resolveAuditTarget(body.method, toolName, body.params);

  // tools/list metrics — computed only for that method and when the call
  // succeeded. The chars/4 token estimate is a standard approximation
  // (~±10%), enough to steer optimizations (backend filtering, compact
  // descriptions, search mode).
  let toolsListed: number | undefined;
  let tokensEstimate: number | undefined;
  let backendsFilterLog: string[] | null | undefined;
  if (body.method === 'tools/list' && success && 'result' in rpcRes) {
    const result = rpcRes.result as { tools?: unknown[] } | null;
    toolsListed = Array.isArray(result?.tools) ? result.tools.length : 0;
    tokensEstimate = Math.ceil(responseSize / 4);
    backendsFilterLog = backendsFilter ? Array.from(backendsFilter) : null;
  }

  logAudit({
    ts: new Date().toISOString(),
    caller_sub: userCtx.sub,
    caller_email_hash: hashEmail(userCtx.email),
    caller_role: userCtx.role,
    caller_pool: userCtx.pool,
    tool: toolName,
    method: body.method,
    target_app: targetApp,
    scope_used: scopeUsed,
    params_hash: hashParams(body.params),
    response_size: responseSize,
    latency_ms: Date.now() - startTs,
    success,
    error_code: errorCode,
    protocol_version: protocolVersion,
    origin,
    client_id: userCtx.clientId,
    session_id: sessionHeader,
    dev_bypass: userCtx.isDevBypass,
    ...(toolsListed !== undefined && { tools_listed: toolsListed }),
    ...(tokensEstimate !== undefined && { tokens_estimate: tokensEstimate }),
    ...(backendsFilterLog !== undefined && { backends_filter: backendsFilterLog }),
    ...(body.method === 'tools/list' && { tool_mode: toolMode }),
  });

  return new NextResponse(JSON.stringify(rpcRes), { status: 200, headers: responseHeaders });
}

/**
 * Resolves the backend that a call was routed to, plus the scope that gated
 * it, for the audit trail.
 *
 * Two data-bearing paths are attributed:
 *  - `tools/call`     via the federated catalog (`<app>_<tool>` → app + scope)
 *  - `resources/read` via the URI scheme → owning backend
 *
 * `gateway` means a builtin: served in-process, federating to nothing. `null`
 * means the method reaches no backend (initialize, tools/list...) or the tool
 * was unknown — in which case the call failed anyway.
 */
function resolveAuditTarget(
  method: string,
  toolName: string | null,
  params: unknown,
): { targetApp: string | null; scopeUsed: string | null } {
  if (method === 'tools/call' && toolName) {
    if (BUILTIN_TOOL_NAMES.has(toolName)) {
      return { targetApp: 'gateway', scopeUsed: null };
    }
    const entry = lookupTool(toolName);
    return entry
      ? { targetApp: entry.app.id, scopeUsed: entry.tool.scope }
      : { targetApp: null, scopeUsed: null };
  }

  if (method === 'resources/read' && typeof params === 'object' && params !== null) {
    const uri = (params as { uri?: unknown }).uri;
    if (typeof uri === 'string') {
      const app = findBackendForUri(uri);
      if (app) return { targetApp: app.id, scopeUsed: null };
    }
  }

  return { targetApp: null, scopeUsed: null };
}
