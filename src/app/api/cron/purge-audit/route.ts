/**
 * Purge cron — /api/cron/purge-audit
 *
 * Deletes cortex_audit_trail rows past the retention window
 * (CORTEX_AUDIT_RETENTION_DAYS, default 365). The audit is pseudonymized
 * (hashed email/params, OAuth sub) — no cleartext PII — but volume and
 * retention are still bounded.
 *
 * Protected by CRON_SECRET (x-cron-secret header or ?secret= query param).
 * Call it daily from your scheduler.
 */

import { NextRequest } from 'next/server';
import { getPrismaCortex, isDatabaseConfigured } from '@/lib/prisma';

function retentionDays(): number {
  const raw = Number.parseInt(process.env.CORTEX_AUDIT_RETENTION_DAYS ?? '365', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 365;
}

export async function POST(request: NextRequest) {
  const secret = request.headers.get('x-cron-secret') || request.nextUrl.searchParams.get('secret');
  const expected = process.env.CRON_SECRET;
  // CRON_SECRET absent = refuse (no open deletion endpoint).
  if (!expected || secret !== expected) {
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

// GET supported for simple manual triggering
export async function GET(request: NextRequest) {
  return POST(request);
}
