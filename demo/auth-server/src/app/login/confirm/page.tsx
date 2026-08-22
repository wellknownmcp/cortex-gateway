/**
 * GET /login/confirm?token= — the page a magic link points at.
 *
 * The link is NOT consumed here. Corporate mail filters (Defender Safe Links,
 * Proofpoint and friends) fetch every URL in an inbound email before the
 * recipient sees it; on this demo they accounted for the overwhelming majority
 * of "sign-ins". A GET that signs you in therefore burns the link before its
 * owner ever clicks, and credits a sign-in nobody performed. Requiring a POST
 * from this page separates the two: scanners follow links, they do not submit
 * forms.
 */

import { peekMagicLink } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function ConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; returnTo?: string }>;
}) {
  const { token, returnTo } = await searchParams;
  const link = token ? await peekMagicLink(token) : null;

  return (
    <main style={{ maxWidth: 460, margin: '80px auto', padding: '0 24px', fontFamily: 'system-ui, sans-serif' }}>
      <p style={{ color: '#888', fontSize: 13, letterSpacing: 1, textTransform: 'uppercase' }}>
        Cortex Gateway — demo authorization server
      </p>
      {link ? (
        <>
          <h1 style={{ fontSize: 22 }}>Confirm sign-in</h1>
          <p style={{ color: '#555' }}>
            You are about to sign in as <strong>{link.email}</strong>.
          </p>
          <form method="POST" action="/api/login/verify">
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="returnTo" value={returnTo ?? ''} />
            <button
              type="submit"
              style={{
                background: '#111827',
                color: 'white',
                border: 'none',
                padding: '10px 22px',
                borderRadius: 6,
                fontSize: 15,
                cursor: 'pointer',
              }}
            >
              Sign in
            </button>
          </form>
        </>
      ) : (
        <>
          <h1 style={{ fontSize: 22 }}>Link expired</h1>
          <p style={{ color: '#555' }}>
            This sign-in link is expired or has already been used. Links are valid for 15 minutes.
          </p>
          <p>
            <a href="/login">Request a new one</a>
          </p>
        </>
      )}
    </main>
  );
}
