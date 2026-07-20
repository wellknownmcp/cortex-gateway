<!-- https://cortex-gateway.dev/ -->

# One MCP server in front of all your apps — with each app's own permissions, per user

Cortex Gateway is an open-source, self-hosted MCP gateway. Agents connect to a single OAuth 2.1-protected URL; the gateway federates the tools of every app behind it and propagates the *real user identity* — so each app's native permission model applies automatically, at the user level. Nothing to mirror, nothing to sync, no service-account flattening: everyone hands their agent the keys with exactly their own rights.

**Zero-trust principles for AI agents** — the missing link between your IAM (who your users are, what they may do) and the MCP ecosystem (how agents call tools).

[Get started on GitHub →](https://github.com/wellknownmcp/cortex-gateway)

MIT-licensed · Docker image on GHCR · [hosted demo](https://mcp.cortex-gateway.dev/) you can plug into Claude in 30 seconds · [![Glama score: license A, quality A, maintenance B](/assets/glama-score.svg)](https://glama.ai/mcp/servers/wellknownmcp/cortex-gateway)

## How it works

```
[MCP agent: Claude Desktop / claude.ai / OpenClaw / Hermes / ...]
         │  HTTPS + OAuth 2.1 JWT (Bearer)
         ▼
[cortex-gateway]   ←— thin gateway, no business logic
         │  the SAME JWT propagated (RFC 8707)
         ▼
[your backends]    ←— domain owners, plain HTTP, own their ACLs
```

A **backend** is a dedicated MCP reduced to its essence: a tool catalog plus tool invocation over bare HTTP (~120-line contract, no MCP library). The transport and lifecycle machinery — initialize, sessions, SSE, version negotiation — lives once, in the gateway. Native third-party MCP servers federate through the built-in proxy adapter with a per-user encrypted token vault.

What does a company put behind its gateway first? Its steering layer. [Hoshin Kanri](https://hoshin.app) — a living X-Matrix with review cadences and an MCP server — is the reference steering backend: strategy as standing context for every agent in the company, scoped to each person's position.

## What you get

| Capability | How |
| --- | --- |
| User-level permissions, automatically | Identity propagation: your JWT to first-party backends, the user's own linked token to third-party MCP servers. The app that owns the permission enforces it. |
| Scope-filtered tool catalog | Agents only see (and can call) tools their token scopes allow. Scopes double as plan entitlements — free/pro tiers with zero paywall logic. |
| Live federation | Backends are polled every 60s; new tools appear without redeploying, with SSE `tools/list_changed` push. |
| Audit & revocation | One pseudonymized audit line per call; central OAuth revocation cuts every backend at once. |
| Context-efficient tools/list | Backend filtering + a compact search mode (~80% smaller payloads for programmatic agents). |

## Self-describing backends, built-in feedback loop

An MCP endpoint alone doesn't teach an agent your domain — tools say *what* can be called, not *why* or *in which order*. Cortex ships the "how and why" server-side, versioned with the app that owns it, instead of being rewritten in every client:

| Convention | What it does |
| --- | --- |
| `<app>_get_help(topic?)` | Each backend documents its own business: domain concepts, workflows, conventions, limits, examples. The gateway's server instructions tell every connected agent to prefer it over guessing. |
| `whoami` | The caller's effective role and capabilities, aggregated across backends — agents know what they can do before trying. |
| `report_missing_capability` | When an agent hits a gap, it files a ticket — deduplicated, triaged, optionally owned by the backend itself. Your backlog of unmet agent needs builds itself. |
| `list_cortex_tickets` | Agents see their own previous filings and follow triage status — no duplicate loops. |

Details in the [backend contract](https://github.com/wellknownmcp/cortex-gateway/blob/main/docs/backend-contract.md).

## Connect your client

[**claude.ai (web & mobile)**Custom Connectors — the 30-second path](/connect/claude-ai/) [**Claude Desktop**Remote MCP server with OAuth](/connect/claude-desktop/) [**Claude Code**CLI: one command, OAuth in the browser](/connect/claude-code/) [**OpenClaw**openclaw mcp add + oauth login](/connect/openclaw/) [**Hermes Agent**Two lines of YAML, DCR handled](/connect/hermes/)

## Guides

[**Expose your REST API as an MCP server**Why generating from OpenAPI disappoints — and the five-step alternative](/guides/rest-api-to-mcp-server/) [**Secure your MCP server with OAuth 2.1**The 401 challenge, audience binding, scopes vs RBAC, multi-tenancy](/guides/secure-mcp-with-oauth/) [**Federate third-party MCP servers**Per-user token vault — the provider sees their account, not yours](/guides/federate-third-party-mcp-servers/) [**Too many MCP tools**The catalog is re-sent every turn — measure it, then cut 80%](/answers/mcp-too-many-tools/)

## Troubleshooting

The failures that cost us weeks, written down so nobody pays for them twice.

[**The connector does nothing**Five causes, ranked — starting with the missing 401 challenge](/answers/mcp-connector-does-nothing/) [**Login, then 401, forever**Issuer and audience behind a reverse proxy](/answers/mcp-oauth-issuer-behind-proxy/) [**`tools/list` comes back empty**Scopes, cold-boot catalog, backend down — how to tell](/answers/mcp-tools-list-empty/) [**Get OAuth right the first time**The wiring these three pages presuppose](/guides/secure-mcp-with-oauth/)

## Go deeper

[**The permission layer for AI agents**How an agent proves it acts for a real person](/answers/agent-permission-layer/) [**MCP gateway vs MCP server**Three archetypes — and what each does with identity](/answers/mcp-gateway-vs-mcp-server/) [**Compliance controls for agent access**ISO 27001 and SOC 2 apply today — the EU AI Act probably doesn't](/answers/ai-agent-compliance-controls/) [**MCP security best practices**Six threat categories — and which recommendations no client implements yet](/answers/mcp-security-best-practices/) [**Company federation, worked example**One app per department, one connector for the org](/use-cases/company-federation/) [**The backend contract**One POST endpoint, ~120 lines, no MCP library](https://github.com/wellknownmcp/cortex-gateway/blob/main/docs/backend-contract.md) [**Open-source MCP gateways compared**Six projects, two axes — and where each one beats us](/alternatives/open-source-mcp-gateways/) [**Composio alternative**Self-hosted vs hosted tool platform](/alternatives/composio/) [**Pipedream MCP alternative**Own your token vault and audit trail](/alternatives/pipedream/)

## FAQ

### How does Cortex Gateway keep agent access secure?

Every agent connects through an OAuth 2.1 perimeter — no shared API keys. The gateway propagates the *real user's identity* to each app, so that app's own permission model applies and there is no over-privileged service account (no permission flattening). Agents see only the tools their token scopes allow (least privilege); third-party credentials sit in a per-user AES-256-GCM vault; every call writes one pseudonymized audit line, and a single OAuth revocation cuts access everywhere at once. The gateway enforces nothing itself, so there is nothing new to trust.

### Does Cortex Gateway help with compliance (ISO 27001, SOC 2, the EU AI Act)?

It provides the technical controls those frameworks test for on automated access — turning agents from an ungoverned access path into a controlled one: least-privilege OAuth scopes, per-user identity (no shared over-privileged account), one pseudonymized audit line per call, and central revocation — a single attributable log and one kill-switch across all apps. It maps to ISO 27001:2022 access-control and logging controls (A.5.15, A.5.16, A.5.18, A.8.2, A.8.15) and SOC 2 CC6/CC7, both of which apply *today*. The EU AI Act articles usually quoted at you — Art. 12 record-keeping, Art. 14 human oversight — govern *high-risk* systems only, and those obligations were deferred to December 2027 / August 2028; most internal agents aren't in scope, and a gateway is access infrastructure, not an AI system. Self-hosted, so the audit trail and token vault stay in your perimeter — no extra sub-processor in your SOC 2 scope. It doesn't certify you; it removes the "agents can't be scoped, attributed or revoked" finding. Full mapping: [AI agent compliance controls](/answers/ai-agent-compliance-controls/).

### Is Cortex Gateway Zero Trust, and how does it relate to IAM?

It applies zero-trust principles to agent access: no implicit trust from the network, every call authenticated as the *real user*, least-privilege scopes, and verification through the OAuth perimeter on each request. It isn't a full ZTNA product — it's the identity-and-access layer for agents. Think of it as the missing link between your **IAM** (who your users are, what they may do) and the **MCP ecosystem** (how agents call tools): Cortex carries each user's real identity and rights from your existing identity provider into every agent tool call, so the agent inherits exactly that user's access — nothing implied, nothing flattened.

### Is Cortex Gateway free?

Yes — MIT-licensed, self-hosted. You run it on your own infrastructure (a small VM or the [Docker image](https://github.com/wellknownmcp/cortex-gateway/pkgs/container/cortex-gateway)). There is no hosted plan and no usage billing.

### Does it work with any OAuth server?

Any OAuth 2.1 authorization server that issues RS256 JWTs with a JWKS endpoint works. The repo ships a complete demo authorization server (DCR, PKCE, magic-link signup) you can start from.

### Can it federate existing third-party MCP servers?

Yes, through the built-in MCP→backend proxy adapter (beta): it speaks real MCP downstream and holds per-user OAuth tokens in an AES-256-GCM vault, so providers see each user's own account — their seat, their rate limits, their permissions.

### Why not connect each MCP server separately?

Separate connectors keep native permissions too — that's the baseline, not the differentiator. What they don't give you: one consent surface, central revocation that cuts everything at once, a single pseudonymized audit trail, scopes that work as cross-app entitlements, and a tool catalog that doesn't flood the agent's context. Cortex keeps the per-user permission model of separate connectors with the operational surface of one.

### How is this different from Composio or Pipedream?

Those are hosted tool platforms with large connector catalogs. Cortex Gateway is self-hosted infrastructure: your token vault, your audit trail, your OAuth perimeter, and a tiny contract for your own apps. See the detailed [Composio](/alternatives/composio/) and [Pipedream](/alternatives/pipedream/) pages.

### How is this different from other open-source MCP gateways?

Two questions separate them, and both are architecture rather than roadmap: *whose credential reaches the downstream server*, and *where the authorization decision is made*. A team gateway like [MCPJungle](https://github.com/duaraghav8/MCPJungle) takes downstream credentials at server registration — so every caller shares them — and expresses access control as gateway ACLs. A data plane like [agentgateway](https://github.com/agentgateway/agentgateway) decides through a policy engine at the edge, which is exactly right for a data plane. Cortex is an OAuth 2.1 resource server that decides *nothing*: each user authenticates as themselves, the gateway propagates their identity, and each app keeps enforcing the permission model it already had. In one line: they put one credential — or one policy engine — in front of N MCP servers; Cortex puts each user's own identity in front of N apps. Local aggregators like 1MCP and Docker MCP Gateway are single-user developer tools solving a different problem. Full comparison, verified from each repository: [open-source MCP gateways compared](/alternatives/open-source-mcp-gateways/).

### Couldn't I just build this myself — or have an AI agent generate it?

Sure — it's MIT-licensed and we sell nothing, so clone it or regenerate it. What took weeks wasn't writing the code: it was debugging OAuth 2.1 + MCP against real clients — the exact `401 + WWW-Authenticate` challenge claude.ai requires before it starts the flow, issuer-behind-reverse-proxy, per-client registration quirks, SSE session behavior. Those fixes live in this repo, covered by tests and a live demo you can probe, so nobody has to pay for them twice.

### Is this related to Palo Alto Networks Cortex, CNCF Cortex, or Cortex.io?

No. This Cortex Gateway is an independent, MIT-licensed MCP federation gateway and is not affiliated with Palo Alto Networks' Cortex products (XDR, XSIAM, or their Cortex Gateway tenant portal), the CNCF Cortex metrics project, or Cortex.io. If you were searching for one of those, this is not it — if you want a self-hosted MCP gateway with user-level permissions, you are in the right place.
