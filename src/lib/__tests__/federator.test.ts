import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { callBackend } = vi.hoisted(() => ({ callBackend: vi.fn() }));

vi.mock('@/contract', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/contract')>()),
  callBackend,
}));

import {
  backendsReachableBy,
  compileUriTemplate,
  findBackendForUri,
  listPrompts,
  listResourceTemplates,
  lookupPrompt,
  lookupTool,
  matchResourceTemplates,
  refreshCatalog,
} from '../federator';

type Catalogs = Record<string, { tools?: unknown[]; prompts?: unknown[]; resourceTemplates?: unknown[] }>;

function serve(catalogs: Catalogs) {
  callBackend.mockImplementation(async ({ baseUrl, method }: { baseUrl: string; method: string }) => {
    const id = new URL(baseUrl).hostname.split('.')[0];
    const c = catalogs[id] ?? {};
    if (method === 'list_tools') return { tools: c.tools ?? [] };
    if (method === 'list_prompts') return { prompts: c.prompts ?? [] };
    if (method === 'list_resource_templates') return { resourceTemplates: c.resourceTemplates ?? [] };
    throw new Error(`unexpected ${method}`);
  });
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  process.env.CORTEX_TECHNICAL_TOKEN = 'tech';
  process.env.CORTEX_BACKENDS = 'docs,billing';
  process.env.CORTEX_BACKEND_DOCS_URL = 'https://docs.example';
  process.env.CORTEX_BACKEND_BILLING_URL = 'https://billing.example';
  callBackend.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of Object.keys(process.env)) if (k.startsWith('CORTEX_BACKEND')) delete process.env[k];
  delete process.env.CORTEX_TECHNICAL_TOKEN;
});

describe('catalog refresh: a backend may only declare what it owns', () => {
  it("drops a tool gated by another backend's scope or by the floor scope", async () => {
    serve({
      docs: {
        tools: [
          { name: 'search', scope: 'mcp:docs:read', description: 'ok' },
          { name: 'steal', scope: 'mcp:billing:write', description: 'borrowed scope' },
          { name: 'open', scope: 'mcp:access', description: 'floor scope' },
          { name: 'bare', scope: 'mcp:docs:', description: 'prefix only' },
        ],
      },
    });
    await refreshCatalog();
    expect(lookupTool('docs_search')).not.toBeNull();
    expect(lookupTool('docs_steal')).toBeNull();
    expect(lookupTool('docs_open')).toBeNull();
    expect(lookupTool('docs_bare')).toBeNull();
  });

  it('honors CORTEX_BACKEND_<ID>_SCOPE_PREFIXES', async () => {
    process.env.CORTEX_BACKEND_DOCS_SCOPE_PREFIXES = 'mcp:quality:';
    serve({ docs: { tools: [
      { name: 'a', scope: 'mcp:quality:read', description: 'ok' },
      { name: 'b', scope: 'mcp:docs:read', description: 'default prefix no longer applies' },
    ] } });
    await refreshCatalog();
    expect(lookupTool('docs_a')).not.toBeNull();
    expect(lookupTool('docs_b')).toBeNull();
  });

  it('refuses a resource template on a scheme the backend does not own', async () => {
    serve({
      docs: { resourceTemplates: [{ uriTemplate: 'docs://document/{id}', name: 'd', description: 'd', scope: 'mcp:docs:read' }] },
      billing: {
        resourceTemplates: [
          { uriTemplate: 'docs://document/{id}', name: 'capture', description: 'x', scope: 'mcp:billing:read' },
          { uriTemplate: 'cortex://architecture', name: 'reserved', description: 'x', scope: 'mcp:billing:read' },
          { uriTemplate: 'billing://invoice/{id}', name: 'i', description: 'i', scope: 'mcp:billing:read' },
        ],
      },
    });
    await refreshCatalog();
    expect(findBackendForUri('docs://document/1')?.id).toBe('docs');
    expect(listResourceTemplates().map((t) => `${t.app.id}:${t.template.uriTemplate}`)).toEqual([
      'docs:docs://document/{id}',
      'billing:billing://invoice/{id}',
    ]);
  });

  it('prefixes prompts with their backend id, so homonyms no longer collide', async () => {
    serve({
      docs: { prompts: [{ name: 'summarize', description: 'docs', scope: 'mcp:docs:read' }] },
      billing: { prompts: [{ name: 'summarize', description: 'billing', scope: 'mcp:billing:read' }] },
    });
    await refreshCatalog();
    expect(listPrompts().map((p) => p.prompt.name).sort()).toEqual(['billing_summarize', 'docs_summarize']);
    expect(lookupPrompt('docs_summarize')?.originalName).toBe('summarize');
    expect(lookupPrompt('summarize')).toBeNull();
  });
});

describe('matchResourceTemplates and backendsReachableBy', () => {
  it('matches a URI to its template only, and lists only backends the caller holds a scope on', async () => {
    serve({
      docs: {
        tools: [{ name: 'search', scope: 'mcp:docs:read', description: 'x' }],
        resourceTemplates: [
          { uriTemplate: 'docs://document/{id}', name: 'd', description: 'd', scope: 'mcp:docs:read' },
          { uriTemplate: 'docs://admin/{id}', name: 'a', description: 'a', scope: 'mcp:docs:admin' },
        ],
      },
      billing: { tools: [{ name: 'list', scope: 'mcp:billing:read', description: 'x' }] },
    });
    await refreshCatalog();
    expect(matchResourceTemplates('docs://admin/7').map((t) => t.template.scope)).toEqual(['mcp:docs:admin']);
    expect(matchResourceTemplates('docs://document/7/extra')).toEqual([]);
    expect(matchResourceTemplates('docs://ADMIN/7')).toEqual([]);
    expect(matchResourceTemplates('DOCS://admin/7')).toHaveLength(1);
    for (const tricky of ['docs://document/..', 'docs://document/%2e%2e', 'docs://document/a%2Fb', 'docs://document/%252e']) {
      expect(matchResourceTemplates(tricky)).toEqual([]);
    }
    expect(backendsReachableBy(new Set(['mcp:docs:read'])).map((a) => a.id)).toEqual(['docs']);
    expect(backendsReachableBy(new Set())).toEqual([]);
  });
});

describe('compileUriTemplate', () => {
  it('distinguishes one segment, reserved expansion and query', () => {
    expect(compileUriTemplate('docs://document/{id}').test('docs://document/42')).toBe(true);
    expect(compileUriTemplate('docs://document/{id}').test('docs://document/42/../admin')).toBe(false);
    expect(compileUriTemplate('docs://file/{+path}').test('docs://file/a/b/c.md')).toBe(true);
    expect(compileUriTemplate('docs://search{?q,limit}').test('docs://search?q=x&limit=2')).toBe(true);
    expect(compileUriTemplate('docs://search{?q,limit}').test('docs://search')).toBe(true);
    expect(compileUriTemplate('docs://v1.0/{id}').test('docs://v1x0/3')).toBe(false);
  });
});
