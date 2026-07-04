/**
 * Tests for the downstream MCP client: initialize handshake + session header
 * capture, JSON and SSE response framing, session-expiry retry, pagination.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mcpRequest, mcpListTools, McpDownstreamUnauthorized } from '../mcp-client';

const URL_A = 'https://mcp.example.com/mcp';

interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function jsonResponse(rpc: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(rpc), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function sseResponse(events: unknown[], headers: Record<string, string> = {}): Response {
  const payload = events.map((e) => `event: message\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(payload, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...headers },
  });
}

/**
 * Builds a fetch mock that answers initialize / notifications/initialized
 * automatically and delegates other methods to `handler`. Records all calls.
 */
function mcpServerMock(
  handler: (body: Record<string, unknown>, headers: Record<string, string>) => Response,
  recorded: Recorded[] = [],
) {
  return vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    recorded.push({ url, headers, body });
    if (body.method === 'initialize') {
      return jsonResponse(
        { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock' } } },
        { 'mcp-session-id': 'sess-1' },
      );
    }
    if (body.method === 'notifications/initialized') {
      return new Response(null, { status: 202 });
    }
    return handler(body, headers);
  });
}

// Each test uses a unique token so the module-level session cache never leaks
// state between tests.
let tokenCounter = 0;
function freshToken(): string {
  return `token-${Date.now()}-${++tokenCounter}-${'x'.repeat(20)}`;
}

describe('mcpRequest', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('performs the initialize handshake then the request, propagating the session id', async () => {
    const recorded: Recorded[] = [];
    vi.stubGlobal('fetch', mcpServerMock(
      (body) => jsonResponse({ jsonrpc: '2.0', id: body.id, result: { ok: true } }),
      recorded,
    ));

    const res = await mcpRequest<{ ok: boolean }>(URL_A, freshToken(), 'tools/list', {});
    expect(res).toEqual({ ok: true });

    const methods = recorded.map((r) => r.body.method);
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    // The data request carries the captured session id + negotiated version
    const dataReq = recorded[2];
    expect(dataReq.headers['mcp-session-id']).toBe('sess-1');
    expect(dataReq.headers['mcp-protocol-version']).toBe('2025-06-18');
  });

  it('parses SSE-framed responses and ignores interleaved notifications', async () => {
    vi.stubGlobal('fetch', mcpServerMock((body) =>
      sseResponse([
        { jsonrpc: '2.0', method: 'notifications/progress', params: { p: 1 } },
        { jsonrpc: '2.0', id: body.id, result: { via: 'sse' } },
      ]),
    ));

    const res = await mcpRequest<{ via: string }>(URL_A, freshToken(), 'tools/call', { name: 't' });
    expect(res).toEqual({ via: 'sse' });
  });

  it('re-initializes once when the session expired (404), then succeeds', async () => {
    const recorded: Recorded[] = [];
    let dataCalls = 0;
    vi.stubGlobal('fetch', mcpServerMock((body) => {
      dataCalls += 1;
      if (dataCalls === 1) return new Response(null, { status: 404 });
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { recovered: true } });
    }, recorded));

    const res = await mcpRequest<{ recovered: boolean }>(URL_A, freshToken(), 'tools/list', {});
    expect(res).toEqual({ recovered: true });
    // initialize ran twice (initial + after expiry)
    expect(recorded.filter((r) => r.body.method === 'initialize')).toHaveLength(2);
  });

  it('throws McpDownstreamUnauthorized on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    await expect(mcpRequest(URL_A, freshToken(), 'tools/list', {})).rejects.toBeInstanceOf(
      McpDownstreamUnauthorized,
    );
  });

  it('surfaces JSON-RPC errors as McpDownstreamError', async () => {
    vi.stubGlobal('fetch', mcpServerMock((body) =>
      jsonResponse({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'bad params' } }),
    ));
    await expect(mcpRequest(URL_A, freshToken(), 'tools/call', {})).rejects.toMatchObject({
      name: 'McpDownstreamError',
      message: 'bad params',
      code: -32602,
    });
  });
});

describe('mcpListTools', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('follows nextCursor pagination', async () => {
    vi.stubGlobal('fetch', mcpServerMock((body) => {
      const params = (body.params ?? {}) as { cursor?: string };
      if (!params.cursor) {
        return jsonResponse({
          jsonrpc: '2.0', id: body.id,
          result: { tools: [{ name: 'a' }], nextCursor: 'c2' },
        });
      }
      return jsonResponse({
        jsonrpc: '2.0', id: body.id,
        result: { tools: [{ name: 'b', description: 'B', inputSchema: { type: 'object' } }] },
      });
    }));

    const tools = await mcpListTools(URL_A, freshToken());
    expect(tools.map((t) => t.name)).toEqual(['a', 'b']);
  });
});
