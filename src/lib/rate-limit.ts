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

export function getClientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return request.headers.get('x-real-ip') || 'unknown';
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
