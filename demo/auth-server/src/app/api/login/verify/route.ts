/**
 * Magic-link consumption.
 *
 * POST — consumes the link, creates the account on first sign-in, opens the
 * session and returns to where the user came from (the consent screen,
 * usually). POST and not GET on purpose: mail security scanners fetch every
 * link in an inbound email, and a GET would let them burn the link and credit
 * a sign-in nobody made. The confirmation page at /login/confirm submits here.
 *
 * GET — kept for links already in flight from an older build (and for anything
 * that pre-fetches). It redirects to the confirmation page and consumes
 * nothing.
 */

import { NextRequest, NextResponse } from 'next/server';
import { consumeMagicLink, createSession } from '@/lib/session';
import { getIssuer } from '@/lib/oauth/keys';

/** Local paths only — anything else is dropped (open-redirect guard). */
function safeReturnTo(raw: string): string {
  return raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
}

export async function GET(request: NextRequest) {
  const url = new URL(`${getIssuer()}/login/confirm`);
  const token = request.nextUrl.searchParams.get('token');
  const returnTo = request.nextUrl.searchParams.get('returnTo');
  if (token) url.searchParams.set('token', token);
  if (returnTo) url.searchParams.set('returnTo', returnTo);
  return NextResponse.redirect(url.toString(), 302);
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const token = typeof form.get('token') === 'string' ? String(form.get('token')) : '';
  const returnTo = safeReturnTo(typeof form.get('returnTo') === 'string' ? String(form.get('returnTo')) : '');

  if (!token) {
    return NextResponse.redirect(`${getIssuer()}/login?error=${encodeURIComponent('Missing token')}`, 302);
  }

  const userId = await consumeMagicLink(token);
  if (!userId) {
    return NextResponse.redirect(
      `${getIssuer()}/login?error=${encodeURIComponent('Link expired or already used — request a new one')}`,
      302,
    );
  }

  await createSession(userId);
  return NextResponse.redirect(`${getIssuer()}${returnTo}`, 302);
}
