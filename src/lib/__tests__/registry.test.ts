import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadBackends } from '../registry';

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
    });
    expect(backends[1]).toEqual({
      id: 'billing',
      baseUrl: 'http://127.0.0.1:4002',
      backendPath: '/internal/cortex',
      timeoutMs: 5_000,
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
});
