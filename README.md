# Cortex Gateway

[![CI](https://github.com/wellknownmcp/cortex-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/wellknownmcp/cortex-gateway/actions/workflows/ci.yml)
[![Docker](https://github.com/wellknownmcp/cortex-gateway/actions/workflows/docker.yml/badge.svg)](https://github.com/wellknownmcp/cortex-gateway/actions/workflows/docker.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Glama score](https://glama.ai/mcp/servers/wellknownmcp/cortex-gateway/badges/score.svg)](https://glama.ai/mcp/servers/wellknownmcp/cortex-gateway)

**A federated MCP gateway: one spec-compliant, OAuth-protected MCP server in
front of N plain-HTTP backends.**

Your business apps stay ordinary web services. Each one exposes a single
`POST /api/cortex/backend` endpoint (a ~120-line contract, no MCP library, no
stdio). The gateway discovers their tools, merges them into one MCP catalog,
enforces OAuth 2.1 + scopes, routes `tools/call` to the owning backend, and
keeps a pseudonymized audit trail.

Built for one requirement: everyone in a company should be able to hand
their own agent the keys — with exactly that person's rights, nothing
more, nothing less. And when agents become autonomous assistants, the
answer stays the same: the agent borrows the person's identity, the apps
keep enforcing that person's rights. The gateway decides nothing, so there
is nothing new to trust.

Put another way: **zero-trust principles for AI agents** — the missing link
between your IAM (who your users are, what they may do) and the MCP ecosystem
(how agents call tools). Not a full ZTNA product; the identity-and-access layer
for agents.

A **backend** is a dedicated MCP reduced to its essence: a tool catalog plus
tool invocation (and optional prompts/resources) over bare HTTP JSON-RPC —
the transport and lifecycle machinery (initialize, sessions, SSE, version
negotiation) lives once, in the gateway. Because the contract is a semantic
subset of MCP, a native MCP server can also be federated through the
built-in MCP→backend proxy adapter ([docs/mcp-adapter.md](docs/mcp-adapter.md)).

```
[MCP agent: Claude Desktop / claude.ai Custom Connector / any MCP client]
         │  HTTPS + OAuth 2.1 JWT (Bearer)
         ▼
[cortex-gateway]  ←— thin gateway, no business logic
         │  HTTPS + the same JWT propagated (RFC 8707)
         ▼
[your backends]   ←— domain owners, plain HTTP, own their ACLs
```

## Why

- **Permissions match the underlying app, automatically, at the user
  level.** The gateway never copies or mirrors permissions — it propagates
  the real user identity (your JWT to first-party backends, the user's own
  linked token to proxied third-party MCP servers), so each app's native
  permission model applies per user, with nothing to sync and no
  service-account flattening. Unlike hosted tool aggregators, the token
  vault and the audit trail stay on your infrastructure.
- **One perimeter, not N connectors.** Wiring each app as its own MCP
  connector also keeps native permissions — and leaves you with N consents,
  N token stores, no shared audit, no cross-app entitlements, and a flooded
  tool list. The gateway collapses that to one OAuth surface without giving
  up the per-user model: aggregation without permission loss.
- **Zero MCP lock-in in your apps.** Backends speak a minimal JSON-RPC
  contract over plain HTTP. Remove the gateway and you can still call them
  directly (tests, batch jobs, other integrations).
- **One JWT, N backends.** The agent authenticates once; the gateway
  propagates the token; every backend re-validates it and applies its own
  permissions. Revocation at the authorization server cuts everything.
- **Failure isolation.** An unreachable backend just disappears from
  `tools/list`; the rest keeps working.
- **Context-aware federation.** Backend filtering and a compact "search"
  mode keep the tool catalog from flooding the agent's context
  ([docs/tool-search-mode.md](docs/tool-search-mode.md)).
- **Agent feedback loop.** Agents can file `report_missing_capability`
  tickets when a tool is missing or insufficient — deduplicated, triaged,
  optionally pushed to a webhook when blocking.

## Use cases

**Company-wide agent surface.** An organization runs N internal apps (CRM,
quality docs, billing, analytics...). Each app adds the ~120-line backend
endpoint; the gateway exposes them as ONE MCP connector protected by the
company's SSO. Employees plug a single URL into Claude Desktop / claude.ai
and get exactly the tools their token scopes allow, with a central audit
trail. This is the setup the gateway was born in.

**Product builder.** You ship several products and want agents (yours or your
customers') to operate them. Instead of maintaining one MCP server per
product, every product implements the backend contract and the gateway is
your single, versioned, OAuth-protected agent API. Adding a product to the
agent surface is one env var.

**Thematic hub / curated registry.** Run a gateway as a *topic* endpoint —
e.g. "all open-data tools for domain X" — that federates several providers
behind one URL with one token. The scope model gives you per-provider
opt-in, `get_help`/`get_snapshot` give agents self-describing discovery, and
the audit trail tells you what is actually used. Providers either speak the
(deliberately tiny) backend contract natively, or — for off-the-shelf MCP
servers — get fronted by the built-in MCP→backend proxy adapter
([docs/mcp-adapter.md](docs/mcp-adapter.md)).

**Free / paid tool tiers.** Scopes are entitlements. Let your authorization
server grant `mcp:yourapp:basic` to free users and `mcp:yourapp:pro` to
paying ones (your billing webhook updates the grant): the gateway then shows
and allows each caller exactly the tools of their plan — no paywall logic in
the gateway or the backends, tools just declare their scope. Revocation and
downgrades propagate through the normal OAuth chain.

## Federating native MCP servers (adapter, beta)

The built-in **MCP→backend proxy adapter** lets a bundle mix contract
backends and off-the-shelf native MCP servers (Canva, Figma, ...): the
adapter is an MCP client downstream (initialize, sessions, SSE framing) and
a plain backend upstream, so the gateway core does not change. Per-user
downstream OAuth is handled by a **token vault** (AES-256-GCM at rest) and a
**linking flow** (RFC 9728 discovery, Dynamic Client Registration, PKCE):
each user consents once per provider, then agents are identified on the
whole bundle with a single Cortex token. See
[docs/mcp-adapter.md](docs/mcp-adapter.md) for a worked "design bundle"
example (Canva + Figma + your own backend).

## Roadmap
- **Machine identity for discovery** — replace the static technical token
  with a `client_credentials` flow once your AS supports it.
- **Shared event bus / rate-limit store** — for multi-instance deployments.

## Features

- MCP spec **2025-06-18** (Streamable HTTP transport: POST JSON-RPC, GET SSE
  for `listChanged` notifications, DELETE session termination)
- Primitives: **tools**, **resources** (incl. URI templates), **prompts**
- **OAuth 2.1 resource server**: JWKS verification, audience per resource
  (RFC 8707), protected-resource metadata (RFC 9728), optional RFC 7662
  introspection for revocation
- **Scope-based visibility**: agents only see (and can call) the tools their
  token scopes allow; `scopes_supported` in discovery is derived live from
  the federated catalog
- **Dynamic discovery**: backends are polled every 60s; new tools appear
  without redeploying the gateway, with SSE `tools/list_changed` push
- **Builtins**: `whoami` (aggregated identity across backends),
  `find_tools`, `report_missing_capability`, `list_cortex_tickets`,
  `list_cortex_resources`, `read_cortex_resource`, plus a self-describing
  `cortex://architecture` resource generated live
- **Audit trail**: one JSON line per call on stdout (hashed email, hashed
  params) + optional PostgreSQL persistence with retention cron
- Origin allow-list (anti DNS-rebinding), per-token rate limiting, optional
  pool sandbox

## Quickstart (no OAuth server needed)

```bash
git clone https://github.com/wellknownmcp/cortex-gateway
cd cortex-gateway
npm install

# 1. Start the demo backend (dependency-free)
node examples/demo-backend/server.mjs &

# 2. Configure the gateway
cat > .env.local <<'EOF'
OAUTH_ISSUER=https://auth.example.com
CORTEX_BACKENDS=demo
CORTEX_BACKEND_DEMO_URL=http://127.0.0.1:4820
CORTEX_TECHNICAL_TOKEN=demo-technical-token
CORTEX_DEV_BYPASS_TOKEN=dev-secret
CORTEX_DEV_BYPASS_SCOPES=mcp:demo:read
EOF

# 3. Run it
npm run dev

# 4. Talk MCP (dev bypass replaces the Bearer JWT locally)
curl -s http://localhost:3213/mcp \
  -H 'Content-Type: application/json' \
  -H 'X-Dev-Mode: dev-secret' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[].name'
# → whoami, ..., demo_get_help, demo_echo, demo_get_time

curl -s http://localhost:3213/mcp \
  -H 'Content-Type: application/json' \
  -H 'X-Dev-Mode: dev-secret' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"demo_echo","arguments":{"message":"hello"}}}' | jq
```

In production you point `OAUTH_ISSUER` at your OAuth 2.1 authorization
server (any server that issues RS256 JWTs with a JWKS endpoint and supports
the `scope` claim), and MCP clients connect to `https://your-host/mcp` with
a Bearer token whose `aud` is the gateway's canonical URI.

### stdio bridge (for stdio-only clients and directory sandboxes)

The gateway is a remote Streamable HTTP server, but some MCP clients — and
the Docker inspection harnesses of directories like Glama — only speak the
stdio transport. `scripts/stdio-bridge.mjs` bridges the two: it boots the
production build against an ephemeral local OAuth issuer (the real JWT
verification path, no bypass), mints itself a short-lived token, and relays
newline-delimited JSON-RPC between stdin/stdout and `POST /mcp`.

```bash
npm run build
npm run start:stdio   # stdio MCP server on stdin/stdout
```

Self-granted scopes come from `BRIDGE_SCOPES` (gateway builtins need none);
the gateway port from `BRIDGE_GATEWAY_PORT` (default 3213). Design notes and
the gotchas (stdout purity, protocol-version negotiation, session echo):
<https://cortex-gateway.dev/guides/expose-http-mcp-server-over-stdio/>.

## Adding a backend

1. Implement the contract in your app — one POST endpoint, `list_tools` +
   your tools ([docs/backend-contract.md](docs/backend-contract.md), reference
   implementation in `examples/demo-backend/`).
2. Declare it:
   ```bash
   CORTEX_BACKENDS=demo,docs
   CORTEX_BACKEND_DOCS_URL=http://127.0.0.1:4001
   ```
3. Done. The gateway discovers `docs_*` tools within 60s and pushes
   `tools/list_changed` to connected clients.

## Configuration

Everything is env-driven — see [.env.example](.env.example) for the full
annotated list. The essentials:

| Variable | Required | Purpose |
|---|---|---|
| `CORTEX_CANONICAL_URI` | prod | Canonical MCP resource URI (RFC 9728), default JWT audience |
| `OAUTH_ISSUER` | yes | Your OAuth 2.1 authorization server |
| `CORTEX_BACKENDS` + `CORTEX_BACKEND_<ID>_URL` | yes | Federated backends |
| `CORTEX_TECHNICAL_TOKEN` | yes | Static token for catalog discovery (catalog methods only) |
| `CORTEX_ALLOWED_ORIGINS` | prod | Web origins allowed (exact or `*.suffix`) |
| `CORTEX_TOOL_INTEGRITY_MODE` | no | `warn` (default) or `block` — rug-pull detection on tool definitions |
| `CORTEX_ADMIN_SECRET` | with `block` | Secret for `/api/admin/tool-integrity`, the operator endpoint that reviews and clears quarantines |
| `OAUTH_REQUIRED_SCOPES` | no | Baseline scope demanded before any dispatch |
| `CORTEX_DATABASE_URL` | no | PostgreSQL for audit persistence + gateway tickets |
| `CORTEX_TICKET_WEBHOOK_URL` | no | Webhook for blocking missing-capability tickets |
| `CORTEX_WEBSITE_URL` | no | `websiteUrl` shown by MCP clients (default: the gateway origin). Server icons: replace `public/icon-{light,dark}.png` |

## Security model

Agent access is secured by construction, not by gateway policy. The properties
below are what to demand from any MCP tooling you wire into an AI app:

- **OAuth 2.1, not shared API keys** — every caller authenticates as themselves;
  tokens are per-user, scoped and revocable.
- **No permission flattening** — the real user's identity is propagated to each
  backend, so no over-privileged service account exists and the agent gets
  exactly the user's own rights.
- **Least privilege** — the tool catalog is scope-filtered per caller; agents
  only see the tools their token allows.
- **Verifiable** — the whole OAuth discovery chain is walkable without a token,
  so you (or a third-party scanner) can confirm the posture before connecting.

Under the hood:

- The gateway **decides nothing** about business permissions. OAuth scope is
  the front door (checked twice: gateway + backend); application roles and
  ACLs live in each backend.
- The static technical token can only reach catalog methods
  ([src/contract/static-token.ts](src/contract/static-token.ts)); every data
  method requires the end user's JWT.
- Audit is pseudonymized by design (hashed email, hashed params). Pseudonymized
  is **not** anonymous: hashed identifiers remain personal data under GDPR
  Art. 4(5), so the audit trail stays in your record of processing and needs a
  retention period.
- Sessions are bound to the token's `sub`; foreign session ids get 404.

**Controls a federating gateway can enforce that a single server cannot.**
Because it sees every backend's tool definitions and every hop to them, the
gateway is the place to catch what the ecosystem's incident reports keep
finding — full details in [docs/security.md](docs/security.md):

- **Rug-pull detection.** Tool definitions are fingerprinted (`description`,
  `inputSchema`, `scope`, `version`) at first sight and re-checked at every
  refresh. A backend that rewrites what a tool claims to do while keeping its
  name is reported, and with `CORTEX_TOOL_INTEGRITY_MODE=block` the tool is
  quarantined until an operator reviews it over `/api/admin/tool-integrity` —
  an HTTP endpoint, not an MCP tool, so a model cannot clear a rug pull on its
  own. Name-level change detection — what most implementations do — misses
  exactly this attack.
- **No plaintext to remote hosts.** Every federated call forwards the caller's
  token, so an `http://` backend URL pointing anywhere but loopback is refused
  at load. Same validation on the OAuth endpoints the adapter *discovers* from
  a third-party server's metadata, which is the class of bug behind
  CVE-2025-6514.
- **Attributable audit.** Each line records which backend served the call and
  under which scope — not just the tool name.

Honest scope: the fingerprint baseline is per-process and rebuilt at boot, so
it is mutation detection, not attestation. A persistent signed baseline is the
next step, not a claim being made today.

**Compliance.** These are the controls audits test for on automated access:
least-privilege scopes, per-user identity (no over-privileged service account),
a per-call attributable audit trail, and central revocation. They map to
ISO 27001:2022 Annex A access-control and logging controls (A.5.15, A.5.16,
A.5.17, A.5.18, A.8.2, A.8.15, A.8.16) and to SOC 2 CC6/CC7 — both of which
apply today. The EU AI Act articles usually cited (Art. 12 record-keeping,
Art. 14 human oversight) govern **high-risk** AI systems only, and after the
2026 Digital Omnibus those obligations were deferred to 2 Dec 2027 (stand-alone
Annex III) and 2 Aug 2028 (Annex I embedded); most internal agent deployments
are not high-risk, and a gateway is access infrastructure rather than an AI
system. Self-hosted means the audit trail and token vault stay in your
perimeter — no extra sub-processor under GDPR Art. 28, none in your SOC 2
scope. Cortex supplies the controls, not a certification. Full mapping:
<https://cortex-gateway.dev/answers/ai-agent-compliance-controls/>

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # prisma generate + next build
```

The database is optional in every environment: without `CORTEX_DATABASE_URL`
the audit stays on stdout and gateway-local tickets are disabled.

## License

[MIT](LICENSE)
