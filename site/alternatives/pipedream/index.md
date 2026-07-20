<!-- https://cortex-gateway.dev/alternatives/pipedream/ -->

# Pipedream MCP alternative: own your gateway, your vault and your audit trail

**TL;DR**

Pipedream brings an enormous app catalog and hosted MCP endpoints on top of its automation platform — excellent when you want reach without infrastructure. **Cortex Gateway is the self-hosted alternative for the MCP access layer**: one OAuth 2.1 endpoint you operate, federating your own apps and third-party MCP servers, with per-user tokens encrypted in a vault you control. It does not replace Pipedream's workflows — it replaces the layer that holds credentials and decides what agents can do.

## Two different centers of gravity

**Pipedream** starts from integration breadth: thousands of connected apps, hosted triggers and workflows, and MCP endpoints that let agents reach that catalog with managed per-user auth. The platform operates everything — including the credential store.

**Cortex Gateway** starts from the access layer itself. It is a thin, spec-compliant MCP server (Streamable HTTP, MCP 2025-06-18) that hosts no business logic: it validates OAuth 2.1 tokens, filters the federated tool catalog by the caller's scopes, routes each call to the app that owns the tool, and writes a pseudonymized audit line. Identity always travels: first-party backends re-validate your JWT; proxied third-party MCP servers receive the calling user's own linked token.

## At a glance

|  | Cortex Gateway | Pipedream (MCP) |
| --- | --- | --- |
| Model | Open source (MIT), self-hosted | Hosted platform |
| Primary job | MCP access layer for your stack | App catalog + workflows, MCP on top |
| Catalog | Your apps + any MCP server (adapter, beta) | Thousands of ready-made apps |
| Credential custody | Your infra — AES-256-GCM vault | Their platform |
| Workflow engine | None (by design) | Yes, mature |
| Scope-based tool visibility | Built-in (scopes = entitlements) | Platform-managed |
| Audit | Your logs + optional PostgreSQL, retention you set | Platform logs |
| Cost | Free software + your VM | Platform pricing |

## Who should pick which

**Pick Cortex Gateway if** the tools that matter are your own products, your security review asks who holds user grants, you need EU/self-hosted data residency, or you want scope-tiered tool access (free vs pro) without writing paywall code.

**Pick Pipedream if** your need is breadth-first — many SaaS apps, event-driven workflows, zero ops — and hosted custody is acceptable. If you rely on its workflow engine, keep it: Cortex Gateway deliberately does not compete there.

Comparing self-hosted options rather than hosted platforms? See [open-source MCP gateways compared](/alternatives/open-source-mcp-gateways/) — seven projects, separated by whose credential reaches the downstream server.

## Using both

A common pattern: Cortex Gateway as the front door your agents authenticate to (identity, scopes, audit, your first-party tools) — and hosted connectors kept for long-tail SaaS until the adapter path covers them. One agent-facing URL, custody where it matters most first.

[Try Cortex Gateway →](https://github.com/wellknownmcp/cortex-gateway)

Or plug the [hosted demo](https://mcp.cortex-gateway.dev/) into [claude.ai](/connect/claude-ai/) in 30 seconds.

## FAQ

### Does Cortex Gateway run automations or scheduled jobs?

No. It is deliberately a gateway, not a runtime: agents bring the reasoning, backends bring the tools, the gateway brings identity, filtering and audit. Pair it with whatever scheduler or agent framework you already use.

### How hard is self-hosting it, honestly?

One Docker container (or a small Next.js deployment), an OAuth 2.1 issuer (a complete demo authorization server ships in the repo), and one env var per backend. The [deployment runbook](https://github.com/wellknownmcp/cortex-gateway/blob/main/docs/demo-deployment.md) takes about an hour on a fresh VM, TLS included.

### Is there a hosted version of Cortex Gateway?

Only a public demo for evaluation. The product stance is self-hosted — that is the point.
