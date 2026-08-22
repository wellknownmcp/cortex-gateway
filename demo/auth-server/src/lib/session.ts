/**
 * Self-service login for the demo authorization server — magic links.
 *
 * Anyone can sign up with an email. The account is created when the link is
 * *clicked*, never when it is requested: the form is publicly reachable, so a
 * request only proves that someone typed an address, not that its owner wants
 * an account. With RESEND_API_KEY set the link is emailed; without it it is
 * printed to stdout — enough for local dev, NOT for a public deployment.
 *
 * Sending mail on an unauthenticated request is also a resource an abuser can
 * spend on someone else's behalf, hence the global daily budget below.
 *
 * Sessions: opaque 32-byte cookie token, SHA256-hashed in DB, 7 days,
 * host-only cookie (the consent screen lives on this same host).
 */

import { cookies } from 'next/headers';
import { prisma } from './prisma';
import { sha256Hex, randomBase64url } from './oauth/crypto';
import { getIssuer } from './oauth/keys';

const SESSION_COOKIE = 'demo_auth_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

/**
 * Ceiling on magic links sent in any 24h window, all senders combined. The
 * demo sees a handful of real sign-ins a day; anything above this is abuse
 * burning the domain's sending reputation. Counted in DB, not in memory, so a
 * restart does not hand an abuser a fresh budget.
 */
const MAX_LINKS_PER_DAY = 40;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email) && email.length <= 255;
}

/** Magic links sent in the last 24h, all senders combined. */
export async function dailyLinkBudgetLeft(): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const used = await prisma.magicLink.count({ where: { createdAt: { gt: since } } });
  return Math.max(0, MAX_LINKS_PER_DAY - used);
}

/**
 * Issues a magic link for an address. Deliberately does NOT create the user:
 * see consumeMagicLink(). Returns the URL to email.
 */
export async function createMagicLink(email: string, returnTo: string | null): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const token = randomBase64url(32);
  await prisma.magicLink.create({
    data: {
      tokenHash: sha256Hex(token),
      email: normalized,
      expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
    },
  });

  // Points at the confirmation page, not at the consuming endpoint: mail
  // security scanners follow links in emails, and a GET that signs you in
  // burns the link before its owner ever sees it.
  const url = new URL(`${getIssuer()}/login/confirm`);
  url.searchParams.set('token', token);
  if (returnTo) url.searchParams.set('returnTo', returnTo);
  return url.toString();
}

/** Sends the magic link by email (Resend) or logs it when no key is set. */
export async function deliverMagicLink(email: string, link: string): Promise<'email' | 'stdout'> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // eslint-disable-next-line no-console
    console.log(`[demo-auth] magic link for ${email.slice(0, 3)}***: ${link}`);
    return 'stdout';
  }
  const { Resend } = await import('resend');
  const resend = new Resend(apiKey);
  const from = process.env.AUTH_EMAIL_FROM ?? 'Cortex Demo <onboarding@resend.dev>';
  await resend.emails.send({
    from,
    to: email,
    subject: 'Your sign-in link — Cortex Gateway demo',
    html: `<p>Click to sign in to the Cortex Gateway demo:</p>
<p><a href="${link}">Sign in</a></p>
<p style="color:#888;font-size:13px">The link expires in 15 minutes. If you did not request it, ignore this email.</p>`,
  });
  return 'email';
}

/**
 * Checks a magic link without consuming it — lets the confirmation page tell
 * "expired link" apart from "ready to sign in" before the user clicks.
 */
export async function peekMagicLink(token: string): Promise<{ email: string } | null> {
  const record = await prisma.magicLink.findUnique({ where: { tokenHash: sha256Hex(token) } });
  if (!record || record.usedAt || record.expiresAt < new Date()) return null;
  return { email: record.email };
}

/**
 * Consumes a magic link and creates the account on first sign-in. Returns the
 * userId, or null if the link is unknown, expired or already used.
 *
 * The link is claimed with a conditional update: two concurrent clicks race on
 * the database and exactly one of them wins.
 */
export async function consumeMagicLink(token: string): Promise<string | null> {
  const record = await prisma.magicLink.findUnique({ where: { tokenHash: sha256Hex(token) } });
  if (!record || record.usedAt || record.expiresAt < new Date()) return null;

  const claimed = await prisma.magicLink.updateMany({
    where: { id: record.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count !== 1) return null;

  const now = new Date();
  const user = await prisma.user.upsert({
    where: { email: record.email },
    create: { email: record.email, lastLoginAt: now },
    update: { lastLoginAt: now },
  });
  return user.id;
}

/** Opens a session and sets the cookie. */
export async function createSession(userId: string): Promise<void> {
  const token = randomBase64url(32);
  await prisma.session.create({
    data: {
      tokenHash: sha256Hex(token),
      userId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_TTL_MS / 1000,
    path: '/',
  });
}

export interface SessionUser {
  id: string;
  email: string;
  scopes: string[];
}

/** Resolves the current session cookie to a user, or null. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256Hex(token) },
    include: { user: { select: { id: true, email: true, scopes: true } } },
  });
  if (!session || session.expiresAt < new Date()) return null;
  return session.user;
}
