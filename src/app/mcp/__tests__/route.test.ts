/**
 * `/mcp` served to both protocol generations — 2026-07-28 (stateless) and the
 * historical `initialize` path (2025-06-18 / 2025-03-26) — plus the security
 * gates that sit in the route and in the method handlers.
 *
 * The route is called as is; only OAuth, the federated catalog, backend calls,
 * the database and the platform notification are simulated.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { BackendApp, FederatedToolEntry } from '@/contract';
import { CortexBackendAclDenied, CortexBackendError, CortexBackendUnauthorized } from '@/contract';

const { validateRequest, callBackend, logAudit } = vi.hoisted(() => ({
  validateRequest: vi.fn(),
  callBackend: vi.fn(),
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
vi.mock('@/contract', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/contract')>()),
  callBackend,
}));

// Federated catalog deliberately NOT in alphabetical order: it is the order
// backends answer in, which tools/list used to copy.
const app = (id: string): BackendApp => ({ id, baseUrl: `https://${id}.example`, backendPath: '/api/cortex/backend' });
const DOCS = app('docs');
const BILLING = app('billing');
const tool = (a: BackendApp, name: string, scope: string): [string, FederatedToolEntry] => [
  `${a.id}_${name}`,
  { app: a, tool: { name: `${a.id}_${name}`, scope, description: `Tool ${name}.`, params: { q: 'string?' } } },
];
const CATALOG = new Map<string, FederatedToolEntry>([
  tool(DOCS, 'search', 'mcp:docs:read'),
  tool(BILLING, 'list_invoices', 'mcp:billing:read'),
  tool(DOCS, 'whoami', 'mcp:docs:read'), // masked: homonym of a builtin
  tool(DOCS, 'get_help', 'mcp:docs:read'),
  tool(BILLING, 'refund', 'mcp:billing:write'), // scope not granted
]);
const TEMPLATES = [
  {
    app: DOCS,
    scheme: 'docs',
    matcher: /^docs:\/\/document\/[^/?#]+$/i,
    template: { uriTemplate: 'docs://document/{id}', name: 'Document', description: 'A document.', scope: 'mcp:docs:read' },
  },
  {
    app: DOCS,
    scheme: 'docs',
    matcher: /^docs:\/\/secret\/[^/?#]+$/i,
    template: { uriTemplate: 'docs://secret/{id}', name: 'Secret', description: 'Restricted.', scope: 'mcp:docs:admin' },
  },
  {
    // Overlaps both templates above: a read scope must not open docs://secret/*.
    app: DOCS,
    scheme: 'docs',
    matcher: /^docs:\/\/[^/?#]+\/[^/?#]+$/,
    template: { uriTemplate: 'docs://{kind}/{id}', name: 'Any', description: 'Broad.', scope: 'mcp:docs:read' },
  },
];

vi.mock('@/lib/federator', () => ({
  REFRESH_INTERVAL_MS: 60_000,
  startPeriodicRefresh: () => {},
  refreshCatalog: async () => {},
  getCatalog: () => ({
    tools: CATALOG,
    lastRefreshedAt: new Date('2026-10-25T00:00:00Z'),
    healthyApps: ['docs', 'billing'],
    unreachableApps: [],
  }),
  getOriginalToolName: (n: string) => (CATALOG.has(n) ? n.replace(/^[a-z]+_/, '') : n),
  lookupTool: (n: string) => CATALOG.get(n) ?? null,
  listPrompts: () => [],
  lookupPrompt: () => null,
  listResourceTemplates: () => TEMPLATES,
  findBackendForUri: (uri: string) => (uri.startsWith('docs://') ? DOCS : null),
  matchResourceTemplates: (uri: string) => TEMPLATES.filter((t) => t.matcher.test(uri)),
  backendsReachableBy: (scopes: ReadonlySet<string>) => {
    const out = new Map<string, BackendApp>();
    for (const { app: a, tool: t } of CATALOG.values()) if (scopes.has(t.scope)) out.set(a.id, a);
    return Array.from(out.values());
  },
}));

import { DELETE, GET, POST } from '@/app/mcp/route';

const MCP_URL = 'https://mcp.example.com/mcp';
const MODERN = '2026-07-28';
const META = {
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
};
const BUILTINS = ['whoami', 'list_cortex_resources', 'read_cortex_resource', 'report_missing_capability', 'list_cortex_tickets'];

let nextId = 1;

function request(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(MCP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Conforming 2026-07-28 request: version in header and `_meta`, Mcp-Method, Mcp-Name. */
function modern(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}): NextRequest {
  const name = typeof params.name === 'string' ? params.name : typeof params.uri === 'string' ? params.uri : null;
  return request(
    { jsonrpc: '2.0', id: nextId++, method, params: { ...params, _meta: META } },
    { 'mcp-protocol-version': MODERN, 'mcp-method': method, ...(name ? { 'mcp-name': name } : {}), ...headers },
  );
}

