/**
 * Registry of the backend apps federated by the gateway — fully env-driven.
 *
 * Configuration:
 * - `CORTEX_BACKENDS` : comma-separated list of backend ids (e.g. "docs,billing")
 * - `CORTEX_BACKEND_<ID>_URL` : base URL of the backend (required per id)
 * - `CORTEX_BACKEND_<ID>_PATH` : backend endpoint path (default `/api/cortex/backend`)
 * - `CORTEX_BACKEND_<ID>_TIMEOUT_MS` : per-backend timeout (default 10000)
 * - `CORTEX_BACKEND_<ID>_SCOPE_PREFIXES` : CSV of scope prefixes the backend may
 *   declare (default `mcp:<id>:`)
 * - `CORTEX_BACKEND_<ID>_URI_SCHEMES` : CSV of URI schemes the backend may
 *   claim for resource templates (default `<id>`)
 *
 * A backend listed in CORTEX_BACKENDS with no `_URL` is silently skipped —
 * convenient for enabling backends progressively across environments.
 */

import type { BackendApp } from '@/contract';
import { acceptBackendUrl } from './secure-url';

/** Schemes the gateway serves itself; no backend may claim them. */
export const RESERVED_URI_SCHEMES: ReadonlySet<string> = new Set(['cortex']);

function csv(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function pick(id: string): BackendApp | null {
  const idUpper = id.toUpperCase().replace(/-/g, '_');
  const baseUrl = process.env[`CORTEX_BACKEND_${idUpper}_URL`];
  if (!baseUrl) return null;
  // Transport policy: the caller's bearer token is forwarded to this URL, so
  // plaintext to a remote host is refused (see lib/secure-url.ts).
  if (!acceptBackendUrl(baseUrl, `CORTEX_BACKEND_${idUpper}_URL`)) return null;
  const backendPath = process.env[`CORTEX_BACKEND_${idUpper}_PATH`] ?? '/api/cortex/backend';
  const timeoutRaw = process.env[`CORTEX_BACKEND_${idUpper}_TIMEOUT_MS`];
  const timeoutMs = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : 10_000;
  const scopePrefixes = csv(process.env[`CORTEX_BACKEND_${idUpper}_SCOPE_PREFIXES`]);
  const uriSchemes = csv(process.env[`CORTEX_BACKEND_${idUpper}_URI_SCHEMES`])
    .map((s) => s.toLowerCase())
    .filter((s) => !RESERVED_URI_SCHEMES.has(s));
  if (uriSchemes.length === 0 && !/^[a-z][a-z0-9+.-]*$/.test(id)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[cortex/registry] backend id '${id}' is not a valid URI scheme: its resource templates will be refused unless CORTEX_BACKEND_${idUpper}_URI_SCHEMES is set`,
    );
  }
  return {
    id,
    baseUrl: baseUrl.replace(/\/$/, ''),
    backendPath,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000,
    scopePrefixes: scopePrefixes.length > 0 ? scopePrefixes : [`mcp:${id}:`],
    uriSchemes: uriSchemes.length > 0 ? uriSchemes : [id],
  };
}

/** Scope prefixes a backend may declare (see BackendApp.scopePrefixes). */
export function scopePrefixesOf(app: BackendApp): readonly string[] {
  return app.scopePrefixes && app.scopePrefixes.length > 0 ? app.scopePrefixes : [`mcp:${app.id}:`];
}

/** URI schemes a backend may claim (see BackendApp.uriSchemes). */
export function uriSchemesOf(app: BackendApp): readonly string[] {
  return app.uriSchemes && app.uriSchemes.length > 0 ? app.uriSchemes : [app.id];
}

/**
 * True when `scope` is one this backend may declare. An empty or prefix-only
 * scope is refused: `mcp:docs:` alone would gate nothing an operator meant.
 */
export function isScopeAllowedFor(app: BackendApp, scope: unknown): boolean {
  if (typeof scope !== 'string') return false;
  return scopePrefixesOf(app).some((p) => scope.length > p.length && scope.startsWith(p));
}

/** Returns the list of configured, enabled backends. */
export function loadBackends(): readonly BackendApp[] {
  const ids = (process.env.CORTEX_BACKENDS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const seen = new Set<string>();
  const backends: BackendApp[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const app = pick(id);
    if (app) backends.push(app);
  }
  return backends;
}
