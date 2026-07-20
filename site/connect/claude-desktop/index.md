<!-- https://cortex-gateway.dev/connect/claude-desktop/ -->

# Connect Claude Desktop to a remote MCP gateway with OAuth

Claude Desktop speaks remote MCP natively: point it at one gateway URL and OAuth discovery, client registration and token refresh are automatic.

**TL;DR**

Settings → Connectors → *Add custom connector* → `https://mcp.cortex-gateway.dev/mcp` → sign in + consent in the browser. Older versions without the Connectors UI: use the `mcp-remote` bridge in `claude_desktop_config.json` (below).

## Path A — Connectors UI (recommended)

1.  Open **Claude Desktop → Settings → Connectors**.
2.  Click **Add custom connector** and paste your gateway URL — for the public demo: `https://mcp.cortex-gateway.dev/mcp`.
3.  Your default browser opens the gateway's login (magic link on the demo) then the consent screen. Approve.
4.  Back in Claude Desktop, enable the connector. The tools menu now shows the federated catalog, filtered by your scopes.

## Path B — older versions: the mcp-remote bridge

Versions predating remote-connector support only launch local stdio servers from `claude_desktop_config.json`. The `mcp-remote` package bridges stdio to a remote OAuth-protected server:

```
{
  "mcpServers": {
    "cortex": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.cortex-gateway.dev/mcp"]
    }
  }
}
```

Config file locations: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS), `%APPDATA%\Claude\claude_desktop_config.json` (Windows). Restart Claude Desktop; the OAuth flow opens in your browser on first use.

## Verify it works

Ask Claude to call the gateway's `whoami` builtin. You should get your identity, your granted scopes, and the health of every federated backend — a one-call sanity check of the whole chain.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Browser never opens | Path B with an old Node: `npx mcp-remote` needs Node 18+. Run `node -v`. |
| 401 after some time | Access tokens are short-lived by design; the client refreshes silently. If it persists, remove and re-add the connector (forces a new grant). |
| Tools missing vs a teammate | Different scopes on your accounts — that's the gateway working as intended. Compare your `whoami` outputs. |

Self-hosting your own gateway: [github.com/wellknownmcp/cortex-gateway](https://github.com/wellknownmcp/cortex-gateway).
