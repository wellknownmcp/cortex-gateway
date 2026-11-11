/** In-memory fixed-window rate limiter (single-instance demo server). */

interface Entry {
  count: number;
  resetAt: number;
}

const stores = new Map<string, Map<string, Entry>>();

export function checkRateLimit(
  storeName: string,
  key: string,
  maxRequests: number,
  windowMs: number,
): { allowed: boolean; retryAfterMs: number } {
  if (!stores.has(storeName)) stores.set(storeName, new Map());
  const store = stores.get(storeName)!;
  const now = Date.now();
  const entry = store.get(key);
  if (!entry || now >= entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterMs: 0 };
  }
  if (entry.count >= maxRequests) {
    return { allowed: false, retryAfterMs: entry.resetAt - now };
  }
  entry.count++;
  return { allowed: true, retryAfterMs: 0 };
}

/**
 * Client IP, for rate-limit keys. Forwarding headers are written by whoever
 * sends the request, so they are read only when the operator declares how
 * many trusted proxies sit in front (`AUTH_TRUSTED_PROXY_HOPS`, default 0).
 * Each proxy appends the address it received from, so the client is the entry
 * N positions from the right; anything further left is the caller's own
 * claim. The leftmost entry, read previously, let a caller pick its own
 * bucket — and walk around the per-subnet limit of the login form by sending
 * a different X-Forwarded-For each time.
 *
 * Without the variable every caller shares the bucket 'unknown': the limits
 * then apply to all callers together, which is strict but cannot be bypassed.
 */
export function getClientIp(request: Request): string {
  const hops = Number.parseInt(process.env.AUTH_TRUSTED_PROXY_HOPS ?? '0', 10);
  if (!Number.isFinite(hops) || hops <= 0) return 'unknown';
  const chain = (request.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Fewer entries than declared proxies: whatever is there was not written by
  // a proxy we trust.
  return chain.length >= hops ? chain[chain.length - hops] : 'unknown';
}

/** Truncates an IP for storage (/24 for IPv4, /48-ish for IPv6) — data minimization. */
export function truncateIp(ip: string | null): string | null {
  if (!ip) return null;
  if (ip.includes('.')) {
    const parts = ip.split('.');
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  }
  if (ip.includes(':')) {
    return ip.split(':').slice(0, 3).join(':') + '::';
  }
  return null;
}

if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const store of stores.values()) {
      for (const [key, entry] of store) {
        if (now >= entry.resetAt) store.delete(key);
      }
    }
  }, 5 * 60 * 1000);
}
