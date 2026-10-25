import { describe, it, expect, afterEach } from 'vitest';
import { getClientIp } from '../rate-limit';

function req(xff?: string): Request {
  return new Request('https://mcp.example.com/mcp', { headers: xff ? { 'x-forwarded-for': xff, 'x-real-ip': '198.51.100.7' } : {} });
}

afterEach(() => {
  delete process.env.CORTEX_TRUSTED_PROXY_HOPS;
});

describe('getClientIp', () => {
  it('ignores forwarding headers unless trusted proxies are declared', () => {
    expect(getClientIp(req('203.0.113.1, 10.0.0.1'))).toBe('unknown');
  });

  it('takes the entry appended by the trusted proxy, not the client-supplied leftmost one', () => {
    process.env.CORTEX_TRUSTED_PROXY_HOPS = '1';
    // The client sent "1.2.3.4"; the proxy appended the address it saw.
    expect(getClientIp(req('1.2.3.4, 203.0.113.1'))).toBe('203.0.113.1');
    process.env.CORTEX_TRUSTED_PROXY_HOPS = '2';
    expect(getClientIp(req('1.2.3.4, 203.0.113.1, 10.0.0.1'))).toBe('203.0.113.1');
  });

  it('returns unknown when the chain is shorter than the declared proxies', () => {
    process.env.CORTEX_TRUSTED_PROXY_HOPS = '2';
    expect(getClientIp(req('1.2.3.4'))).toBe('unknown');
  });
});
