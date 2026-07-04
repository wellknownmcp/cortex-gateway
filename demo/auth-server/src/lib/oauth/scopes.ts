/**
 * Scopes of the demo authorization server.
 *
 * Format: `mcp:{domain}:{level}`. Every scope must be listed here; unknown
 * scopes are silently filtered at consent time (RFC 6749 §3.3) — no error,
 * no info leak about which scopes exist.
 *
 * Demo tiering: users get `mcp:demo:read` at signup (see User.scopes default
 * in the Prisma schema). Grant `mcp:demo:write` to a user to demonstrate
 * scope-based tool visibility — the gateway filters tools/list accordingly,
 * with zero paywall logic anywhere.
 */

export const AVAILABLE_SCOPES = {
  'mcp:demo:read': 'Use the read-only demo tools (echo, get_time, get_help)',
  'mcp:demo:write': 'Use the demo write tools (pro tier demonstration)',
} as const;

export type Scope = keyof typeof AVAILABLE_SCOPES;

export const ALL_SCOPES = Object.keys(AVAILABLE_SCOPES) as Scope[];

/** Human-friendly label for the consent screen. */
export function describeScope(scope: string): string {
  return AVAILABLE_SCOPES[scope as Scope] ?? scope;
}

/** Parses a space-separated scope string (RFC 6749 §3.3). */
export function parseScopeString(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Silently filters out unknown scopes. */
export function filterValidScopes(requested: string[]): Scope[] {
  return requested.filter((s): s is Scope => s in AVAILABLE_SCOPES);
}

/** Checks `granted` ⊆ `allowed` (refresh may narrow scopes, never widen). */
export function isScopeSubset(granted: string[], allowed: string[]): boolean {
  const allowedSet = new Set(allowed);
  return granted.every((s) => allowedSet.has(s));
}
