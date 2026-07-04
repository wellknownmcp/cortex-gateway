# MCP→backend proxy adapter

Federate **native MCP servers** (Canva, Figma, any remote MCP endpoint)
alongside your contract backends. The adapter is an MCP client downstream —
it absorbs `initialize`, sessions, protocol negotiation and SSE framing —
and exposes the plain backend contract upstream, so the gateway federates it
like any other backend. The gateway core does not change.

```
[Agent] ──our JWT──▶ [gateway] ──our JWT──▶ [adapter route]
                                                 │  user's DOWNSTREAM token (vault)
                                                 ▼
                                        [mcp.canva.com / mcp.figma.com / ...]
```

Status: **beta** — protocol layer covered by unit tests against the MCP spec
(2025-06-18); not yet certified against specific commercial providers.
Tools only in V1 (prompts/resources of downstream servers are not projected;
interactive MCP features — sampling, elicitation — do not cross the bridge).

## Worked example — a "design bundle"

Goal: one MCP URL that federates **Canva + Figma + your own backend**, one
identity for the agent, per-user third-party accounts.

### 1. Declare the proxied servers and federate them (loopback)

```bash
# the adapter's downstream targets
CORTEX_MCP_SERVERS=canva,figma
CORTEX_MCP_CANVA_URL=https://mcp.canva.com/mcp
CORTEX_MCP_FIGMA_URL=https://mcp.figma.com/mcp

# federate them like any backend — pointing back at the gateway itself
CORTEX_BACKENDS=studio,canva,figma
CORTEX_BACKEND_STUDIO_URL=http://127.0.0.1:4001          # your own backend
CORTEX_BACKEND_CANVA_URL=http://127.0.0.1:3213
CORTEX_BACKEND_CANVA_PATH=/api/mcp-adapter/canva/backend
CORTEX_BACKEND_FIGMA_URL=http://127.0.0.1:3213
CORTEX_BACKEND_FIGMA_PATH=/api/mcp-adapter/figma/backend

# the vault key protecting downstream tokens at rest (openssl rand -base64 32)
CORTEX_VAULT_KEY=<32 bytes, base64>
CORTEX_DATABASE_URL=postgresql://...   # required by the vault
```

Tool names come out as `canva_*`, `figma_*`, `studio_*` — one uniform
catalog, scope-filtered per caller.

### 2. Users link their accounts (once)

Each provider requires its own consent screen — that is non-negotiable
OAuth. The linking flow orchestrates it:

```
GET /api/link/canva/start?token=<the user's Cortex JWT>
  → 302 to Canva's consent screen → callback → "canva linked ✓"
GET /api/link/figma/start?token=<jwt>
  → 302 to Figma's consent screen → callback → "figma linked ✓"
```

Under the hood: RFC 9728 discovery of the provider's authorization server,
Dynamic Client Registration (RFC 7591) when no static client is configured,
PKCE, and an AES-GCM-sealed self-contained `state` (no server-side state).
The resulting grant (access + refresh token) is stored encrypted in the
vault, keyed by the user's `sub`. From then on the adapter refreshes
silently — *linked once, identified on the whole bundle*.

`POST /api/link/<server>/unlink` (Bearer JWT) removes the stored grant.

### 3. Runtime

Agent calls `canva_create_design` → gateway routes to the adapter → adapter
verifies the Cortex JWT, looks up the caller's Canva token in the vault
(refreshing if needed), speaks real MCP to `mcp.canva.com`, and returns the
result. A user who has not linked Canva gets an explicit 403 with the link
URL — and if your authorization server only grants `mcp:canva:read` to users
who completed the linking, unlinked users never even see the `canva_*` tools
(the gateway already filters `tools/list` by scope).

## Configuration reference

| Variable | Purpose |
|---|---|
| `CORTEX_MCP_SERVERS` | Comma-separated ids of proxied native MCP servers |
| `CORTEX_MCP_<ID>_URL` | Downstream MCP endpoint |
| `CORTEX_MCP_<ID>_SCOPE` | Cortex scope stamped on all its tools (default `mcp:<id>:read`) |
| `CORTEX_MCP_<ID>_CLIENT_ID` / `_CLIENT_SECRET` | Static OAuth client at the provider (else DCR) |
| `CORTEX_MCP_<ID>_OAUTH_SCOPE` | Scope string requested at the provider's authorize step |
| `CORTEX_MCP_<ID>_CATALOG_SUB` | Linked sub whose token serves catalog discovery (see below) |
| `CORTEX_VAULT_KEY` | 32-byte base64 AES key for tokens at rest |

## Catalog discovery

The gateway's 60s refresh calls `list_tools` with the static technical
token, which carries no downstream identity — but most commercial MCP
servers require auth even for `tools/list`. Solution: link an account
(yours), then set `CORTEX_MCP_<ID>_CATALOG_SUB` to that sub. The adapter
uses that account's token for discovery only; every actual tool invocation
uses the *calling user's* token.

## Security model

- **Identity boundary.** Your Cortex JWT never leaves your OAuth perimeter.
  The adapter is the identity translator: Cortex `sub` → provider token.
  Providers see each user's own account (their rate limits, their seat,
  their audit trail on the provider side) — not a shared service account.
- **Vault.** Tokens are AES-256-GCM-encrypted at rest; the key lives only in
  `CORTEX_VAULT_KEY`. Rotating the key invalidates stored grants (users
  re-link). Treat the vault DB + key as crown jewels.
- **Error mapping.** Downstream 401 → ACL-shaped 403 upstream ("re-link your
  account"), never confused with a missing Cortex scope.
- **Licensing.** The bundle federates *access*, not licenses: each user
  links their own provider account and must hold the appropriate plan/seat.
  Check each provider's terms before re-exposing their MCP.

## Limits (V1)

- Tools only; downstream prompts/resources are not projected.
- Per-server scope (all tools of a provider share one Cortex scope);
  per-tool scope mapping is future work.
- In-process downstream session cache (multi-instance deployments will
  re-initialize per instance — harmless, just extra handshakes).