function legacy(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}): NextRequest {
  return request({ jsonrpc: '2.0', id: nextId++, method, params }, headers);
}

async function read(res: Response) {
  return { status: res.status, body: JSON.parse(await res.text()) };
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    context: {
      sub: 'sub-test',
      email: 'agent@example.test',
      role: '',
      pool: 'staff',
      scopes: ['mcp:docs:read'],
      clientId: 'client-test',
      jti: `jti-${Math.random()}`,
      bearerToken: 'caller-token',
      isDevBypass: false,
      ...overrides,
    },
  };
}

beforeEach(() => {
  validateRequest.mockReset();
  validateRequest.mockResolvedValue(context());
  callBackend.mockReset();
  logAudit.mockReset();
});

afterEach(() => {
  delete process.env.CORTEX_REQUIRED_POOL;
});

describe('MCP 2026-07-28: no initialize, no session', () => {
  it('tools/list answers straight away, complete result, private cache hints', async () => {
    const { status, body } = await read(await POST(modern('tools/list')));
    expect(status).toBe(200);
    expect(body.result.resultType).toBe('complete');
    expect(body.result.cacheScope).toBe('private');
    expect(body.result.ttlMs).toBe(60_000);
    expect(body.result._meta['io.modelcontextprotocol/serverInfo']).toMatchObject({ name: 'cortex-gateway' });
  });

  it('server/discover: versions, capabilities without listChanged, public cache', async () => {
    const { body } = await read(await POST(modern('server/discover')));
    expect(body.result.supportedVersions).toEqual(['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26']);
    expect(body.result.capabilities).toEqual({ tools: {}, resources: {}, prompts: {} });
    // Private: the instructions name the backends this caller holds a scope on.
    expect(body.result.cacheScope).toBe('private');
    expect(body.result.instructions).toContain('Backends you hold a scope on: docs.');
  });

  it('tools/call is wrapped too, and no session is issued', async () => {
    callBackend.mockResolvedValue({ hits: [] });
    const res = await POST(modern('tools/call', { name: 'docs_search', arguments: {} }));
    const { body } = await read(res);
    expect(body.result.resultType).toBe('complete');
    expect(res.headers.get('mcp-session-id')).toBeNull();
  });

  it('an Mcp-Session-Id is ignored (legacy would answer 404 for an unknown session)', async () => {
    const { status } = await read(await POST(modern('tools/list', {}, { 'mcp-session-id': 'unknown' })));
    expect(status).toBe(200);
  });

  it('initialize and ping no longer exist: 404 + -32601', async () => {
    for (const method of ['initialize', 'ping']) {
      const { status, body } = await read(await POST(modern(method)));
      expect(status).toBe(404);
      expect(body.error.code).toBe(-32601);
    }
  });
});

