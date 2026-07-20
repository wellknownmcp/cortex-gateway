import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { reviewCatalog, isQuarantined, resetIntegrityState } from '@/lib/tool-integrity';
import type { CortexBackendTool, FederatedToolEntry } from '@/contract';

// The route triggers a catalog refresh after acknowledging; the real one talks
// to every backend over HTTP. We only assert that it is called.
const refreshCatalog = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/federator', () => ({ refreshCatalog }));

const { GET, POST } = await import('../tool-integrity/route');

const SECRET = 'admin-secret-value';
const APP = { id: 'docs', baseUrl: 'https://docs.example', backendPath: '/api/cortex/backend' };

function catalog(...tools: Array<Partial<CortexBackendTool> & { name: string }>) {
  const map = new Map<string, FederatedToolEntry>();
  for (const t of tools) {
    const tool = { scope: 'mcp:docs:read', description: 'Search.', ...t } as CortexBackendTool;
    map.set(tool.name, { app: APP, tool } as FederatedToolEntry);
  }
  return map;
}

function req(method: 'GET' | 'POST', opts: { secret?: string | null; body?: unknown } = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (opts.secret !== null) headers.set('x-cortex-admin-secret', opts.secret ?? SECRET);
  return new Request('https://gw.example/api/admin/tool-integrity', {
    method,
    headers,
    body: method === 'POST' ? JSON.stringify(opts.body ?? {}) : undefined,
  });
}

/** Puts `docs_search` in quarantine: approved once, then mutated in block mode. */
function quarantineDocsSearch() {
  process.env.CORTEX_TOOL_INTEGRITY_MODE = 'block';
  reviewCatalog(catalog({ name: 'docs_search', description: 'original' }), ['docs']);
  reviewCatalog(catalog({ name: 'docs_search', description: 'rewritten' }), ['docs']);
}

describe('/api/admin/tool-integrity', () => {
  beforeEach(() => {
    resetIntegrityState();
    refreshCatalog.mockClear();
    process.env.CORTEX_ADMIN_SECRET = SECRET;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CORTEX_ADMIN_SECRET;
    delete process.env.CORTEX_TOOL_INTEGRITY_MODE;
  });

  describe('authorization', () => {
    it('404s when no secret is configured — an unused admin surface stays invisible', async () => {
      delete process.env.CORTEX_ADMIN_SECRET;
      expect((await GET(req('GET'))).status).toBe(404);
      expect((await POST(req('POST', { body: { tool: 'docs_search' } }))).status).toBe(404);
    });

    it('401s on a wrong secret, and never falls back to open', async () => {
      expect((await GET(req('GET', { secret: 'wrong' }))).status).toBe(401);
      expect((await GET(req('GET', { secret: null }))).status).toBe(401);
      // A prefix of the real secret must not pass either (length is compared
      // before timingSafeEqual, which throws on a length mismatch).
      expect((await GET(req('GET', { secret: SECRET.slice(0, 5) }))).status).toBe(401);
    });

    it('does not acknowledge anything on an unauthorized call', async () => {
      quarantineDocsSearch();
      await POST(req('POST', { secret: 'wrong', body: { tool: 'docs_search' } }));
      expect(isQuarantined('docs_search')).toBe(true);
    });
  });

  describe('GET', () => {
    it('reports the quarantined tools with the fields that changed', async () => {
      quarantineDocsSearch();
      const body = await (await GET(req('GET'))).json();

      expect(body.mode).toBe('block');
      expect(body.quarantined).toHaveLength(1);
      expect(body.quarantined[0]).toMatchObject({
        tool: 'docs_search',
        app: 'docs',
        changed: ['description'],
      });
    });

    it('says so when the mode cannot quarantine anything', async () => {
      const body = await (await GET(req('GET'))).json();
      expect(body.mode).toBe('warn');
      expect(body.note).toMatch(/CORTEX_TOOL_INTEGRITY_MODE=block/);
    });
  });

  describe('POST', () => {
    it('clears the quarantine and refreshes so the tool comes back now', async () => {
      quarantineDocsSearch();

      const res = await POST(req('POST', { body: { tool: 'docs_search' } }));
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        acknowledged: 'docs_search',
        app: 'docs',
        changed: ['description'],
        quarantined: [],
      });
      expect(isQuarantined('docs_search')).toBe(false);
      expect(refreshCatalog).toHaveBeenCalledOnce();
    });

    it('adopts the acknowledged definition as the new baseline', async () => {
      quarantineDocsSearch();
      await POST(req('POST', { body: { tool: 'docs_search' } }));

      // The definition that was refused is now the approved one.
      const diff = reviewCatalog(catalog({ name: 'docs_search', description: 'rewritten' }), [
        'docs',
      ]);
      expect(diff.mutated).toEqual([]);
      expect(diff.quarantined).toEqual([]);
    });

    it('logs what was approved, on the same tag as the detection', async () => {
      quarantineDocsSearch();
      await POST(req('POST', { body: { tool: 'docs_search' } }));

      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('[cortex/tool-integrity]'),
        expect.objectContaining({ tool: 'docs_search', changed: ['description'] }),
      );
    });

    it('404s on a tool that is not quarantined', async () => {
      quarantineDocsSearch();
      const res = await POST(req('POST', { body: { tool: 'docs_read' } }));
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toMatchObject({ quarantined: ['docs_search'] });
      // The real quarantine is untouched.
      expect(isQuarantined('docs_search')).toBe(true);
      expect(refreshCatalog).not.toHaveBeenCalled();
    });

    it('400s on a missing or malformed tool name', async () => {
      expect((await POST(req('POST', { body: {} }))).status).toBe(400);
      expect((await POST(req('POST', { body: { tool: '' } }))).status).toBe(400);
      expect((await POST(req('POST', { body: { tool: 42 } }))).status).toBe(400);
    });
  });
});
