/**
 * GET /api/login/verify?token= — consumes a magic link, opens the session,
 * and returns to where the user came from (the consent screen, usually).
 */

import { NextRequest, NextResponse } from 'next/server';
import { consumeMagicLink, createSession } from '@/lib/session';
import { getIssuer } from '@/lib/oauth/keys';

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');
  const returnToRaw = request.nextUrl.searchParams.get('returnTo') ?? '';
  const returnTo = returnToRaw.startsWith('/') && !returnToRaw.startsWith('//') ? returnToRaw : '/';

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
