<!-- https://cortex-gateway.dev/alternatives/zapier-mcp/ -->

# Zapier MCP alternative: a self-hosted MCP gateway with user-level permissions

**TL;DR**

Zapier MCP is the fastest way to put 9,000+ SaaS apps behind an agent: hosted, zero setup, credentials managed by Zapier — and **each tool call consumes two tasks from your plan quota**. **Cortex Gateway is the self-hosted counterpart**: an MIT-licensed MCP gateway you run yourself, with your own token vault, your own audit trail, no per-call billing, and permissions enforced by each application on the real user's identity. Pick Zapier for catalog breadth and time-to-first-tool; pick Cortex for credential custody, per-user attribution and your own applications.

Facts about Zapier MCP below are taken from [zapier.com/mcp](https://zapier.com/mcp), checked 16 August 2026: 9,000+ apps, 30,000+ actions, included in Zapier plans with each tool call consuming two tasks, SOC 2 Type II, actions logged in the account's History tab. Corrections welcome as a GitHub issue.

## Why people look for a Zapier MCP alternative

**Per-call economics.** Two tasks per tool call is a fine deal for a workflow that fires when an invoice arrives. It is a different deal for an agent, because agents explore: listing, retrying, reading before writing. A single conversation can burn dozens of calls, so the bill tracks the agent's chattiness, not the work accomplished. Self-hosted, a tool call costs what your VM costs.

**Credential custody.** Zapier executes actions through app connections it stores — Gmail, Slack, your CRM. They have done this credibly for a decade, and are SOC 2 Type II audited. But for regulated teams, security-reviewed procurement or European data-residency requirements, "a third party holds standing OAuth grants to our systems" is the sticking point, independent of how well it is done.

**Account shape.** An endpoint is tied to a Zapier account and its connections. One person, one account: clean. An organization must either share an endpoint — shared credentials, pooled quota, actions attributed to the account, not the person — or run one Zapier account per user. The [per-user attribution](/answers/agent-permission-layer/) an audit needs is structurally hard to get.

**Your own applications.** The catalog covers SaaS. The CRM you built, your billing service, your internal document store are not in it — and they are usually where agent access creates the most value.

## How Cortex Gateway answers

Cortex Gateway takes an architectural position: **never replicate permissions — delegate them**. Agents authenticate once against your OAuth 2.1 server; the gateway propagates identity downstream:

-   **Your own apps** implement a [~120-line plain-HTTP contract](/guides/rest-api-to-mcp-server/) (no MCP library) and re-validate the same JWT. Their existing ACLs apply as-is.
-   **Third-party MCP servers** federate through a [proxy adapter](/guides/federate-third-party-mcp-servers/): each user links their own account (OAuth, DCR, PKCE), tokens are stored AES-256-GCM-encrypted *on your infrastructure*, and the provider enforces its native permissions on the real user.
-   **Third-party APIs without an MCP server** get a thin [integration backend](/guides/github-app-mcp-backend/) — the GitHub App pattern: zero seats, machine credentials confined to one backend, attribution signed in your layer.

Every call writes one attributable audit line, and revoking a user at your OAuth server cuts every backend at once.

## At a glance

|  | Cortex Gateway | Zapier MCP |
| --- | --- | --- |
| Model | Open source (MIT), self-hosted | Hosted service, part of Zapier plans |
| Catalog | Your apps + any MCP server via adapter (beta) + API wrappers | 9,000+ apps, 30,000+ actions, ready-made |
| Cost per tool call | None — free software, your VM | Two tasks from the plan quota |
| Credential custody | Your infrastructure (encrypted vault) | Zapier's platform |
| Multi-user shape | One endpoint, each caller's own identity propagated | Endpoint tied to a Zapier account and its connections |
| Attribution | Per person, per call, pseudonymized audit trail | Account's History tab |
| First-party app tools | Core use case (~120-line HTTP contract) | Not the target — catalog is SaaS |
| Setup | Docker + an OAuth 2.1 authorization server (demo AS included) | Minutes, no terminal, no config files |

## Who should pick which

**Pick Zapier MCP if** you need SaaS integrations working this afternoon, run no infrastructure, and a hosted trust model fits your compliance posture. For a solo operator automating their own accounts it is the fastest path by a wide margin, and nothing self-hosted competes with the catalog.

**Pick Cortex Gateway if** agents will call tools at volume (per-call billing compounds), your security review asks "who holds the grants?", you need per-person attribution across a team behind one endpoint, or the applications that matter most are the ones you built.

Evaluating other hosted platforms? See the [Composio](/alternatives/composio/) and [Pipedream](/alternatives/pipedream/) comparisons. Comparing self-hosted options instead: [open-source MCP gateways compared](/alternatives/open-source-mcp-gateways/).

## Migration path

The two coexist without friction: keep Zapier MCP for long-tail SaaS and point the same agent at Cortex Gateway for first-party tools and high-volume providers. Move providers one at a time to the adapter — each user re-links their account once, and from then on the provider sees them, their seat and their rate limits, not a platform.

[Try Cortex Gateway →](https://github.com/wellknownmcp/cortex-gateway)

Or plug the [hosted demo](https://mcp.cortex-gateway.dev/) into [claude.ai](/connect/claude-ai/) in 30 seconds.

## FAQ

### What is the best self-hosted alternative to Zapier MCP?

Cortex Gateway — an MIT-licensed, self-hosted MCP gateway: one OAuth 2.1-protected endpoint federating your own applications (via a ~120-line HTTP contract) and existing third-party MCP servers (via a proxy adapter with a per-user encrypted token vault). Credentials, audit trail and quota policy stay on your infrastructure; there is no per-call billing.

### Does Zapier MCP cost money per tool call?

It is included in Zapier plans rather than sold separately, but each tool call consumes **two tasks** from the plan's quota (zapier.com/mcp, checked August 2026). For agents that matters: one exploratory conversation can burn dozens of calls, so cost tracks chattiness rather than completed work.

### Can Zapier MCP be self-hosted?

No — the endpoint runs on Zapier's infrastructure and actions execute through app connections whose credentials Zapier stores. That design is what makes setup non-technical, and it is also the property that sends credential-custody-constrained teams looking for an alternative.

### Is Zapier MCP per-user?

The endpoint is tied to a Zapier account and its connected apps. One person: per-user by definition. An organization must share an endpoint (shared credentials, pooled quota, account-level attribution) or run an account per user. An identity-propagating gateway serves one endpoint where each caller's own identity and linked accounts reach every application.

### When is Zapier MCP the better choice?

When you need part of its 9,000-app catalog working in minutes with zero infrastructure, and a hosted, SOC 2 Type II-audited trust model fits your posture. On catalog breadth and time-to-first-tool, nothing on this site's [self-hosted comparison](/alternatives/open-source-mcp-gateways/) comes close, ours included.
