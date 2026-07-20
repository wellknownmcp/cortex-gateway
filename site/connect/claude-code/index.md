<!-- https://cortex-gateway.dev/connect/claude-code/ -->

# Connect Claude Code to an MCP gateway — one command

Claude Code supports remote MCP servers over Streamable HTTP with built-in OAuth. Ideal for giving a coding agent governed access to your internal tools.

**TL;DR**

```
claude mcp add --transport http cortex https://mcp.cortex-gateway.dev/mcp
# then, inside a session:
/mcp   →  Authenticate  →  browser login + consent
```

## Steps

1.  **Add the server** (from any terminal):
    
    ```
    claude mcp add --transport http cortex https://mcp.cortex-gateway.dev/mcp
    ```
    
    Replace the URL with your own gateway. Add `--scope user` to make it available across all your projects, or leave the default for the current project only.
2.  **Authenticate**: start Claude Code, run `/mcp`, select *cortex* → *Authenticate*. The browser opens the gateway's login (magic link on the demo) and consent screen.
3.  **Verify**: ask Claude Code to call `whoami` — it returns your identity, granted scopes and the health of each federated backend.

## Why a gateway (not N servers) for coding agents

Claude Code loads every configured server's tool list into context. A gateway keeps that catalog governed (scope-filtered per user) and lets you trim it further: the `X-Cortex-Backends` header narrows the catalog to the backends you're working with, and the compact [search mode](https://github.com/wellknownmcp/cortex-gateway/blob/main/docs/tool-search-mode.md) cuts tools/list payloads by ~80% for programmatic use.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `claude mcp list` shows it, but calls fail with 401 | Not authenticated yet — run `/mcp` → Authenticate. Tokens are stored per user and refresh automatically afterwards. |
| Server unreachable | Check the URL ends with `/mcp` and that the gateway answers: `curl -si https://mcp.cortex-gateway.dev/mcp -X POST` should return 401 with a `WWW-Authenticate` header — that's healthy. |
| A tool you expect is missing | Scope filtering. `whoami` shows what your token carries. |

Self-hosting your own gateway: [github.com/wellknownmcp/cortex-gateway](https://github.com/wellknownmcp/cortex-gateway).
