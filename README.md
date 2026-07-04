# Cortex Gateway

**A federated MCP gateway: one spec-compliant, OAuth-protected MCP server in
front of N plain-HTTP backends.**

Your business apps stay ordinary web services. Each one exposes a single
`POST /api/cortex/backend` endpoint (a ~120-line contract, no MCP library, no
stdio). The gateway discovers their tools, merges them into one MCP catalog,
enforces OAuth 2.1 + scopes, routes `tools/call` to the owning backend, and
keeps a pseudonymized audit trail.

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
| `CORTEX_DATABASE_URL` | no | PostgreSQL for audit persistence + gateway tickets |
| `CORTEX_TICKET_WEBHOOK_URL` | no | Webhook for blocking missing-capability tickets |

## Security model

- The gateway **decides nothing** about business permissions. OAuth scope is
  the front door (checked twice: gateway + backend); application roles and
  ACLs live in each backend.
- The static technical token can only reach catalog methods
  ([src/contract/static-token.ts](src/contract/static-token.ts)); every data
  method requires the end user's JWT.
- Audit is pseudonymized by design (hashed email, hashed params).
- Sessions are bound to the token's `sub`; foreign session ids get 404.

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
