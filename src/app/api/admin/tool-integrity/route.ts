/**
 * Tool integrity admin — /api/admin/tool-integrity
 *
 * The operator half of the rug-pull control (see lib/tool-integrity.ts). In
 * `block` mode a tool whose definition changed after approval is quarantined,
 * and nothing could clear it: `acknowledgeTool()` existed with no caller. This
 * route is that caller.
 *
 *   GET  → what is quarantined, and why (which fields changed, when the
 *          approved definition was first seen)
 *   POST → acknowledge one tool by name: it leaves quarantine and its current
 *          definition becomes the approved one
 *
 * Deliberately NOT an MCP tool. Acknowledging a mutation is the human decision
 * the quarantine exists to force — exposing it in `tools/list` would let a
 * model clear a rug pull on its own, which inverts the control.
 *
 * Protected by CORTEX_ADMIN_SECRET (`x-cortex-admin-secret`), separate from
 * CRON_SECRET on purpose: purging audit rows past retention is maintenance,
 * re-approving a changed tool definition is a security decision, and a
 * scheduler's secret should not carry it. Secret absent = route disabled.
 *
 * Plain `Request`/`Response` rather than NextRequest/NextResponse: nothing here
 * needs Next's extensions, and staying on the Web API keeps the handlers
 * unit-testable without loading the framework runtime.
 */

import { timingSafeEqual } from 'node:crypto';
import {
  acknowledgeTool,
  integrityReport,
  quarantinedTools,
  integrityMode,
} from '@/lib/tool-integrity';
import { refreshCatalog } from '@/lib/federator';

function authorized(req: Request): boolean {
  const expected = process.env.CORTEX_ADMIN_SECRET ?? '';
  // No secret configured = no endpoint. Never fall back to open.
  if (!expected) return false;
  const provided = req.headers.get('x-cortex-admin-secret') ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Length first: timingSafeEqual throws on a mismatch.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 404 rather than 401 when the secret is unset: an unconfigured admin surface
 * should not advertise that it exists. A wrong secret gets 401 — the operator
 * configured this one and needs to tell the two cases apart.
 */
function reject(req: Request): Response | null {
  if (authorized(req)) return null;
  if (!process.env.CORTEX_ADMIN_SECRET) {
    return Response.json(
      { error: 'Not found', hint: 'Set CORTEX_ADMIN_SECRET to enable this endpoint.' },
      { status: 404 },
    );
  }
  return Response.json({ error: 'Unauthorized' }, { status: 401 });
}

export async function GET(req: Request): Promise<Response> {
  const denied = reject(req);
  if (denied) return denied;

  const report = integrityReport();

  // Surfaced because "block mode is on" and "approvals actually survive a
  // restart" are different claims, and only the second one makes the control
  // meaningful. An operator reading this should not have to infer it.
  const notes: string[] = [];
  if (report.mode === 'warn') {
    notes.push(
      'Mode is `warn`: mutations are reported and served, never quarantined. Set CORTEX_TOOL_INTEGRITY_MODE=block to enforce.',
    );
  }
  if (!report.baselineFile) {
    notes.push(
      'No CORTEX_TOOL_BASELINE_FILE: the baseline is in-memory, so restarting the gateway re-approves every current definition.',
    );
  }
  if (report.degraded) {
    notes.push(
      `Baseline store unusable (${report.degraded}). Repair or deliberately remove the file, then restart.`,
    );
  }
  if (report.baselineFile && report.signing === 'none') {
    notes.push(
      'Baseline is unsigned: anyone who can write the file can forge an approval. Set CORTEX_BASELINE_PRIVATE_KEY, or CORTEX_BASELINE_PUBLIC_KEY with offline signing.',
    );
  }
  if (report.signing === 'self-signed') {
    notes.push(
      'Self-signed: the gateway holds the private key, so a host compromise can still forge an approval. Move to offline signing (public key only) to close that.',
    );
  }

  return Response.json({
    mode: report.mode,
    trackedTools: report.trackedTools,
    quarantined: report.quarantined,
    baselineFile: report.baselineFile,
    signing: report.signing,
    degraded: report.degraded,
    notes: notes.length ? notes : undefined,
  });
}

export async function POST(req: Request): Promise<Response> {
  const denied = reject(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const tool = (body as { tool?: unknown } | null)?.tool;
  if (typeof tool !== 'string' || tool.length === 0) {
    return Response.json(
      { error: 'Missing "tool": the federated tool name to acknowledge.' },
      { status: 400 },
    );
  }

  // Captured before acknowledging — recording what was approved is the point
  // of the log line below, and it is gone once the quarantine clears.
  const pending = quarantinedTools().find((m) => m.tool === tool);
  if (!acknowledgeTool(tool)) {
    return Response.json(
      { error: `Not quarantined: ${tool}`, quarantined: quarantinedTools().map((m) => m.tool) },
      { status: 404 },
    );
  }

  // Same log tag as the detection, so one grep shows a mutation and its
  // acknowledgement side by side. Not routed through logAudit(): that record is
  // shaped around an authenticated MCP call, and this is an operator action
  // with no OAuth identity — filling those fields would be fiction.
  // eslint-disable-next-line no-console
  console.warn('[cortex/tool-integrity] quarantine acknowledged by operator', {
    tool,
    app: pending?.app,
    changed: pending?.changed,
    approvedSince: pending?.firstSeenAt,
  });

  // Bring the tool back now instead of at the next 60s tick, and let the
  // refresh push tools/list_changed so clients re-read the definition they
  // are about to be served.
  await refreshCatalog();

  return Response.json({
    acknowledged: tool,
    app: pending?.app ?? null,
    changed: pending?.changed ?? [],
    mode: integrityMode(),
    quarantined: quarantinedTools().map((m) => m.tool),
  });
}
