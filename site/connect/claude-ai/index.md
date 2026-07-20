<!-- https://cortex-gateway.dev/connect/claude-ai/ -->

# Connect claude.ai to an MCP gateway (Custom Connectors)

The fastest way to see a federated, permission-aware tool catalog inside Claude — on the web or in the mobile apps. Total time: about 30 seconds plus one login.

**TL;DR**

Settings → Connectors → *Add custom connector* → paste `https://mcp.cortex-gateway.dev/mcp` (or your own gateway URL) → sign in → approve. Done: Claude sees exactly the tools your scopes allow.

## Prerequisites

-   A claude.ai account on a plan that includes custom connectors (paid plans; on Team/Enterprise an admin may need to enable them).
-   An MCP gateway URL. No gateway yet? Use the public demo: `https://mcp.cortex-gateway.dev/mcp` — self-service signup, read-only demo tools.

## Steps

1.  **Open** claude.ai → Settings → **Connectors** → **Add custom connector**.
2.  **Paste the URL**: `https://mcp.cortex-gateway.dev/mcp`. Claude fetches `/.well-known/oauth-protected-resource`, finds the authorization server, and registers itself automatically (Dynamic Client Registration) — you configure nothing.
3.  **Sign in** when the login page opens. On the demo, enter your email and click the magic link you receive — the first sign-in creates your account.
4.  **Approve the consent screen** (you can remember the decision for 30 days).
5.  **Enable the connector** in a chat. Ask Claude: *"list your tools"* — you should see `demo_echo`, `demo_get_time`, `demo_get_help` plus the gateway builtins like `whoami`.

## What just happened (and why it matters)

Claude never received an API key. It obtained an OAuth token bound to *you*, with *your* scopes; the gateway filtered `tools/list` accordingly and will propagate your identity to every backend behind it. Two users connecting the same URL can see different tools — that is [scope-based entitlement](/), with no paywall code anywhere.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "Could not connect" right away | URL missing the `/mcp` path, or the gateway's `CORTEX_ALLOWED_ORIGINS` doesn't include `https://claude.ai`. |
| Login loop / consent never appears | The authorization server's `OAUTH_ISSUER` is misconfigured behind the reverse proxy — the authorize redirect must point at the public host. |
| Connected but no tools | Your account holds none of the scopes the backends require. Check with the `whoami` builtin. |

Self-hosting your own gateway: [deployment runbook](https://github.com/wellknownmcp/cortex-gateway/blob/main/docs/demo-deployment.md).
