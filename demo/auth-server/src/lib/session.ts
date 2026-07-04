/**
 * Self-service login for the demo authorization server — magic links.
 *
 * Anyone can sign up with an email: the first magic-link request creates the
 * user (default scopes: mcp:demo:read). With RESEND_API_KEY set the link is
 * emailed; without it the link is printed to stdout — enough for local dev,
 * NOT for a public deployment (set the key there).
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email) && email.length <= 255;
}

/** Creates (or finds) the user and issues a magic link. Returns the URL. */
export async function createMagicLink(email: string, returnTo: string | null): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const user = await prisma.user.upsert({
    where: { email: normalized },
    create: { email: normalized },
    update: {},
  });

  const token = randomBase64url(32);
  await prisma.magicLink.create({
    data: {
      tokenHash: sha256Hex(token),
      userId: user.id,
      expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
    },
  });

  const url = new URL(`${getIssuer()}/api/login/verify`);
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

/** Consumes a magic link token; returns the userId or null. */
export async function consumeMagicLink(token: string): Promise<string | null> {
  const record = await prisma.magicLink.findUnique({ where: { tokenHash: sha256Hex(token) } });
  if (!record || record.usedAt || record.expiresAt < new Date()) return null;
  await prisma.$transaction([
    prisma.magicLink.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    prisma.user.update({ where: { id: record.userId }, data: { lastLoginAt: new Date() } }),
  ]);
  return record.userId;
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
