/**
 * MCP Apps relay through `/mcp`: what a backend declares as `ui` reaches the
 * client as `_meta.ui`, its view is readable through `resources/read`, and
 * its result carries `structuredContent` — under the same scope checks as
 * everything else, and without a backend call on any refusal.
 *
 * Same harness as route.test.ts: the route is called as is; OAuth, the
 * federated catalog and backend calls are simulated.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { BackendApp, CortexBackendToolUi, FederatedToolEntry } from '@/contract';

const { validateRequest, callBackend, isQuarantined, logAudit } = vi.hoisted(() => ({
  validateRequest: vi.fn(),
  callBackend: vi.fn(),
  isQuarantined: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/oauth-validator', () => ({
  validateRequest,
  canonicalUri: () => 'https://mcp.example.com/mcp',
  buildWwwAuthenticate: () => 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
}));
vi.mock('@/lib/audit-log', () => ({ logAudit, hashEmail: () => 'h', hashParams: () => 'p' }));
vi.mock('@/lib/prisma', () => ({ isDatabaseConfigured: () => false, getPrismaCortex: () => ({}) }));
vi.mock('@/lib/notify', () => ({ notifyAdminOnBlocking: vi.fn() }));
vi.mock('@/lib/tool-integrity', () => ({ isQuarantined }));
vi.mock('@/contract', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/contract')>()),
  callBackend,
}));

const app = (id: string): BackendApp => ({ id, baseUrl: `https://${id}.example`, backendPath: '/api/cortex/backend' });
const DOCS = app('docs');
const BILLING = app('billing');
const tool = (a: BackendApp, name: string, scope: string, ui?: CortexBackendToolUi): [string, FederatedToolEntry] => [
  `${a.id}_${name}`,
  { app: a, tool: { name: `${a.id}_${name}`, scope, description: `Tool ${name}.`, params: { q: 'string?' }, ...(ui ? { ui } : {}) } },
];
const CATALOG = new Map<string, FederatedToolEntry>([
  tool(DOCS, 'search', 'mcp:docs:read'),
  tool(DOCS, 'preview', 'mcp:docs:read', { resourceUri: 'ui://preview' }),
  // Reserved to the view, behind a scope the default caller does not hold.
  tool(DOCS, 'refresh_preview', 'mcp:docs:write', { resourceUri: 'ui://editor', visibility: ['app'] }),
  // Reserved to the view, no view of its own.
  tool(DOCS, 'pin', 'mcp:docs:read', { visibility: ['app'] }),
  tool(DOCS, 'broken', 'mcp:docs:read', { resourceUri: 'ui://../escape' }),
  tool(BILLING, 'invoice_card', 'mcp:billing:read', { resourceUri: 'ui://preview' }),
  // One view, two tools, two scopes: either scope opens it.
  tool(BILLING, 'refund_form', 'mcp:billing:write', { resourceUri: 'ui://preview' }),
]);

vi.mock('@/lib/federator', () => ({
  REFRESH_INTERVAL_MS: 60_000,
  startPeriodicRefresh: () => {},
  refreshCatalog: async () => {},
  getCatalog: () => ({
    tools: CATALOG,
    lastRefreshedAt: new Date('2026-11-11T00:00:00Z'),
    healthyApps: ['docs', 'billing'],
    unreachableApps: [],
  }),
  getOriginalToolName: (n: string) => (CATALOG.has(n) ? n.replace(/^[a-z]+_/, '') : n),
  lookupTool: (n: string) => CATALOG.get(n) ?? null,
  listPrompts: () => [],
  lookupPrompt: () => null,
  listResourceTemplates: () => [],
  findBackendForUri: () => null,
  matchResourceTemplates: () => [],
  backendsReachableBy: () => [DOCS],
}));

import { POST } from '@/app/mcp/route';

const MCP_URL = 'https://mcp.example.com/mcp';
const MODERN = '2026-07-28';
const META = {
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
};
const UI_CAPABILITY = { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } };

let nextId = 1;

function request(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(MCP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
}

function modern(method: string, params: Record<string, unknown> = {}): NextRequest {
  const name = typeof params.name === 'string' ? params.name : typeof params.uri === 'string' ? params.uri : null;
  return request(
    { jsonrpc: '2.0', id: nextId++, method, params: { ...params, _meta: META } },
    { 'mcp-protocol-version': MODERN, 'mcp-method': method, ...(name ? { 'mcp-name': name } : {}) },
  );
}

function legacy(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}): NextRequest {
  return request({ jsonrpc: '2.0', id: nextId++, method, params }, headers);
}

async function read(res: Response) {
  return { status: res.status, body: JSON.parse(await res.text()) };
}

function context(scopes: string[] = ['mcp:docs:read']) {
  return {
    ok: true,
    context: {
      sub: 'sub-test',
      email: 'agent@example.test',
      role: '',
      pool: 'staff',
      scopes,
      clientId: 'client-test',
      jti: `jti-${Math.random()}`,
      bearerToken: 'caller-token',
      isDevBypass: false,
    },
  };
}

type Listed = { name: string; _meta: Record<string, unknown> };
const byName = (tools: Listed[]) => Object.fromEntries(tools.map((t) => [t.name, t]));

beforeEach(() => {
  validateRequest.mockReset();
  validateRequest.mockResolvedValue(context());
  callBackend.mockReset();
  isQuarantined.mockReset();
  isQuarantined.mockReturnValue(false);
  logAudit.mockReset();
});

describe('tools/list and find_tools', () => {
  it('a tool declaring a view carries the published _meta.ui, next to version and app, in both generations', async () => {
    for (const req of [modern('tools/list'), legacy('tools/list')]) {
      const tools = byName((await read(await POST(req))).body.result.tools);
      expect(tools.docs_preview._meta).toEqual({ version: '1.0.0', app: 'docs', ui: { resourceUri: 'ui://docs/preview' } });
      expect(tools.docs_pin._meta.ui).toEqual({ visibility: ['app'] });
    }
  });

  it('a tool without a view is unchanged; an invalid URI is not published and the tool stays listed', async () => {
    const tools = byName((await read(await POST(legacy('tools/list')))).body.result.tools);
    expect(tools.docs_search._meta).toEqual({ version: '1.0.0', app: 'docs' });
    expect(tools.docs_broken._meta).toEqual({ version: '1.0.0', app: 'docs' });
  });

  it('search mode keeps _meta.ui; find_tools too, minus the tools reserved to a view', async () => {
    const listed = byName((await read(await POST(legacy('tools/list', {}, { 'x-cortex-tool-mode': 'search' })))).body.result.tools);
    expect(listed.docs_preview._meta.ui).toEqual({ resourceUri: 'ui://docs/preview' });

    const res = await read(
      await POST(legacy('tools/call', { name: 'find_tools', arguments: { names: ['docs_preview', 'docs_pin'] } })),
    );
    const found = JSON.parse(res.body.result.content[0].text).tools as Listed[];
    expect(found.map((t) => t.name)).toEqual(['docs_preview']);
    expect(found[0]._meta.ui).toEqual({ resourceUri: 'ui://docs/preview' });
  });
});

describe('tools/call', () => {
  it('view tool + object result: structuredContent added, text unchanged', async () => {
    callBackend.mockResolvedValue({ title: 'Q3', pages: 4 });
    const { body } = await read(await POST(legacy('tools/call', { name: 'docs_preview', arguments: {} })));
    expect(body.result.content).toEqual([{ type: 'text', text: '{"title":"Q3","pages":4}' }]);
    expect(body.result.structuredContent).toEqual({ title: 'Q3', pages: 4 });
  });

  it('tool without a view: no structuredContent, as before', async () => {
    callBackend.mockResolvedValue({ hits: [] });
    const { body } = await read(await POST(legacy('tools/call', { name: 'docs_search', arguments: {} })));
    expect(body.result).toEqual({ content: [{ type: 'text', text: '{"hits":[]}' }] });
  });

  it('a backend already answering with a CallToolResult is relayed as is', async () => {
    callBackend.mockResolvedValue({ content: [{ type: 'text', text: 'Four pages.' }], structuredContent: { pages: 4 } });
    const { body } = await read(await POST(legacy('tools/call', { name: 'docs_preview', arguments: {} })));
    expect(body.result).toEqual({ content: [{ type: 'text', text: 'Four pages.' }], structuredContent: { pages: 4 } });
  });

  it('a tool reserved to a view is still an ordinary call: same token, same scope check', async () => {
    const refused = await read(await POST(legacy('tools/call', { name: 'docs_refresh_preview', arguments: {} })));
    expect(refused.body.error.message).toBe('Insufficient scope');
    expect(callBackend).not.toHaveBeenCalled();

    validateRequest.mockResolvedValue(context(['mcp:docs:read', 'mcp:docs:write']));
    callBackend.mockResolvedValue({ ok: true });
    await POST(legacy('tools/call', { name: 'docs_refresh_preview', arguments: {} }));
    expect(callBackend).toHaveBeenCalledWith(expect.objectContaining({ method: 'refresh_preview', bearerToken: 'caller-token' }));
  });
});

describe('resources/read on a view', () => {
  const VIEW = {
    uri: 'ui://preview',
    mimeType: 'text/html;profile=mcp-app',
    text: '<!doctype html><title>Preview</title>',
    _meta: { ui: { csp: { connectDomains: [] }, prefersBorder: true } },
  };

  it('routes to the declaring backend with its local URI, relays mimeType and _meta, answers with the published URI', async () => {
    callBackend.mockResolvedValue({ contents: [VIEW] });
    for (const req of [modern('resources/read', { uri: 'ui://docs/preview' }), legacy('resources/read', { uri: 'ui://docs/preview' })]) {
      const { body } = await read(await POST(req));
      expect(body.result.contents).toEqual([{ ...VIEW, uri: 'ui://docs/preview' }]);
    }
    expect(callBackend).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://docs.example',
        method: 'read_resource',
        params: { uri: 'ui://preview' },
        bearerToken: 'caller-token',
      }),
    );
  });

  it('undeclared view, unknown backend or forged URI: not found, and no backend is called', async () => {
    for (const uri of [
      'ui://docs/other',
      'ui://nope/preview',
      'ui://docs/../billing/preview',
      'ui://docs/preview/../preview',
      'ui://docs/preview?x=1',
      'ui://docs',
      'ui://docs/escape',
      'ui://preview',
    ]) {
      expect((await read(await POST(legacy('resources/read', { uri })))).body.error.code, uri).toBe(-32601);
      expect((await read(await POST(modern('resources/read', { uri })))).body.error.code, uri).toBe(-32602);
    }
    expect(callBackend).not.toHaveBeenCalled();
  });

  it('without the scope of a tool declaring it: refused, and no backend is called', async () => {
    // Same path as the docs view, another backend: the id in the URI decides.
    const billing = await read(await POST(legacy('resources/read', { uri: 'ui://billing/preview' })));
    expect(billing.body.error.message).toBe('Insufficient scope');
    expect(billing.body.error.data.anyOf).toEqual(['mcp:billing:read', 'mcp:billing:write']);
    const editor = await read(await POST(legacy('resources/read', { uri: 'ui://docs/editor' })));
    expect(editor.body.error.message).toBe('Insufficient scope');
    expect(callBackend).not.toHaveBeenCalled();
  });

  it('a view declared by several tools opens with the scope of any one of them', async () => {
    validateRequest.mockResolvedValue(context(['mcp:billing:write']));
    callBackend.mockResolvedValue({ contents: [VIEW] });
    const { body } = await read(await POST(legacy('resources/read', { uri: 'ui://billing/preview' })));
    expect(body.result.contents[0].uri).toBe('ui://billing/preview');
    expect(callBackend).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'https://billing.example' }));
  });

  it('only the view that was asked for is relayed, and a missing mimeType reads as the MCP Apps one', async () => {
    callBackend.mockResolvedValue({
      contents: [{ uri: 'ui://preview', text: '<p>ok</p>' }, { uri: 'docs://secret/1', mimeType: 'text/plain', text: 'leak' }],
    });
    const { body } = await read(await POST(legacy('resources/read', { uri: 'ui://docs/preview' })));
    expect(body.result.contents).toEqual([{ uri: 'ui://docs/preview', mimeType: 'text/html;profile=mcp-app', text: '<p>ok</p>' }]);
  });

  it('the read_cortex_resource builtin goes through the same gate', async () => {
    const refused = await read(
      await POST(legacy('tools/call', { name: 'read_cortex_resource', arguments: { uri: 'ui://billing/preview' } })),
    );
    expect(refused.body.error.message).toBe('Insufficient scope');
    expect(callBackend).not.toHaveBeenCalled();
  });

  it('an uppercase scheme or a non-string uri reaches no backend', async () => {
    for (const uri of ['UI://docs/preview', 'Ui://docs/preview', 42, { href: 'ui://docs/preview' }]) {
      const { body } = await read(await POST(legacy('resources/read', { uri })));
      expect(body.error, String(uri)).toBeDefined();
    }
    expect(callBackend).not.toHaveBeenCalled();
  });

  it('a view read is attributed to its backend in the audit trail; a refused forgery to none', async () => {
    callBackend.mockResolvedValue({ contents: [VIEW] });
    await POST(legacy('resources/read', { uri: 'ui://docs/preview' }));
    expect(logAudit).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'resources/read', target_app: 'docs', success: true }));
    await POST(legacy('resources/read', { uri: 'ui://docs/other' }));
    expect(logAudit).toHaveBeenLastCalledWith(expect.objectContaining({ target_app: null, success: false }));
  });

  it('a quarantined tool no longer opens its view', async () => {
    isQuarantined.mockImplementation((name: string) => name === 'docs_preview');
    const { body } = await read(await POST(legacy('resources/read', { uri: 'ui://docs/preview' })));
    expect(body.error.code).toBe(-32601);
    expect(callBackend).not.toHaveBeenCalled();
  });

  it('a backend error on the view is surfaced, not swallowed', async () => {
    callBackend.mockRejectedValue(new Error('boom'));
    const { body } = await read(await POST(legacy('resources/read', { uri: 'ui://docs/preview' })));
    expect(body.error.code).toBe(-32603);
  });
});

describe('announced capability', () => {
  it('initialize (legacy) and server/discover (2026-07-28) announce the extension', async () => {
    const init = await read(
      await POST(legacy('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } })),
    );
    expect(init.body.result.capabilities.extensions).toEqual(UI_CAPABILITY);
    const discover = await read(await POST(modern('server/discover')));
    expect(discover.body.result.capabilities.extensions).toEqual(UI_CAPABILITY);
  });
});
