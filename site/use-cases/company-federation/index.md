<!-- https://cortex-gateway.dev/use-cases/company-federation/ -->

# One MCP connector for the whole company: a worked example

**TL;DR**

Take a mid-size company with one internal app per department — CRM, delivery docs, billing, staffing. Put a ~120-line HTTP endpoint on each, and Cortex Gateway turns them into **one OAuth 2.1 MCP connector for the whole organization**: every employee's agent sees exactly the tools their scopes allow, every app keeps enforcing its own permissions on the real user's identity, and one revocation cuts everything. The company below is fictional; the architecture is not — the [live demo](https://mcp.cortex-gateway.dev/) runs the same pattern in miniature.

## The setup

**Meridian** (fictional) is a 140-person professional-services firm. Like most companies its size, its software estate grew one department at a time:

| Department | Internal app | Typical tools for an agent |
| --- | --- | --- |
| Sales | CRM | search accounts, log a call, draft a proposal |
| Delivery | Project & docs workspace | find a document, check a milestone, file a report |
| Finance | Billing | read an invoice, check payment status |
| People | Staffing & HR | who is available, book a review, read a policy |

Employees now use MCP-capable agents daily, and every department wants its app reachable from them. The naive path is four separate MCP servers and four connectors per employee — four consents, four token stores, four places to audit, and nothing shared. The dangerous shortcut is one aggregator on a service account — where every agent suddenly holds the union of everyone's rights.

## The architecture

```
[every employee's agent: Claude / OpenClaw / Hermes / ...]
         │  ONE URL · OAuth 2.1 (company SSO issues the JWT)
         ▼
[cortex-gateway]        ←— one perimeter, zero business logic
   │        │       │        │      the SAME user JWT, propagated
   ▼        ▼       ▼        ▼
 [CRM]   [docs]  [billing] [staffing]   ←— each app enforces its OWN ACLs
```

Each app adds a single `POST /api/cortex/backend` endpoint speaking the [backend contract](https://github.com/wellknownmcp/cortex-gateway/blob/main/docs/backend-contract.md) — roughly 120 lines, no MCP library. Registering it with the gateway is one environment variable. The gateway discovers each app's tools every 60 seconds, merges them into one prefixed catalog (`crm_search_accounts`, `billing_get_invoice`…), and routes each call with the caller's real JWT.

One gateway. It rules nothing — your apps do.

## Scopes are the org chart

The authorization server grants scopes per user; the gateway filters `tools/list` accordingly. Nobody writes paywall or role logic in the gateway — visibility falls out of the token:

| Who | Scopes | What their agent sees |
| --- | --- | --- |
| Sales rep | `mcp:crm:write` | CRM tools only |
| Project manager | `mcp:docs:write mcp:crm:read` | Docs tools + read-only CRM |
| CFO | `mcp:billing:write mcp:crm:read` | Billing + read-only CRM |
| CEO | all `:read` | Everything, read-only |

And scope is only the front door: the CRM still applies its own record-level rules to the authenticated user, exactly as it does in its web UI. A sales rep's agent cannot read another team's pipeline *because the CRM says no* — not because a gateway rule was kept in sync.

## Day-2 operations

-   **Someone leaves** → one revocation at the authorization server; every backend stops honoring the token at once. No per-app cleanup.
-   **New app ships** → implement the contract, add one env var; its tools appear in the catalog within a minute, already scope-filtered.
-   **Audit** → one pseudonymized line per tool call (who-hash, tool, backend, latency, outcome) on your infrastructure — not spread across four SaaS dashboards.
-   **An agent hits a gap** → it files `report_missing_capability`; the owning team triages a deduplicated backlog of real agent needs.

## The autonomous-agent question

Copilot mode — a person instructing their agent directly — is the easy case. The harder question is already visible: when each employee has a genuinely *autonomous* agent working as their assistant, "what can it do and who answers for it" stops being a UX detail and becomes a governance question. The architecture above doesn't need to change to answer it: the agent borrows the person's identity, each app keeps enforcing that person's rights, and every call lands in the pseudonymized audit trail. The gateway decides nothing — so scaling from copilots to autonomous assistants adds **nothing new to trust**. This question has its own page: [the permission layer for AI agents](/answers/agent-permission-layer/).

## Try the shape

The [hosted demo](https://mcp.cortex-gateway.dev/) is this exact architecture at miniature scale: one backend, real OAuth 2.1 with magic-link signup, and two scope tiers you can see filter `tools/list` live. Connect it from [claude.ai](/connect/claude-ai/) in about 30 seconds — then run the real thing yourself:

```
docker run ghcr.io/wellknownmcp/cortex-gateway
```

[Get started on GitHub →](https://github.com/wellknownmcp/cortex-gateway)

## FAQ

### Is Meridian a real customer?

No — Meridian is deliberately fictional; this page is a worked example, not a testimonial. The architecture is not fictional: it is what Cortex Gateway is built for, and the demo runs the same pattern in miniature.

### How much work per app?

One POST endpoint, ~120 lines, no MCP library: `list_tools`, your tool methods, and ideally `get_help` so agents learn your domain from the source. The app keeps validating the same JWTs it already trusts.

### Can third-party SaaS join the same connector?

Yes — native third-party MCP servers federate through the built-in proxy adapter (beta), with each user's own linked account in an encrypted vault on your infrastructure. Providers see the real user, never a service account.
