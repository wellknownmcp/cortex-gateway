/**
 * POST /api/login/request — creates the user if needed and sends a magic link.
 *
 * Anti-abuse: 3 requests / 15 min / email AND 10 / 15 min / IP. Always
 * responds identically whether the email exists or not (no enumeration).
 * returnTo is constrained to local paths (no open redirect).
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';
import { createMagicLink, deliverMagicLink, isValidEmail } from '@/lib/session';
import { getIssuer } from '@/lib/oauth/keys';

function backToLogin(params: Record<string, string>): NextResponse {
  const url = new URL(`${getIssuer()}/login`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url.toString(), { status: 302 });
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const email = typeof form.get('email') === 'string' ? String(form.get('email')).trim().toLowerCase() : '';
  const returnToRaw = typeof form.get('returnTo') === 'string' ? String(form.get('returnTo')) : '';
  // Local paths only — anything else is dropped (open-redirect guard).
  const returnTo = returnToRaw.startsWith('/') && !returnToRaw.startsWith('//') ? returnToRaw : null;

  if (!isValidEmail(email)) {
    return backToLogin({ error: 'Invalid email address', ...(returnTo ? { returnTo } : {}) });
  }

  const ipOk = checkRateLimit('login-ip', getClientIp(request), 10, 15 * 60_000).allowed;
  const emailOk = checkRateLimit('login-email', email, 3, 15 * 60_000).allowed;
  if (!ipOk || !emailOk) {
    // Same response as success — no signal for enumeration or abuse probing.
    return backToLogin({ sent: '1', ...(returnTo ? { returnTo } : {}) });
  }

  try {
    const link = await createMagicLink(email, returnTo);
    await deliverMagicLink(email, link);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[demo-auth] magic link delivery failed', err instanceof Error ? err.message : err);
  }

  return backToLogin({ sent: '1', ...(returnTo ? { returnTo } : {}) });
}
