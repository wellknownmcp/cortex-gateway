import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { insecureUrlReason, acceptBackendUrl } from '../secure-url';

describe('outbound transport policy', () => {
  beforeEach(() => {
    delete process.env.CORTEX_ALLOW_INSECURE_BACKENDS;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CORTEX_ALLOW_INSECURE_BACKENDS;
  });

  it('accepts https anywhere', () => {
    expect(insecureUrlReason('https://docs.example.com', 'X')).toBeNull();
  });

  it('accepts plaintext to loopback — the stdio bridge and local dev', () => {
    for (const url of ['http://localhost:3213', 'http://127.0.0.1:3213', 'http://[::1]:3213']) {
      expect(insecureUrlReason(url, 'X')).toBeNull();
    }
  });

  it('refuses plaintext to a remote host', () => {
    const reason = insecureUrlReason('http://docs.example.com', 'CORTEX_BACKEND_DOCS_URL');
    expect(reason).toContain('CORTEX_BACKEND_DOCS_URL');
    expect(reason).toContain('plaintext');
  });

  it('refuses a non-http(s) scheme', () => {
    expect(insecureUrlReason('file:///etc/passwd', 'X')).toContain('unsupported scheme');
  });

  it('refuses a malformed URL', () => {
    expect(insecureUrlReason('not-a-url', 'X')).toContain('not a valid absolute URL');
  });

  it('allows remote plaintext only behind the explicit opt-out, and warns', () => {
    process.env.CORTEX_ALLOW_INSECURE_BACKENDS = 'true';
    expect(insecureUrlReason('http://docs.example.com', 'X')).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it('acceptBackendUrl drops the offending backend instead of throwing', () => {
    expect(acceptBackendUrl('http://docs.example.com', 'X')).toBe(false);
    expect(acceptBackendUrl('https://docs.example.com', 'X')).toBe(true);
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});
