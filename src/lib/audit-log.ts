/**
 * Audit trail of MCP calls.
 *
 * Dual write:
 *  - structured stdout (one JSON line, `_type: cortex_audit`) — real-time
 *    source, captured by your process manager, grep/jq-able.
 *  - `cortex_audit_trail` table (CORTEX_DATABASE_URL) — queryable source for
 *    investigation / compliance. Retention enforced by the purge-audit cron.
 *
 * The DB insert is fire-and-forget: it never blocks the MCP response and, if
 * the database is unavailable (or not configured), stdout remains the trace.
 * Pseudonymized by design: hashed email, hashed params, OAuth sub as pseudonym.
 */

import { createHash } from 'node:crypto';
import { getPrismaCortex, isDatabaseConfigured } from './prisma';

export interface AuditEntry {
  ts: string;
  caller_sub: string;
  caller_email_hash: string;
  caller_role: string;
  caller_pool: string;
  tool: string | null;
  method: string;
  target_app: string | null;
  scope_used: string | null;
  params_hash: string | null;
  response_size: number | null;
  latency_ms: number;
  success: boolean;
  error_code: string | null;
  protocol_version: string | null;
  origin: string | null;
  client_id: string;
  session_id: string | null;
  dev_bypass: boolean;
  /**
   * `tools/list`-specific metrics (only set for that method). They trace the
   * real context cost of the federated tool list and the effect of the
   * mitigations (backend filtering, search mode).
   *
   * - tools_listed: number of tools returned (after scope+backend filtering)
   * - tokens_estimate: rough token estimate of the tools/list JSON (chars/4,
   *   ±10% — enough for orders of magnitude and before/after comparisons)
   * - backends_filter: parsed X-Cortex-Backends header, null when absent
   */
  tools_listed?: number;
  tokens_estimate?: number;
  backends_filter?: string[] | null;
  /** tools/list mode: 'normal' (full schemas) | 'search' (compact + find_tools). */
  tool_mode?: 'normal' | 'search';
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

export function logAudit(entry: AuditEntry): void {
  // Structured stdout — real-time pipeline
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ _type: 'cortex_audit', ...entry }));
  // Non-blocking DB persistence (fire-and-forget) — adds no latency to the
  // response path and swallows its own errors (stdout remains the trace).
  if (isDatabaseConfigured()) {
    void persistAudit(entry);
  }
}

async function persistAudit(entry: AuditEntry): Promise<void> {
  try {
    await getPrismaCortex().cortexAuditTrail.create({
      data: {
        callerSub: entry.caller_sub,
        callerEmailHash: entry.caller_email_hash,
        callerRole: entry.caller_role ?? '',
        callerPool: entry.caller_pool ?? '',
        tool: entry.tool,
        method: entry.method,
        targetApp: entry.target_app,
        scopeUsed: entry.scope_used,
        paramsHash: entry.params_hash,
        responseSize: entry.response_size,
        latencyMs: entry.latency_ms,
        success: entry.success,
        errorCode: entry.error_code,
        protocolVersion: entry.protocol_version,
        origin: entry.origin,
        clientId: entry.client_id,
        sessionId: entry.session_id,
        devBypass: entry.dev_bypass,
        toolsListed: entry.tools_listed ?? null,
        tokensEstimate: entry.tokens_estimate ?? null,
        // Json?: undefined = NULL (passing `null` throws on a nullable Json field in Prisma)
        backendsFilter: entry.backends_filter ?? undefined,
        toolMode: entry.tool_mode ?? null,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[cortex_audit] DB persist failed (stdout audit kept):',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export function hashEmail(email: string): string {
  return email ? sha256(email.toLowerCase()) : 'anon';
}

export function hashParams(params: unknown): string | null {
  if (!params) return null;
  try {
    return sha256(JSON.stringify(params));
  } catch {
    return null;
  }
}
