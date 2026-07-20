<!-- https://cortex-gateway.dev/alternatives/composio/ -->

# Composio alternative: a self-hosted MCP gateway with user-level permissions

**TL;DR**

Composio is a hosted tool platform: a large connector catalog, managed auth, fast to start — and your users' third-party tokens live on their infrastructure. **Cortex Gateway is the self-hosted counterpart**: an MIT-licensed MCP gateway you run yourself, where permissions are never copied — the gateway propagates the real user identity and each app enforces its own rules. Pick Composio for catalog breadth; pick Cortex Gateway for ownership, auditability and first-party apps.

## Why people look for a Composio alternative

Three reasons come up consistently:

**Token custody.** A hosted tool platform holds OAuth grants to your users' Gmail, Linear, Notion... For many teams (regulated industries, security-reviewed procurement, European data-residency requirements) that is the sticking point — not the product quality.

**Permission flattening.** Whenever an integration runs on an app-level API key or a shared service account, every agent inherits the same rights. What evaluators actually want is the property stated bluntly in a much-shared developer tweet: *an MCP gateway that matches the permissions of the underlying app automatically at the user level*.

**First-party tools.** Catalogs cover SaaS. Your own internal apps — the CRM you built, your billing service, your document store — still need a clean way to expose tools to agents with your existing authorization model.

## How Cortex Gateway answers

Cortex Gateway takes an architectural position: **never replicate permissions — delegate them**. Agents authenticate once against your OAuth 2.1 server; the gateway propagates identity downstream:

-   **Your own apps** implement a ~120-line plain-HTTP contract (no MCP library) and re-validate the same JWT. Their existing ACLs apply as-is.
-   **Third-party MCP servers** are federated through a proxy adapter: each user links their own account (OAuth, DCR, PKCE), tokens are stored encrypted in a vault *on your infrastructure*, and the provider enforces its native permissions on the real user.

Nothing to mirror, nothing to drift. Revoking a user at your OAuth server cuts every backend at once, and every call leaves a pseudonymized audit line.

## At a glance

|  | Cortex Gateway | Composio |
| --- | --- | --- |
| Model | Open source (MIT), self-hosted | Hosted platform |
| Connector catalog | Small: your apps + any MCP server via adapter (beta) | Very large, ready-made |
| Token custody | Your infrastructure (encrypted vault) | Their platform |
| Per-user auth | Yes — user-linked accounts, identity propagated | Yes — connected accounts |
| First-party app tools | Core use case (~120-line HTTP contract) | Possible via custom tools |
| Permission model | Delegated to each app, per user, by construction | Depends on integration and auth mode |
| Entitlements / plans | OAuth scopes = tiers, no paywall logic | Platform plans |
| Cost | Free software + your VM | Platform pricing |

## Who should pick which

**Pick Cortex Gateway if** you are an engineering team that wants agents on top of your own products, needs tokens and audit on your own infrastructure, sells tool access in tiers (scopes as entitlements), or must pass a security review where "who holds the grants?" is question one.

**Pick Composio if** you need dozens of SaaS integrations working this afternoon, have no infrastructure appetite, and a hosted trust model fits your compliance posture. That trade is legitimate — catalog breadth is exactly what a hosted platform is for.

Comparing self-hosted options rather than hosted platforms? See [open-source MCP gateways compared](/alternatives/open-source-mcp-gateways/) — seven projects, separated by whose credential reaches the downstream server.

## Migration path

The two can coexist: point your agent at Cortex Gateway for first-party tools and keep hosted connectors for the SaaS you haven't migrated. Then move providers one by one to the adapter — each user re-links their account once, and from that point the provider sees them, not a platform.

[Try Cortex Gateway →](https://github.com/wellknownmcp/cortex-gateway)

Or plug the [hosted demo](https://mcp.cortex-gateway.dev/) into [claude.ai](/connect/claude-ai/) in 30 seconds.

## FAQ

### Is Cortex Gateway a drop-in Composio replacement?

No — and we'd rather say it plainly. Composio's value is a huge ready-made catalog; Cortex Gateway's value is ownership and architecture. If your need is "500 connectors tomorrow", stay hosted. If your need is "our apps, our users, our audit", self-host.

### What about Merge.dev?

Merge is a unified-API product (one normalized API per category, e.g. HR or accounting) rather than an MCP tool platform — a different job. If agents are your interface, an MCP gateway is the more direct fit.

### What does "beta" mean for the MCP adapter?

The protocol layer is covered by unit tests against the MCP 2025-06-18 spec (Streamable HTTP, sessions, SSE framing, OAuth discovery, DCR, PKCE), but it has not yet been certified against specific commercial providers. First-party backends via the HTTP contract are the mature path.
