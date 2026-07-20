<!-- https://cortex-gateway.dev/connect/openclaw/ -->

# Connect OpenClaw to an MCP gateway with OAuth

OpenClaw's MCP client speaks Streamable HTTP with managed OAuth tokens (v1.5.0+). Three commands and your personal agent gets a governed, scope-filtered tool catalog — instead of raw API keys scattered in its config.

**TL;DR**

```
openclaw mcp add cortex \
  --url https://mcp.cortex-gateway.dev/mcp \
  --transport streamable-http \
  --auth oauth

openclaw mcp login cortex
openclaw mcp doctor --probe
```

## Steps

1.  **Add the server** with the command above (replace the URL with your own gateway's `/mcp` endpoint). Optional flags: `--timeout 20 --connect-timeout 5`.
2.  **Authenticate**: `openclaw mcp login cortex` opens the gateway's OAuth flow (magic-link signup on the public demo, then the consent screen). On a headless machine, use `openclaw mcp login cortex --code <authorization-code>` to paste the code back.
3.  **Verify**: `openclaw mcp doctor --probe` should show the server connected and list the federated tools (`demo_echo`, `demo_get_time`, `whoami`, ...).

## Equivalent JSON config

If you manage `openclaw.json` by hand:

```
{
  "mcp": {
    "servers": {
      "cortex": {
        "url": "https://mcp.cortex-gateway.dev/mcp",
        "transport": "streamable-http",
        "auth": "oauth",
        "timeout": 20,
        "connectTimeout": 5,
        "sslVerify": true
      }
    }
  }
}
```

OAuth tokens are stored by OpenClaw and refreshed automatically after `openclaw mcp login`.

## Why this pairing works well

OpenClaw is a personal, always-on agent — exactly the kind of client you don't want holding static API keys to everything. Behind a gateway, it holds a single short-lived OAuth token bound to *your* identity: every backend applies your permissions, the audit trail records what the agent actually did, and revoking the grant at the OAuth server cuts everything at once.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Add succeeds, login fails | Check the gateway's discovery answers: `curl https://mcp.cortex-gateway.dev/.well-known/oauth-protected-resource` must list the authorization server. |
| Probe shows 0 tools | Your account has none of the required scopes — call the `whoami` builtin to see what your token carries. |
| Old OpenClaw version | Streamable HTTP is primary from v1.5.0; earlier versions can use `--transport sse` (deprecated) or should upgrade. |

Self-hosting your own gateway: [github.com/wellknownmcp/cortex-gateway](https://github.com/wellknownmcp/cortex-gateway).
