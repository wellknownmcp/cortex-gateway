import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isScopeAllowedFor, loadBackends } from '../registry';

describe('loadBackends', () => {
  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('CORTEX_BACKEND')) delete process.env[key];
    }
    delete process.env.CORTEX_BACKENDS;
    delete process.env.CORTEX_ALLOW_INSECURE_BACKENDS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CORTEX_ALLOW_INSECURE_BACKENDS;
  });

  it('returns an empty list when nothing is configured', () => {
    expect(loadBackends()).toEqual([]);
  });

  it('skips a backend reachable only over plaintext HTTP, keeping the others', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.CORTEX_BACKENDS = 'docs, billing';
    process.env.CORTEX_BACKEND_DOCS_URL = 'http://docs.example.com';
    process.env.CORTEX_BACKEND_BILLING_URL = 'https://billing.example.com';

    const backends = loadBackends();
    expect(backends.map((b) => b.id)).toEqual(['billing']);
    expect(console.error).toHaveBeenCalledOnce();
  });

  it('keeps a plaintext backend when the operator opted out explicitly', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.CORTEX_ALLOW_INSECURE_BACKENDS = 'true';
    process.env.CORTEX_BACKENDS = 'docs';
    process.env.CORTEX_BACKEND_DOCS_URL = 'http://docs.example.com';

    expect(loadBackends().map((b) => b.id)).toEqual(['docs']);
    expect(console.warn).toHaveBeenCalled();
  });

  it('builds backends from env vars with defaults', () => {
    process.env.CORTEX_BACKENDS = 'docs, billing';
    process.env.CORTEX_BACKEND_DOCS_URL = 'http://127.0.0.1:4001/';
    process.env.CORTEX_BACKEND_BILLING_URL = 'http://127.0.0.1:4002';
    process.env.CORTEX_BACKEND_BILLING_PATH = '/internal/cortex';
    process.env.CORTEX_BACKEND_BILLING_TIMEOUT_MS = '5000';

    const backends = loadBackends();
    expect(backends).toHaveLength(2);
    expect(backends[0]).toEqual({
      id: 'docs',
      baseUrl: 'http://127.0.0.1:4001',
      backendPath: '/api/cortex/backend',
      timeoutMs: 10_000,
      scopePrefixes: ['mcp:docs:'],
      uriSchemes: ['docs'],
    });
    expect(backends[1]).toEqual({
      id: 'billing',
      baseUrl: 'http://127.0.0.1:4002',
      backendPath: '/internal/cortex',
      timeoutMs: 5_000,
      scopePrefixes: ['mcp:billing:'],
      uriSchemes: ['billing'],
    });
  });

  it('skips backends without a URL', () => {
    process.env.CORTEX_BACKENDS = 'docs,ghost';
    process.env.CORTEX_BACKEND_DOCS_URL = 'http://127.0.0.1:4001';
    const backends = loadBackends();
    expect(backends.map((b) => b.id)).toEqual(['docs']);
  });

  it('dedupes ids and normalizes case', () => {
    process.env.CORTEX_BACKENDS = 'Docs,docs';
    process.env.CORTEX_BACKEND_DOCS_URL = 'http://127.0.0.1:4001';
    expect(loadBackends()).toHaveLength(1);
  });

  it('reads scope prefixes and URI schemes, never granting the reserved cortex scheme', () => {
    process.env.CORTEX_BACKENDS = 'docs';
    process.env.CORTEX_BACKEND_DOCS_URL = 'http://127.0.0.1:4001';
    process.env.CORTEX_BACKEND_DOCS_SCOPE_PREFIXES = 'mcp:quality:, mcp:docs:';
    process.env.CORTEX_BACKEND_DOCS_URI_SCHEMES = 'Quality,cortex';
    const [docs] = loadBackends();
    expect(docs.scopePrefixes).toEqual(['mcp:quality:', 'mcp:docs:']);
    expect(docs.uriSchemes).toEqual(['quality']);
  });
});

describe('isScopeAllowedFor', () => {
  const app = { id: 'docs', baseUrl: 'https://docs.example', backendPath: '/x' };
  it('defaults to the mcp:<id>: prefix and refuses a bare prefix or a non-string', () => {
    expect(isScopeAllowedFor(app, 'mcp:docs:read')).toBe(true);
    expect(isScopeAllowedFor(app, 'mcp:docs:')).toBe(false);
    expect(isScopeAllowedFor(app, 'mcp:access')).toBe(false);
    expect(isScopeAllowedFor(app, 'mcp:docsx:read')).toBe(false);
    expect(isScopeAllowedFor(app, undefined)).toBe(false);
  });
});
