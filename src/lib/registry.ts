/**
 * Registry of the backend apps federated by the gateway — fully env-driven.
 *
 * Configuration:
 * - `CORTEX_BACKENDS` : comma-separated list of backend ids (e.g. "docs,billing")
 * - `CORTEX_BACKEND_<ID>_URL` : base URL of the backend (required per id)
 * - `CORTEX_BACKEND_<ID>_PATH` : backend endpoint path (default `/api/cortex/backend`)
 * - `CORTEX_BACKEND_<ID>_TIMEOUT_MS` : per-backend timeout (default 10000)
 *
 * A backend listed in CORTEX_BACKENDS with no `_URL` is silently skipped —
 * convenient for enabling backends progressively across environments.
 */

import type { BackendApp } from '@/contract';

function pick(id: string): BackendApp | null {
  const idUpper = id.toUpperCase().replace(/-/g, '_');
  const baseUrl = process.env[`CORTEX_BACKEND_${idUpper}_URL`];
  if (!baseUrl) return null;
  const backendPath = process.env[`CORTEX_BACKEND_${idUpper}_PATH`] ?? '/api/cortex/backend';
  const timeoutRaw = process.env[`CORTEX_BACKEND_${idUpper}_TIMEOUT_MS`];
  const timeoutMs = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : 10_000;
  return {
    id,
    baseUrl: baseUrl.replace(/\/$/, ''),
    backendPath,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10_000,
  };
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
