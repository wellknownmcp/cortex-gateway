/**
 * Purge cron — /api/cron/purge-audit
 *
 * Deletes cortex_audit_trail rows past the retention window
 * (CORTEX_AUDIT_RETENTION_DAYS, default 365). The audit is pseudonymized
 * (hashed email/params, OAuth sub) — no cleartext PII — but volume and
 * retention are still bounded.
 *
 * Protected by CRON_SECRET, sent in the `x-cron-secret` header on a POST.
 * Not in the query string and not on GET: a URL ends up in proxy logs, browser
 * history and link previews, and one fetched link would have purged the audit.
 * Call it daily from your scheduler.
 */

import { NextRequest } from 'next/server';
import { getPrismaCortex, isDatabaseConfigured } from '@/lib/prisma';
import { safeEqual } from '@/lib/safe-equal';

function retentionDays(): number {
  const raw = Number.parseInt(process.env.CORTEX_AUDIT_RETENTION_DAYS ?? '365', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 365;
}

export async function POST(request: NextRequest) {
  // CRON_SECRET absent = refuse (no open deletion endpoint).
  if (!safeEqual(request.headers.get('x-cron-secret'), process.env.CRON_SECRET)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!isDatabaseConfigured()) {
    return Response.json({ success: true, deleted: 0, note: 'no database configured' });
  }

  try {
    const days = retentionDays();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const { count } = await getPrismaCortex().cortexAuditTrail.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return Response.json({ success: true, deleted: count, retentionDays: days, cutoff: cutoff.toISOString() });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.error('[cortex/cron] purge-audit failed', { error: msg });
    return Response.json({ error: msg }, { status: 500 });
  }
}
