/**
 * Configuration of the MCP→backend proxy adapter — fully env-driven, mirroring
 * the backend registry convention.
 *
 * - `CORTEX_MCP_SERVERS` : comma-separated ids of proxied native MCP servers
 * - `CORTEX_MCP_<ID>_URL` : the downstream MCP endpoint (e.g. https://mcp.canva.com/mcp)
 * - `CORTEX_MCP_<ID>_SCOPE` : Cortex scope assigned to ALL tools of this server
 *   (downstream tools declare no Cortex scope; default `mcp:<id>:read`)
 * - `CORTEX_MCP_<ID>_CLIENT_ID` / `_CLIENT_SECRET` : OAuth client at the
 *   downstream authorization server. Optional — when absent the adapter
 *   attempts Dynamic Client Registration (RFC 7591).
 * - `CORTEX_MCP_<ID>_OAUTH_SCOPE` : scope string requested at the downstream
 *   authorize step. Optional (provider default when absent).
 * - `CORTEX_MCP_<ID>_CATALOG_SUB` : sub of a linked account whose token is
 *   used for catalog discovery (list_tools) when the downstream MCP requires
 *   auth even to list tools. Typically: link your own/admin account first,
 *   then set this to your sub.
 *
 * Each proxied server is then federated like any backend, pointing back at
 * the gateway itself (loopback):
 *   CORTEX_BACKENDS=...,canva
 *   CORTEX_BACKEND_CANVA_URL=http://127.0.0.1:3213
 *   CORTEX_BACKEND_CANVA_PATH=/api/mcp-adapter/canva/backend
 */

export interface McpServerConfig {
  id: string;
  /** Downstream native MCP endpoint URL. */
  url: string;
  /** Cortex scope stamped on every tool of this server. */
  scope: string;
  /** Static OAuth client at the downstream AS (else DCR). */
  clientId?: string;
  clientSecret?: string;
  /** Scope string requested at the downstream authorize step. */
  oauthScope?: string;
  /** Linked-account sub used for catalog discovery when required. */
  catalogSub?: string;
}

export function loadMcpServers(): readonly McpServerConfig[] {
  const ids = (process.env.CORTEX_MCP_SERVERS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const seen = new Set<string>();
  const servers: McpServerConfig[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const idUpper = id.toUpperCase().replace(/-/g, '_');
    const url = process.env[`CORTEX_MCP_${idUpper}_URL`];
    if (!url) continue;
    servers.push({
      id,
      url: url.replace(/\/$/, ''),
      scope: process.env[`CORTEX_MCP_${idUpper}_SCOPE`] ?? `mcp:${id}:read`,
      clientId: process.env[`CORTEX_MCP_${idUpper}_CLIENT_ID`] || undefined,
      clientSecret: process.env[`CORTEX_MCP_${idUpper}_CLIENT_SECRET`] || undefined,
      oauthScope: process.env[`CORTEX_MCP_${idUpper}_OAUTH_SCOPE`] || undefined,
      catalogSub: process.env[`CORTEX_MCP_${idUpper}_CATALOG_SUB`] || undefined,
    });
  }
  return servers;
}

export function getMcpServer(id: string): McpServerConfig | null {
  return loadMcpServers().find((s) => s.id === id.toLowerCase()) ?? null;
}
