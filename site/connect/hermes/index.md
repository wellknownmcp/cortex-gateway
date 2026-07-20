<!-- https://cortex-gateway.dev/connect/hermes/ -->

# Connect Hermes Agent to an MCP gateway — two lines of YAML

Hermes Agent (Nous Research) ships a full OAuth 2.1 MCP client: dynamic client registration, PKCE, token refresh — all automatic. The config is the shortest of any client on this site.

**TL;DR**

```
# ~/.hermes/config.yaml
mcp_servers:
  cortex:
    url: "https://mcp.cortex-gateway.dev/mcp"
    auth: oauth
```

On first connect, Hermes prints an authorize URL and opens your browser. Sign in, approve — done.

## Steps

1.  **Declare the gateway** in `~/.hermes/config.yaml` under `mcp_servers` (block above — replace the URL with your own gateway's `/mcp` endpoint). If Hermes is running, reload with `/reload-mcp`.
2.  **Complete the OAuth flow**: Hermes handles discovery and Dynamic Client Registration against the gateway's authorization server, then waits for the callback on a local loopback port. On the public demo, sign in with a magic link (first sign-in creates your account) and approve the consent screen.
3.  **Verify**: ask Hermes to call the gateway's `whoami` tool — identity, scopes, and the health of every federated backend in one response. Tokens live in `~/.hermes/mcp-tokens/cortex.json` and refresh silently.

## Headless / remote machines

No local browser? Two supported options:

-   **Paste-back**: open the printed authorize URL anywhere, then paste the redirect URL back at the Hermes prompt.
-   **SSH port forwarding**: tunnel the loopback callback port — `ssh -N -L <port>:127.0.0.1:<port> host`.

## Note on Dynamic Client Registration

Cortex Gateway's demo authorization server accepts DCR (RFC 7591), so the minimal two-line config just works. If you self-host against an authorization server that rejects automatic registration, create the OAuth client manually and add it to the block:

```
mcp_servers:
  cortex:
    url: "https://mcp.your-domain.com/mcp"
    auth: oauth
    oauth:
      client_id: "<your-id>"
      client_secret: "<your-secret>"
```

Then run `hermes mcp login cortex`.

## Why this pairing works well

Hermes is a messaging-native agent that acts on your behalf across platforms — the sharpest case for user-level permissions. Behind a gateway, everything it does is bound to *your* OAuth identity: backends apply your rights, the audit trail shows what the agent did as you, and one revocation cuts it all.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Authorize URL printed but flow never completes | Loopback callback blocked (headless host) — use paste-back or SSH forwarding above. |
| 401 on every call after weeks | Refresh failed (grant revoked or rotated away). Delete `~/.hermes/mcp-tokens/cortex.json` and reconnect. |
| Fewer tools than expected | Scope filtering at the gateway — `whoami` shows your grants. |

Self-hosting your own gateway: [github.com/wellknownmcp/cortex-gateway](https://github.com/wellknownmcp/cortex-gateway).