describe('MCP 2026-07-28: protocol-level refusals', () => {
  it('unknown version: 400 + -32022 with the supported versions and the request id, before auth', async () => {
    const res = await POST(request({ jsonrpc: '2.0', id: 42, method: 'tools/list' }, { 'mcp-protocol-version': '2099-01-01' }));
    const { status, body } = await read(res);
    expect(status).toBe(400);
    expect(body.id).toBe(42);
    expect(body.error.code).toBe(-32022);
    expect(body.error.data.supported).toContain('2026-07-28');
    expect(validateRequest).not.toHaveBeenCalled();
  });

  it('unknown version, unreadable body: -32022 with id null', async () => {
    const { body } = await read(await POST(request('{not json', { 'mcp-protocol-version': '2099-01-01' })));
    expect(body.error.code).toBe(-32022);
    expect(body.id).toBeNull();
  });

  it('Mcp-Method inconsistent with the body or missing: 400 + -32020', async () => {
    for (const headers of [{ 'mcp-method': 'tools/call' }, { 'mcp-method': '' }]) {
      const req = request(
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META } },
        { 'mcp-protocol-version': MODERN, ...headers },
      );
      const { status, body } = await read(await POST(req));
      expect(status).toBe(400);
      expect(body.error.code).toBe(-32020);
    }
  });

  it('Mcp-Name not matching the tool name: -32020, and the backend is never called', async () => {
    const { body } = await read(await POST(modern('tools/call', { name: 'docs_search' }, { 'mcp-name': 'billing_refund' })));
    expect(body.error.code).toBe(-32020);
    expect(callBackend).not.toHaveBeenCalled();
  });

  it('Mcp-Name in base64 is decoded before comparison; invalid base64 is refused', async () => {
    callBackend.mockResolvedValue({});
    const encoded = `=?base64?${Buffer.from('docs_search').toString('base64')}?=`;
    const ok = await read(await POST(modern('tools/call', { name: 'docs_search' }, { 'mcp-name': encoded })));
    expect(ok.body.result).toBeDefined();
    const bad = await read(await POST(modern('tools/call', { name: 'docs_search' }, { 'mcp-name': '=?base64?ZG9j!!c19zZWFyY2g=?=' })));
    expect(bad.body.error.code).toBe(-32020);
  });

  it('header and _meta disagreeing: -32020; _meta without clientCapabilities: -32602', async () => {
    const mismatch = request(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { ...META, 'io.modelcontextprotocol/protocolVersion': '2025-06-18' } } },
      { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list' },
    );
    expect((await read(await POST(mismatch))).body.error.code).toBe(-32020);

    const noCaps = request(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } } },
      { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list' },
    );
    expect((await read(await POST(noCaps))).body.error.code).toBe(-32602);
  });

  it('refusals after auth are audited (success=false + code)', async () => {
    await POST(modern('tools/call', { name: 'docs_search' }, { 'mcp-name': 'other' }));
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ success: false, error_code: '-32020', session_id: null }));
  });
});

describe('not found: -32602 in 2026-07-28, -32601 in legacy', () => {
  it('unknown tool and resource', async () => {
    expect((await read(await POST(modern('tools/call', { name: 'nope' })))).body.error.code).toBe(-32602);
    expect((await read(await POST(legacy('tools/call', { name: 'nope' })))).body.error.code).toBe(-32601);
    expect((await read(await POST(modern('resources/read', { uri: 'zzz://x' })))).body.error.code).toBe(-32602);
    expect((await read(await POST(legacy('resources/read', { uri: 'zzz://x' })))).body.error.code).toBe(-32601);
  });
});

describe('deterministic tools/list order', () => {
  it('builtins first, then federated tools sorted by name, identical across generations', async () => {
    const names = (r: { body: { result: { tools: Array<{ name: string }> } } }) => r.body.result.tools.map((t) => t.name);
    const fromModern = names(await read(await POST(modern('tools/list'))));
    const fromLegacy = names(await read(await POST(legacy('tools/list'))));
    expect(fromModern).toEqual([...BUILTINS, 'docs_get_help', 'docs_search']);
    expect(fromLegacy).toEqual(fromModern);
  });
});

