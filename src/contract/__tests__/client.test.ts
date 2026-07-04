/**
 * Tests for `callBackend` — verifies error typing, in particular the critical
 * discrimination between a 403 for a missing OAuth scope and a 403 for an
 * application-level ACL refusal.
 *
 * Without this discrimination every backend 403 surfaces to the agent as
 * "insufficient scope" even when a domain handler refused for role/membership
 * reasons — a misleading message and a debugging nightmare.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  callBackend,
  CortexBackendError,
  CortexBackendUnauthorized,
  CortexBackendInsufficientScope,
  CortexBackendAclDenied,
  CortexBackendTimeout,
} from '../client';

const FAKE_OPTS = {
  baseUrl: 'http://test.local',
  backendPath: '/api/cortex/backend',
  method: 'list_files',
  bearerToken: 'fake-token',
};

function mockFetch(response: { status: number; body?: unknown; contentType?: string }) {
  const headers = new Headers();
  headers.set('content-type', response.contentType ?? 'application/json');
  return vi.fn().mockResolvedValue(
    new Response(response.body !== undefined ? JSON.stringify(response.body) : null, {
      status: response.status,
      headers,
    }),
  );
}

describe('callBackend — 403 discrimination', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws CortexBackendInsufficientScope when the body contains `required`', async () => {
    vi.stubGlobal('fetch', mockFetch({
      status: 403,
      body: { required: 'mcp:docs:write', method: 'create_audience' },
    }));
    await expect(callBackend({ ...FAKE_OPTS, method: 'create_audience' })).rejects.toMatchObject({
      name: 'CortexBackendInsufficientScope',
      status: 403,
      requiredScope: 'mcp:docs:write',
      method: 'create_audience',
    });
  });

  it('throws CortexBackendAclDenied on a 403 without `required` (application ACL)', async () => {
    // Typical case: a domain handler refuses because the caller lacks the
    // owner/editor role on the target resource. The caller does hold the
    // OAuth scope — this is not an OAuth problem.
    vi.stubGlobal('fetch', mockFetch({
      status: 403,
      body: { error: 'Audience creation restricted to workspace owners/editors' },
    }));
    const err: any = await callBackend({ ...FAKE_OPTS, method: 'create_audience' }).catch((e) => e as any);
    expect(err).toBeInstanceOf(CortexBackendAclDenied);
    expect(err).toBeInstanceOf(CortexBackendError); // hierarchy preserved
    expect(err.name).toBe('CortexBackendAclDenied');
    expect(err.status).toBe(403);
    expect(err.reason).toBe('Audience creation restricted to workspace owners/editors');
    // Guard rail: must NOT be confused with InsufficientScope
    expect(err).not.toBeInstanceOf(CortexBackendInsufficientScope);
  });

  it('throws CortexBackendAclDenied on a 403 without a JSON body', async () => {
    vi.stubGlobal('fetch', mockFetch({
      status: 403,
      contentType: 'text/plain',
      body: undefined,
    }));
    const err: any = await callBackend(FAKE_OPTS).catch((e) => e as any);
    expect(err).toBeInstanceOf(CortexBackendAclDenied);
    expect(err.reason).toBeUndefined();
  });
});

describe('callBackend — other HTTP errors', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws CortexBackendUnauthorized on 401', async () => {
    vi.stubGlobal('fetch', mockFetch({ status: 401, body: { error: 'token expired' } }));
    const err: any = await callBackend(FAKE_OPTS).catch((e) => e as any);
    expect(err).toBeInstanceOf(CortexBackendUnauthorized);
    expect(err.status).toBe(401);
  });

  it('throws generic CortexBackendError on 500', async () => {
    vi.stubGlobal('fetch', mockFetch({ status: 500, body: { error: 'oops' } }));
    const err: any = await callBackend(FAKE_OPTS).catch((e) => e as any);
    expect(err).toBeInstanceOf(CortexBackendError);
    expect(err).not.toBeInstanceOf(CortexBackendInsufficientScope);
    expect(err).not.toBeInstanceOf(CortexBackendAclDenied);
    expect(err.status).toBe(500);
  });

  it('throws CortexBackendError on 400 with payload', async () => {
    vi.stubGlobal('fetch', mockFetch({ status: 400, body: { error: 'bad params' } }));
    const err: any = await callBackend(FAKE_OPTS).catch((e) => e as any);
    expect(err.status).toBe(400);
    expect(err.body).toEqual({ error: 'bad params' });
  });
});

describe('callBackend — success', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the parsed payload on 200', async () => {
    const payload = { files: [{ id: 'f1', name: 'doc.md' }] };
    vi.stubGlobal('fetch', mockFetch({ status: 200, body: payload }));
    const res = await callBackend<{ files: unknown[] }>(FAKE_OPTS);
    expect(res).toEqual(payload);
  });

  it('propagates the user context as X-Cortex-* headers', async () => {
    const fetchMock = mockFetch({ status: 200, body: {} });
    vi.stubGlobal('fetch', fetchMock);
    await callBackend({
      ...FAKE_OPTS,
      userContext: {
        userId: 'u1',
        email: 'user@example.com',
        role: 'admin',
        pool: 'staff',
        scopes: ['mcp:docs:read', 'mcp:docs:write'],
      },
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['X-Cortex-User-Id']).toBe('u1');
    expect(init.headers['X-Cortex-User-Email']).toBe('user@example.com');
    expect(init.headers['X-Cortex-Scopes']).toBe('mcp:docs:read mcp:docs:write');
  });
});

describe('callBackend — timeout', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws CortexBackendTimeout when fetch aborts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }));
    const err: any = await callBackend({ ...FAKE_OPTS, timeoutMs: 10 }).catch((e) => e as any);
    expect(err).toBeInstanceOf(CortexBackendTimeout);
  });
});
