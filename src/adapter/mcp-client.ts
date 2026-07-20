/**
 * Minimal MCP client — Streamable HTTP transport (spec 2025-06-18), the
 * downstream half of the MCP→backend proxy adapter.
 *
 * Handles what the backend contract deliberately strips:
 * - `initialize` handshake + protocol version negotiation
 * - `Mcp-Session-Id` capture and propagation (with one automatic
 *   re-initialize on session expiry)
 * - responses served as JSON *or* as an SSE stream (both are legal for the
 *   server per spec)
 *
 * Sessions are cached in-process per (serverUrl, token identity) so a
 * tools/call does not pay the handshake every time.
 */

import { createHash } from 'node:crypto';

const PROTOCOL_VERSION = '2025-06-18';

export class McpDownstreamError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: number,
  ) {
    super(message);
    this.name = 'McpDownstreamError';
  }
}

export class McpDownstreamUnauthorized extends McpDownstreamError {
  constructor() {
    super('Downstream MCP server rejected the token (401)', 401);
    this.name = 'McpDownstreamUnauthorized';
  }
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpSession {
  sessionId: string | null;
  protocolVersion: string;
}

const sessions = new Map<string, McpSession>();

function sessionKey(url: string, token: string): string {
  // Full-token hash: JWTs share their first characters (identical base64
  // header) and often their length, so any prefix/length scheme would let
  // two users collide on the same downstream session entry.
  return createHash('sha256').update(`${url}|${token}`).digest('hex');
}

/** Drops the cached session (used on 404 = session expired). */
function dropSession(url: string, token: string): void {
  sessions.delete(sessionKey(url, token));
}

let rpcCounter = 0;

async function rawRpc(
  url: string,
  token: string,
  body: Record<string, unknown>,
  session: McpSession | null,
  timeoutMs: number,
): Promise<{ status: number; rpc: JsonRpcResponse | null; sessionId: string | null }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`,
  };
  if (session) {
    headers['MCP-Protocol-Version'] = session.protocolVersion;
    if (session.sessionId) headers['Mcp-Session-Id'] = session.sessionId;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new McpDownstreamError(`Downstream MCP timed out after ${timeoutMs}ms`, 0);
    }
    throw err;
  }

  const newSessionId = res.headers.get('mcp-session-id');
  const contentType = res.headers.get('content-type') ?? '';

  try {
    // Notifications get 202 no-body; errors may have empty bodies too.
    if (res.status === 202 || res.status === 204) {
      return { status: res.status, rpc: null, sessionId: newSessionId };
    }

    if (contentType.includes('text/event-stream')) {
      const rpc = await readSseResponse(res, body.id as string | number | null);
      return { status: res.status, rpc, sessionId: newSessionId };
    }

    const json = contentType.includes('application/json')
      ? ((await res.json().catch(() => null)) as JsonRpcResponse | null)
      : null;
    return { status: res.status, rpc: json, sessionId: newSessionId };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads an SSE-framed response until the JSON-RPC message answering `id`
 * arrives, then cancels the stream. Unsolicited notifications interleaved in
 * the stream are ignored.
 */
async function readSseResponse(res: Response, id: string | number | null): Promise<JsonRpcResponse | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
      // SSE events are separated by a blank line
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const eventBlock = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = eventBlock
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n');
        if (!data) continue;
        try {
          const msg = JSON.parse(data) as JsonRpcResponse;
          if ('id' in msg && msg.id === id && (msg.result !== undefined || msg.error !== undefined)) {
            return msg;
          }
        } catch {
          // non-JSON data line: ignore
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // stream already closed
    }
  }
}

async function ensureSession(url: string, token: string, timeoutMs: number): Promise<McpSession> {
  const key = sessionKey(url, token);
  const cached = sessions.get(key);
  if (cached) return cached;

  const id = `init-${++rpcCounter}`;
  const { status, rpc, sessionId } = await rawRpc(
    url,
    token,
    {
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: process.env.CORTEX_SERVER_NAME ?? 'cortex-gateway', version: '0.2.0' },
      },
    },
    null,
    timeoutMs,
  );

  if (status === 401) throw new McpDownstreamUnauthorized();
  if (!rpc || rpc.error || !rpc.result) {
    throw new McpDownstreamError(
      `Downstream MCP initialize failed (HTTP ${status}${rpc?.error ? `, ${rpc.error.message}` : ''})`,
      status,
      rpc?.error?.code,
    );
  }

  const negotiated =
    typeof (rpc.result as { protocolVersion?: string }).protocolVersion === 'string'
      ? (rpc.result as { protocolVersion: string }).protocolVersion
      : PROTOCOL_VERSION;

  const session: McpSession = { sessionId, protocolVersion: negotiated };
  sessions.set(key, session);

  // Spec lifecycle: fire the initialized notification (202 expected).
  await rawRpc(url, token, { jsonrpc: '2.0', method: 'notifications/initialized' }, session, timeoutMs).catch(
    () => undefined,
  );

  return session;
}

/**
 * Performs one MCP request against a downstream server, managing the session
 * transparently (initialize on first use, one retry on session expiry).
 */
export async function mcpRequest<T = unknown>(
  url: string,
  token: string,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = 20_000,
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await ensureSession(url, token, timeoutMs);
    const id = `req-${++rpcCounter}`;
    const { status, rpc } = await rawRpc(
      url,
      token,
      { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) },
      session,
      timeoutMs,
    );

    if (status === 401) throw new McpDownstreamUnauthorized();
    if (status === 404 && attempt === 0) {
      // Session expired server-side: re-initialize once.
      dropSession(url, token);
      continue;
    }
    if (!rpc) {
      throw new McpDownstreamError(`Downstream MCP returned no JSON-RPC response (HTTP ${status})`, status);
    }
    if (rpc.error) {
      throw new McpDownstreamError(rpc.error.message, status, rpc.error.code);
    }
    return rpc.result as T;
  }
  throw new McpDownstreamError('Downstream MCP session could not be re-established', 404);
}

// ─── Typed helpers over the MCP primitives the bridge uses ────────────────

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** tools/list with cursor pagination (bounded at 10 pages). */
export async function mcpListTools(url: string, token: string): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res = await mcpRequest<{ tools?: McpTool[]; nextCursor?: string }>(
      url,
      token,
      'tools/list',
      cursor ? { cursor } : {},
    );
    tools.push(...(res.tools ?? []));
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return tools;
}

export interface McpCallResult {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
  structuredContent?: unknown;
}

export async function mcpCallTool(
  url: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  return mcpRequest<McpCallResult>(url, token, 'tools/call', { name, arguments: args });
}