describe('legacy client: initialize then tools/list, as before', () => {
  it('initialize negotiates 2025-06-18 and issues a session, without 2026 wrapping', async () => {
    const res = await POST(legacy('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }));
    const { body } = await read(res);
    expect(body.result.protocolVersion).toBe('2025-06-18');
    expect(body.result.resultType).toBeUndefined();
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
  });

  it('an inconsistent Mcp-Method header is not checked on the legacy path', async () => {
    const { status } = await read(await POST(legacy('tools/list', {}, { 'mcp-method': 'tools/call' })));
    expect(status).toBe(200);
  });
});

describe('pool sandbox', () => {
  it('refuses a token from another pool AND a token without the claim', async () => {
    process.env.CORTEX_REQUIRED_POOL = 'staff';
    validateRequest.mockResolvedValueOnce(context({ pool: 'partners' }));
    expect((await POST(legacy('tools/list'))).status).toBe(403);
    validateRequest.mockResolvedValueOnce(context({ pool: '' }));
    expect((await POST(legacy('tools/list'))).status).toBe(403);
    validateRequest.mockResolvedValueOnce(context({ pool: 'staff' }));
    expect((await POST(legacy('tools/list'))).status).toBe(200);
  });

  it('applies to the SSE stream and to session termination too', async () => {
    process.env.CORTEX_REQUIRED_POOL = 'staff';
    validateRequest.mockResolvedValue(context({ pool: '' }));
    const sse = new NextRequest(MCP_URL, { method: 'GET', headers: { accept: 'text/event-stream' } });
    expect((await GET(sse)).status).toBe(403);
    const del = new NextRequest(MCP_URL, { method: 'DELETE', headers: { 'mcp-session-id': 'x' } });
    expect((await DELETE(del)).status).toBe(403);
  });
});

describe('resources/read is gated by the scope of the matching template', () => {
  it('with overlapping templates, every matching scope is required', async () => {
    const { body } = await read(await POST(legacy('resources/read', { uri: 'docs://secret/9' })));
    expect(body.error.data.required).toEqual(expect.arrayContaining(['mcp:docs:admin']));
    expect(callBackend).not.toHaveBeenCalled();
  });

  it('reads a resource under a granted template', async () => {
    callBackend.mockResolvedValue({ contents: [{ uri: 'docs://document/1', mimeType: 'text/plain', text: 'x' }] });
    const { body } = await read(await POST(legacy('resources/read', { uri: 'docs://document/1' })));
    expect(body.result.contents[0].text).toBe('x');
  });

  it('refuses a resource whose template scope is not granted, without calling the backend', async () => {
    const { body } = await read(await POST(legacy('resources/read', { uri: 'docs://secret/1' })));
    expect(body.error.message).toBe('Insufficient scope');
    expect(body.error.data.required).toEqual(['mcp:docs:admin']);
    expect(callBackend).not.toHaveBeenCalled();
  });

  it('refuses a URI of a known scheme that matches no template', async () => {
    const { body } = await read(await POST(legacy('resources/read', { uri: 'docs://anything/else/here' })));
    expect(body.error.code).toBe(-32601);
    expect(callBackend).not.toHaveBeenCalled();
  });

  it('the read_cortex_resource wrapper goes through the same check', async () => {
    const { body } = await read(await POST(legacy('tools/call', { name: 'read_cortex_resource', arguments: { uri: 'docs://secret/1' } })));
    expect(body.error.message).toBe('Insufficient scope');
    expect(callBackend).not.toHaveBeenCalled();
  });
});

describe('the caller token only reaches backends the caller holds a scope on', () => {
  it('whoami fans out to docs only, not to billing', async () => {
    callBackend.mockResolvedValue({ role: 'reader' });
    await POST(legacy('tools/call', { name: 'whoami', arguments: {} }));
    const targets = callBackend.mock.calls.map(([args]) => (args as { baseUrl: string }).baseUrl);
    expect(targets).toEqual(['https://docs.example']);
  });

  it('cortex://architecture lists no backend URL and only the backends the caller reaches', async () => {
    const { body } = await read(await POST(legacy('resources/read', { uri: 'cortex://architecture' })));
    const text: string = body.result.contents[0].text;
    expect(text).not.toContain('https://docs.example');
    expect(text).not.toContain('`billing`');
    expect(text).toContain('| `docs` | 2 |');
  });
});

describe('report_missing_capability', () => {
  it('bounds the text fields and rate-limits per identity', async () => {
    process.env.CORTEX_TICKET_BACKENDS = 'docs';
    process.env.CORTEX_BACKENDS = 'docs';
    process.env.CORTEX_BACKEND_DOCS_URL = 'https://docs.example';
    process.env.CORTEX_TICKET_RATE_PER_HOUR = '2';
    try {
      callBackend.mockResolvedValue({ ticketId: 't1', deduplicated: false });
      validateRequest.mockResolvedValue(context({ sub: 'sub-tickets' }));
      const args = { whatIWanted: 'x'.repeat(10_000), userIntent: 'why', severity: 'inconvenient', contextApp: 'docs' };
      for (let i = 0; i < 2; i++) {
        const { body } = await read(await POST(legacy('tools/call', { name: 'report_missing_capability', arguments: args })));
        expect(body.result).toBeDefined();
      }
      const sent = (callBackend.mock.calls[0][0] as { params: { whatIWanted: string } }).params.whatIWanted;
      expect(sent).toHaveLength(2000);
      const third = await read(await POST(legacy('tools/call', { name: 'report_missing_capability', arguments: args })));
      expect(third.body.error.message).toBe('Ticket rate limit exceeded');
    } finally {
      delete process.env.CORTEX_TICKET_BACKENDS;
      delete process.env.CORTEX_BACKENDS;
      delete process.env.CORTEX_BACKEND_DOCS_URL;
      delete process.env.CORTEX_TICKET_RATE_PER_HOUR;
    }
  });

  it('does not forward a ticket to a backend the caller holds no scope on', async () => {
    process.env.CORTEX_TICKET_BACKENDS = 'billing';
    process.env.CORTEX_BACKENDS = 'billing';
    process.env.CORTEX_BACKEND_BILLING_URL = 'https://billing.example';
    try {
      validateRequest.mockResolvedValue(context({ sub: 'sub-no-billing' }));
      const args = { whatIWanted: 'w', userIntent: 'u', severity: 'nice_to_have', contextApp: 'billing' };
      const { body } = await read(await POST(legacy('tools/call', { name: 'report_missing_capability', arguments: args })));
      expect(body.error.message).toContain('No granted scope on backend billing');
      expect(callBackend).not.toHaveBeenCalled();
    } finally {
      delete process.env.CORTEX_TICKET_BACKENDS;
      delete process.env.CORTEX_BACKENDS;
      delete process.env.CORTEX_BACKEND_BILLING_URL;
    }
  });
});

describe('tools/call results follow the spec', () => {
  const call = () => POST(legacy('tools/call', { name: 'docs_search', arguments: {} }));

  it('relays MCP content blocks from a backend that already speaks them', async () => {
    const content = [
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'resource', resource: { uri: 'docs://document/1', mimeType: 'text/plain', text: 'x' } },
    ];
    callBackend.mockResolvedValue({ content, isError: false, extra: 'dropped' });
    const { body } = await read(await call());
    expect(body.result).toEqual({ content, isError: false });
  });

  it('serializes as text anything that is not a well-formed CallToolResult', async () => {
    callBackend.mockResolvedValue({ content: [{ title: 'an article, not a content block' }] });
    const { body } = await read(await call());
    expect(body.result.content).toEqual([{ type: 'text', text: '{"content":[{"title":"an article, not a content block"}]}' }]);
  });

  it('reports a backend business error as a tool execution error, keeping its hint', async () => {
    callBackend.mockRejectedValue(new CortexBackendError('Backend 400', 400, { error: 'limit must be <= 100', hint: 'use pagination' }));
    const { body } = await read(await call());
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('limit must be <= 100');
    expect(body.result.content[0].text).toContain('use pagination');
  });

  it('reports an ACL refusal as a tool execution error, and a backend 401 as a protocol error', async () => {
    callBackend.mockRejectedValueOnce(new CortexBackendAclDenied('not a member', { error: 'not a member' }));
    expect((await read(await call())).body.result).toMatchObject({ isError: true });
    callBackend.mockRejectedValueOnce(new CortexBackendUnauthorized({}));
    expect((await read(await call())).body.error.code).toBe(-32603);
  });
});
