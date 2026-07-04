/**
 * Minimal status page — shows the gateway identity and the live state of the
 * federated backends. Not authenticated: it exposes backend ids and tool
 * counts only (no tool names, no data). Disable by removing this file or
 * fronting it with your proxy if even that is too much for your context.
 */

import { getCatalog, refreshCatalog } from '@/lib/federator';
import { loadBackends } from '@/lib/registry';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  let catalog = getCatalog();
  // Never-populated catalog (epoch) — force a sync refresh so the first
  // visit after boot does not show "everything unavailable".
  if (catalog.lastRefreshedAt.getTime() === 0) {
    await refreshCatalog();
    catalog = getCatalog();
  }

  const healthy = new Set(catalog.healthyApps);
  const toolsByApp = new Map<string, number>();
  for (const entry of catalog.tools.values()) {
    toolsByApp.set(entry.app.id, (toolsByApp.get(entry.app.id) ?? 0) + 1);
  }
  const backends = loadBackends();
  const serverName = process.env.CORTEX_SERVER_NAME ?? 'cortex-gateway';

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '48px 24px', color: '#111827' }}>
      <h1 style={{ fontSize: 28, marginBottom: 4, fontFamily: mono }}>{serverName}</h1>
      <p style={{ color: '#6b7280', marginTop: 0 }}>
        Federated MCP gateway — one OAuth-protected MCP server in front of{' '}
        {backends.length} backend{backends.length === 1 ? '' : 's'}.
      </p>
      <p style={{ color: '#6b7280' }}>
        MCP endpoint: <code>/mcp</code> · Discovery:{' '}
        <code>/.well-known/oauth-protected-resource</code>
      </p>
      <p style={{ color: '#6b7280' }}>
        To connect: point any MCP client at <code>/mcp</code> — the OAuth 2.1
        flow (RFC 9728 discovery, dynamic registration, PKCE) is automatic.
        Agent-readable overview: <a href="/llms.txt">/llms.txt</a>
      </p>

      <h2 style={{ fontSize: 18, marginTop: 32 }}>Backends</h2>
      {backends.length === 0 ? (
        <p style={{ color: '#6b7280' }}>
          No backend configured. Set <code>CORTEX_BACKENDS</code> and{' '}
          <code>CORTEX_BACKEND_&lt;ID&gt;_URL</code>.
        </p>
      ) : (
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th style={cell}>Backend</th>
              <th style={cell}>Status</th>
              <th style={cell}>Tools</th>
            </tr>
          </thead>
          <tbody>
            {backends.map((b) => (
              <tr key={b.id}>
                <td style={cell}>
                  <code>{b.id}</code>
                </td>
                <td style={cell}>{healthy.has(b.id) ? 'healthy' : 'unreachable'}</td>
                <td style={cell}>{toolsByApp.get(b.id) ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p style={{ color: '#6b7280', fontSize: 13, marginTop: 32 }}>
        {catalog.tools.size} federated tools · last discovery{' '}
        {catalog.lastRefreshedAt.getTime() === 0
          ? 'never'
          : catalog.lastRefreshedAt.toISOString()}
      </p>
      <p style={{ color: '#6b7280', fontSize: 13 }}>
        <a href="https://github.com/wellknownmcp/cortex-gateway">
          github.com/wellknownmcp/cortex-gateway
        </a>{' '}
        · <a href="https://cortex-gateway.dev/">cortex-gateway.dev</a>
      </p>
    </main>
  );
}

const mono =
  "ui-monospace, 'Cascadia Code', 'SF Mono', Menlo, Consolas, monospace";

const cell: React.CSSProperties = {
  border: '1px solid #e5e7eb',
  padding: '6px 10px',
  textAlign: 'left',
};
