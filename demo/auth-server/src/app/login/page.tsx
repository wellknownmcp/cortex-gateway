/**
 * GET /login — self-service magic-link sign-in.
 * First sign-in creates the demo account (scopes: mcp:demo:read).
 *
 * The form carries a honeypot field and a signed timestamp; both are checked
 * in /api/login/request. force-dynamic is load-bearing — a cached page would
 * hand every visitor the same stale token.
 */

import { HONEYPOT_FIELD, issueFormToken } from '@/lib/form-token';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string; sent?: string; error?: string }>;
}) {
  const { returnTo, sent, error } = await searchParams;
  const { issuedAt, signature } = issueFormToken();

  return (
    <main style={{ maxWidth: 460, margin: '80px auto', padding: '0 24px', fontFamily: 'system-ui, sans-serif' }}>
      <p style={{ color: '#888', fontSize: 13, letterSpacing: 1, textTransform: 'uppercase' }}>
        Cortex Gateway — demo authorization server
      </p>
      <h1 style={{ fontSize: 22 }}>Sign in</h1>
      {sent ? (
        <>
          <p>
            If the address is valid, a sign-in link is on its way. It expires in <strong>15 minutes</strong>.
          </p>
          <p style={{ color: '#666' }}>You can close this tab once you have clicked the link.</p>
        </>
      ) : (
        <>
          <p style={{ color: '#555' }}>
            Enter your email — the first sign-in creates your demo account. No password, ever.
          </p>
          {error ? <p style={{ color: '#b91c1c' }}>{error}</p> : null}
          <form method="POST" action="/api/login/request">
            <input type="hidden" name="returnTo" value={returnTo ?? ''} />
            <input type="hidden" name="ts" value={issuedAt} />
            <input type="hidden" name="sig" value={signature} />
            {/* Honeypot: never shown, never focusable, never announced. */}
            <div aria-hidden="true" style={{ position: 'absolute', left: -9999, top: 'auto', width: 1, height: 1, overflow: 'hidden' }}>
              <label htmlFor={HONEYPOT_FIELD}>Leave this field empty</label>
              <input id={HONEYPOT_FIELD} type="text" name={HONEYPOT_FIELD} tabIndex={-1} autoComplete="off" defaultValue="" />
            </div>
            <input
              type="email"
              name="email"
              required
              placeholder="you@example.com"
              autoComplete="email"
              style={{
                width: '100%',
                padding: '10px 12px',
                fontSize: 15,
                border: '1px solid #d1d5db',
                borderRadius: 6,
                marginBottom: 12,
                boxSizing: 'border-box',
              }}
            />
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
              Send me a sign-in link
            </button>
          </form>
        </>
      )}
    </main>
  );
}
