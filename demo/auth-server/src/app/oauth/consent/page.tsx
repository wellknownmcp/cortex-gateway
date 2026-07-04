/**
 * GET /oauth/consent — consent screen (server component).
 *
 * Reads the signed authorize-request JWT (?req=), requires a logged-in
 * session (redirects to /login otherwise), skips straight to code issuance
 * when a still-valid consent grant covers the requested scopes.
 *
 * Lives on the same host as the session cookie by design — a server
 * component cannot read a cross-domain cookie.
 */

import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { verifyAuthorizeRequest } from '@/lib/oauth/authorize-request';
import { describeScope } from '@/lib/oauth/scopes';
import { randomBase64url, sha256Hex } from '@/lib/oauth/crypto';
import { getSessionUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

const CODE_TTL_SECONDS = 10 * 60;

async function issueCodeAndBuildRedirect(
  claims: NonNullable<Awaited<ReturnType<typeof verifyAuthorizeRequest>>>,
  userId: string,
): Promise<string> {
  const code = randomBase64url(32);
  await prisma.oauthAuthorizationCode.create({
    data: {
      codeHash: sha256Hex(code),
      clientId: claims.client_db_id,
      userId,
      redirectUri: claims.redirect_uri,
      scopes: claims.scopes,
      codeChallenge: claims.code_challenge,
      codeChallengeMethod: 'S256',
      expiresAt: new Date(Date.now() + CODE_TTL_SECONDS * 1000),
    },
  });
  const url = new URL(claims.redirect_uri);
  url.searchParams.set('code', code);
  if (claims.state) url.searchParams.set('state', claims.state);
  return url.toString();
}

export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ req?: string; error?: string }>;
}) {
  const { req, error } = await searchParams;
  if (!req) {
    return <Shell title="Invalid request">Missing authorization request. Restart from your MCP client.</Shell>;
  }

  const claims = await verifyAuthorizeRequest(req);
  if (!claims) {
    return <Shell title="Request expired">The authorization request expired. Restart from your MCP client.</Shell>;
  }

  const user = await getSessionUser();
  if (!user) {
    redirect(`/login?returnTo=${encodeURIComponent(`/oauth/consent?req=${req}`)}`);
  }

  // Grant only what the user actually holds. A user without any of the
  // requested scopes can consent to nothing.
  const grantable = claims.scopes.filter((s) => user.scopes.includes(s));
  if (grantable.length === 0) {
    return (
      <Shell title="No matching permissions">
        Your demo account holds none of the permissions requested by {claims.client_name}.
      </Shell>
    );
  }

  // Skip-consent: a still-valid remembered grant covering all grantable scopes.
  const existing = await prisma.oauthConsentGrant.findUnique({
    where: { userId_clientId: { userId: user.id, clientId: claims.client_db_id } },
  });
  if (
    existing &&
    !existing.revokedAt &&
    existing.expiresAt > new Date() &&
    grantable.every((s) => existing.scopes.includes(s))
  ) {
    redirect(await issueCodeAndBuildRedirect({ ...claims, scopes: grantable }, user.id));
  }

  return (
    <Shell title="Authorization request">
      {error ? <p style={{ color: '#b91c1c' }}>{error}</p> : null}
      <p>
        <strong>{claims.client_name}</strong>
        {claims.client_uri ? (
          <>
            {' '}
            (<a href={claims.client_uri}>{new URL(claims.client_uri).hostname}</a>)
          </>
        ) : null}{' '}
        wants to access the Cortex Gateway demo as <strong>{user.email}</strong>:
      </p>
      <ul style={{ lineHeight: 1.8 }}>
        {grantable.map((s) => (
          <li key={s}>
            <code style={{ background: '#f3f4f6', padding: '1px 6px', borderRadius: 4 }}>{s}</code> —{' '}
            {describeScope(s)}
          </li>
        ))}
      </ul>
      <form method="POST" action="/oauth/consent/submit" style={{ marginTop: 24 }}>
        <input type="hidden" name="req" value={req} />
        <label style={{ display: 'block', marginBottom: 16, color: '#555' }}>
          <input type="checkbox" name="remember" value="1" defaultChecked /> Remember this decision for 30 days
        </label>
        <button name="decision" value="approve" style={btnPrimary}>
          Authorize
        </button>{' '}
        <button name="decision" value="deny" style={btnSecondary}>
          Deny
        </button>
      </form>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main style={{ maxWidth: 520, margin: '80px auto', padding: '0 24px', fontFamily: 'system-ui, sans-serif' }}>
      <p style={{ color: '#888', fontSize: 13, letterSpacing: 1, textTransform: 'uppercase' }}>
        Cortex Gateway — demo authorization server
      </p>
      <h1 style={{ fontSize: 22 }}>{title}</h1>
      {children}
    </main>
  );
}

const btnPrimary: React.CSSProperties = {
  background: '#111827',
  color: 'white',
  border: 'none',
  padding: '10px 22px',
  borderRadius: 6,
  fontSize: 15,
  cursor: 'pointer',
};

const btnSecondary: React.CSSProperties = {
  background: 'white',
  color: '#111827',
  border: '1px solid #d1d5db',
  padding: '10px 22px',
  borderRadius: 6,
  fontSize: 15,
  cursor: 'pointer',
};
