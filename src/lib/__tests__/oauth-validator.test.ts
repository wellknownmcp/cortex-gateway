import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { canonicalUri, validateRequest } from '../oauth-validator';

function req(headers: Record<string, string>): Request {
  return new Request('http://localhost:3213/mcp', { method: 'POST', headers });
}

const ENV_KEYS = ['CORTEX_DEV_BYPASS_TOKEN', 'CORTEX_DEV_BYPASS_ROLE', 'CORTEX_CANONICAL_URI', 'OAUTH_ISSUER'];

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  process.env.CORTEX_DEV_BYPASS_TOKEN = 'dev-secret';
  process.env.OAUTH_ISSUER = 'https://auth.example';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('dev bypass', () => {
  it('accepts the secret from a direct loopback request, with no implicit role', async () => {
    const res = await validateRequest(req({ host: 'localhost:3213', 'x-dev-mode': 'dev-secret' }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.context.isDevBypass).toBe(true);
      expect(res.context.role).toBe('');
    }
  });

  it('refuses a Host that only starts like loopback', async () => {
    const res = await validateRequest(req({ host: 'localhost.attacker.example', 'x-dev-mode': 'dev-secret' }));
    expect(res.ok).toBe(false);
  });

  it('refuses a request that came through a proxy', async () => {
    const res = await validateRequest(req({ host: 'localhost', 'x-dev-mode': 'dev-secret', 'x-forwarded-for': '203.0.113.9' }));
    expect(res.ok).toBe(false);
  });

  it('refuses a wrong secret, and never activates in production', async () => {
    expect((await validateRequest(req({ host: 'localhost', 'x-dev-mode': 'dev-secreT' }))).ok).toBe(false);
    vi.stubEnv('NODE_ENV', 'production');
    process.env.CORTEX_CANONICAL_URI = 'https://mcp.example.com/mcp';
    expect((await validateRequest(req({ host: 'localhost', 'x-dev-mode': 'dev-secret' }))).ok).toBe(false);
  });
});

describe('canonicalUri', () => {
  it('falls back to localhost outside production only', () => {
    expect(canonicalUri()).toBe('http://localhost:3213/mcp');
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => canonicalUri()).toThrow(/CORTEX_CANONICAL_URI is required/);
    process.env.CORTEX_CANONICAL_URI = 'https://mcp.example.com/mcp';
    expect(canonicalUri()).toBe('https://mcp.example.com/mcp');
  });

  it('makes validateRequest answer 503, not throw, when missing in production', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('NODE_ENV', 'production');
    const res = await validateRequest(req({ host: 'mcp.example.com', authorization: 'Bearer x' }));
    expect(res).toMatchObject({ ok: false, status: 503 });
  });
});
