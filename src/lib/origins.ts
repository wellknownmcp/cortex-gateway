/**
 * Origin header validation (anti DNS-rebinding, MCP spec §Security Warning).
 *
 * Local MCP clients (stdio proxies) send no Origin header: absent = OK.
 * Web-based connectors send their web origin (e.g. https://claude.ai).
 *
 * Configuration: `CORTEX_ALLOWED_ORIGINS` — comma-separated list of exact
 * origins (`https://claude.ai`) and/or wildcard hostname suffixes
 * (`*.example.com`, which also matches `example.com` itself).
 * In non-production, localhost origins are always allowed.
 */

interface ParsedRule {
  kind: 'exact' | 'suffix';
  value: string;
}

function parseRules(): ParsedRule[] {
  const raw = process.env.CORTEX_ALLOWED_ORIGINS ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      if (entry.startsWith('*.')) {
        return { kind: 'suffix' as const, value: entry.slice(2).toLowerCase() };
      }
      return { kind: 'exact' as const, value: entry.replace(/\/$/, '') };
    });
}

/** Returns true when the Origin is legitimate (or absent). */
export function isOriginAllowed(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;

  if (
    process.env.NODE_ENV !== 'production' &&
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  ) {
    return true;
  }

  let hostname: string;
  try {
    hostname = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }

  for (const rule of parseRules()) {
    if (rule.kind === 'exact' && origin.replace(/\/$/, '') === rule.value) return true;
    if (rule.kind === 'suffix' && (hostname === rule.value || hostname.endsWith('.' + rule.value))) {
      return true;
    }
  }

  return false;
}
