export default function HomePage() {
  return (
    <main style={{ maxWidth: 520, margin: '80px auto', padding: '0 24px', fontFamily: 'system-ui, sans-serif' }}>
      <p style={{ color: '#888', fontSize: 13, letterSpacing: 1, textTransform: 'uppercase' }}>
        Cortex Gateway — demo authorization server
      </p>
      <h1 style={{ fontSize: 22 }}>OAuth 2.1 issuer</h1>
      <p style={{ color: '#555' }}>
        This server issues the tokens protecting the Cortex Gateway demo. MCP clients discover it
        automatically — you normally never visit this page directly.
      </p>
      <ul style={{ lineHeight: 1.9, color: '#555' }}>
        <li>
          <code>/.well-known/oauth-authorization-server</code> — RFC 8414 metadata
        </li>
        <li>
          <code>/.well-known/jwks.json</code> — signing keys
        </li>
        <li>
          <code>/oauth/register</code> — Dynamic Client Registration
        </li>
        <li>
          <a href="/login">/login</a> — magic-link sign-in (first sign-in creates your demo account)
        </li>
      </ul>
      <p style={{ color: '#999', fontSize: 13 }}>
        <a href="https://github.com/wellknownmcp/cortex-gateway">github.com/wellknownmcp/cortex-gateway</a>
      </p>
    </main>
  );
}
