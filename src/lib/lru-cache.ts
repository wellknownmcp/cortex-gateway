/**
 * Minimal LRU cache with per-entry TTL.
 *
 * No external dependency. Map-based: JS Maps preserve insertion order, so
 * bumping an entry = delete + set (moves it to the back).
 *
 * Sufficient for simple needs (JWT introspection cache, ~10k entries).
 */

export interface LruCacheOptions {
  /** Maximum number of entries before the oldest is evicted. */
  maxEntries: number;
  /** Default TTL in ms. Can be overridden per `set` call. */
  defaultTtlMs?: number;
  /** Timestamp provider (testability). */
  now?: () => number;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class LruCache<K, V> {
  private readonly store = new Map<K, Entry<V>>();
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number;
  private readonly now: () => number;

  constructor(opts: LruCacheOptions) {
    if (opts.maxEntries <= 0) throw new Error('maxEntries must be > 0');
    this.maxEntries = opts.maxEntries;
    this.defaultTtlMs = opts.defaultTtlMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    // Bump: delete + set keeps insertion order (= LRU recency)
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): void {
    const ttl = ttlMs ?? this.defaultTtlMs;
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expiresAt: this.now() + ttl });
    if (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
  }

  delete(key: K): boolean {
    return this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}
