/**
 * POST /api/login/request — issues a magic link and emails it.
 *
 * This endpoint is unauthenticated and makes the server send mail to an
 * address the caller chooses, so it is treated as an abuse surface first and a
 * login form second. Four independent gates, cheapest first:
 *
 *   1. honeypot field — filled in by form-stuffing bots, never by a browser;
 *   2. signed form token — proves the POST followed a real GET of the page,
 *      and that a human-plausible delay elapsed;
 *   3. rate limits per /24 and per email — a single host rotating addresses,
 *      or a subnet rotating hosts, both hit a wall. Limiting per IP alone is
 *      useless: the farms that abuse this rotate within a handful of /24s;
 *   4. global daily budget — the backstop when everything else is bypassed.
 *      Beyond it nothing is sent, whoever asks.
 *
 * Failures answer exactly like a success: no enumeration, and no feedback
 * telling an abuser which gate they tripped. The single exception is a stale
 * form, where the user genuinely needs to know to reload.
 *
 * returnTo is constrained to local paths (no open redirect).
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, getClientIp, truncateIp } from '@/lib/rate-limit';
import { HONEYPOT_FIELD, verifyFormToken } from '@/lib/form-token';
import { createMagicLink, dailyLinkBudgetLeft, deliverMagicLink, isValidEmail } from '@/lib/session';
import { getIssuer } from '@/lib/oauth/keys';

/** Per /24, per hour. A real user needs one link, maybe two. */
const SUBNET_LIMIT = 3;
/** Per address, per hour. */
const EMAIL_LIMIT = 2;
const WINDOW_MS = 60 * 60_000;

function backToLogin(params: Record<string, string>): NextResponse {
  const url = new URL(`${getIssuer()}/login`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url.toString(), { status: 302 });
}

/** What a caller sees whether the link was sent, rate-limited or dropped. */
function pretendSent(returnTo: string | null): NextResponse {
  return backToLogin({ sent: '1', ...(returnTo ? { returnTo } : {}) });
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const email = typeof form.get('email') === 'string' ? String(form.get('email')).trim().toLowerCase() : '';
  const returnToRaw = typeof form.get('returnTo') === 'string' ? String(form.get('returnTo')) : '';
  // Local paths only — anything else is dropped (open-redirect guard).
  const returnTo = returnToRaw.startsWith('/') && !returnToRaw.startsWith('//') ? returnToRaw : null;

  // 1. Honeypot: off-screen field, empty for anyone using a browser.
  if (String(form.get(HONEYPOT_FIELD) ?? '').length > 0) {
    return pretendSent(returnTo);
  }

  // 2. Signed form token.
  const verdict = verifyFormToken(
    String(form.get('ts') ?? ''),
    String(form.get('sig') ?? ''),
  );
  if (verdict === 'expired') {
    return backToLogin({
      error: 'This form has been open too long — reload the page and try again',
      ...(returnTo ? { returnTo } : {}),
    });
  }
  if (verdict !== 'ok') {
    return pretendSent(returnTo);
  }

  if (!isValidEmail(email)) {
    return backToLogin({ error: 'Invalid email address', ...(returnTo ? { returnTo } : {}) });
  }

  // 3. Rate limits. The subnet is the meaningful unit, not the address.
  const ip = getClientIp(request);
  const subnet = truncateIp(ip) ?? ip;
  const subnetOk = checkRateLimit('login-subnet', subnet, SUBNET_LIMIT, WINDOW_MS).allowed;
  const emailOk = checkRateLimit('login-email', email, EMAIL_LIMIT, WINDOW_MS).allowed;
  if (!subnetOk || !emailOk) {
    return pretendSent(returnTo);
  }

  // 4. Global budget — survives restarts because it is counted in DB.
  try {
    if ((await dailyLinkBudgetLeft()) <= 0) {
      // eslint-disable-next-line no-console
      console.warn('[demo-auth] daily magic-link budget exhausted — dropping request');
      return pretendSent(returnTo);
    }
  } catch (err) {
    // A budget we cannot read is a budget we cannot honour: fail closed.
    // eslint-disable-next-line no-console
    console.error('[demo-auth] budget check failed', err instanceof Error ? err.message : err);
    return pretendSent(returnTo);
  }

  try {
    const link = await createMagicLink(email, returnTo);
    await deliverMagicLink(email, link);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[demo-auth] magic link delivery failed', err instanceof Error ? err.message : err);
  }

  return pretendSent(returnTo);
}
