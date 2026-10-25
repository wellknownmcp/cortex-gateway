/**
 * In-memory fixed-window rate limiter (per process).
 *
 * Good enough for a single-instance gateway. If you run multiple instances,
 * replace with a shared store (Redis) or rate-limit at the proxy.
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const stores = new Map<string, Map<string, RateLimitEntry>>();

function getStore(name: string): Map<string, RateLimitEntry> {
  if (!stores.has(name)) stores.set(name, new Map());
  return stores.get(name)!;
}

export function checkRateLimit(
  storeName: string,
  key: string,
  maxRequests: number,
  windowMs: number,
): RateLimitResult {
  // Opt-in escape hatch for test environments. Never set in production.
  if (process.env.RATE_LIMIT_DISABLED === 'true') {
    return { allowed: true, remaining: maxRequests, retryAfterMs: 0 };
  }

  const store = getStore(storeName);
  const now = Date.now();

  const entry = store.get(key);
  if (!entry || now >= entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxRequests - 1, retryAfterMs: 0 };
  }

  if (entry.count >= maxRequests) {
    return { allowed: false, remaining: 0, retryAfterMs: entry.resetAt - now };
  }

  entry.count++;
  return { allowed: true, remaining: maxRequests - entry.count, retryAfterMs: 0 };
}

/**
 * Client IP, for rate-limit keys only. Forwarding headers are written by
 * whoever sends the request, so they are read only when the operator declares
 * how many trusted proxies sit in front (`CORTEX_TRUSTED_PROXY_HOPS`, default
 * 0). Each proxy appends the address it received from, so the client is the
 * entry N positions from the right; anything further left is the caller's own
 * claim. The leftmost entry, read previously, let a client pick its own bucket.
 */
export function getClientIp(request: Request): string {
  const hops = Number.parseInt(process.env.CORTEX_TRUSTED_PROXY_HOPS ?? '0', 10);
  if (!Number.isFinite(hops) || hops <= 0) return 'unknown';
  const chain = (request.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Fewer entries than declared proxies: whatever is there was not written by
  // a proxy we trust.
  return chain.length >= hops ? chain[chain.length - hops] : 'unknown';
}

/** Positive integer from the environment, or the default when unset or malformed. */
export function positiveIntEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  // NaN would disable a limit silently: `count >= NaN` is always false.
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Periodic cleanup of expired entries (every 5 min)
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
