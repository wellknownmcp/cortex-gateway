# Cortex backend contract

A **Cortex backend** is any HTTP service that exposes ONE endpoint:

```
POST <baseUrl><backendPath>        (default backendPath: /api/cortex/backend)
Content-Type: application/json
Authorization: Bearer <token>
X-Cortex-User-Id / -User-Email / -User-Role / -User-Pool / X-Cortex-Scopes   (user context)

{ "method": "<name>", "params": { ... } }
```

The response is plain JSON (the method's return value) with standard HTTP
status codes. No MCP library, no stdio, no SSE — a backend stays a normal web
app that you can also call directly (tests, batch jobs, other integrations).

## Methods every backend MUST implement

| Method | Returns | Notes |
|---|---|---|
| `list_tools` | `{ tools: CortexBackendTool[] }` | The backend's tool catalog. See `src/contract/types.ts`. |

## Methods a backend SHOULD implement

| Method | Returns | Notes |
|---|---|---|
| `get_help` | free JSON | Structured self-documentation (`{ topic? }` param). Agents are told to prefer it over guessing. |
| `whoami` | free JSON | The caller's effective role/capabilities *in this backend*. Aggregated by the gateway's `whoami` builtin. |
| `get_snapshot` | `CortexBackendSnapshot` | Aggregated KPIs for dashboards. MUST contain aggregates only (no per-user data). |
| `list_prompts` | `{ prompts: [...] }` | MCP Prompts primitive. Optional; the gateway tolerates "unknown method". |
| `get_prompt` | `{ description?, messages }` | Materializes a prompt. |
| `list_resource_templates` | `{ resourceTemplates: [...] }` | MCP Resources primitive. Each template's URI scheme (e.g. `docs://...`) routes `resources/read` to this backend. |
| `read_resource` | `{ contents: [...] }` | Resolves a URI of an owned scheme. |
| `report_missing_capability` | `{ ticketId, deduplicated, ackMessage? }` | Backend-owned agent tickets (add the backend id to `CORTEX_TICKET_BACKENDS`). |
| `list_tickets` | `{ tickets: [...] }` | The calling agent's own tickets. |

Any other method name is a **tool**: when the gateway receives
`tools/call` for `<backendId>_<toolName>`, it POSTs
`{ "method": "<toolName>", "params": <arguments> }` to the backend.

## `get_help`: describe the business, not just the mechanics

A tool catalog tells an agent *what it can call*; it does not teach the
agent your domain. In practice an MCP surface only works well when it is
paired with an explanation of the logic behind it — and the best place for
that explanation is the backend itself, versioned with the code that owns
it, not copied into every client. `get_help` is that channel: the gateway's
server instructions explicitly tell every connected agent to prefer
`<app>_get_help(topic?)` over guessing.

Recommended topics (return the full structure when `topic` is omitted, or
one section when it names a topic):

| Topic | Should answer |
|---|---|
| `overview` | What this app does, for whom, and what problems its tools solve — the *business*, in a few sentences. |
| `concepts` | Domain vocabulary and entities (what is a "workspace", a "campaign", a "ticket"?) and the invariants that hold between them. |
| `workflows` | The 2–5 multi-tool sequences that actually matter, step by step, with the decision points spelled out. |
| `conventions` | Naming, id formats, pagination, date/locale rules — anything an agent would otherwise learn by trial and error. |
| `limits` | What the backend deliberately does NOT do, quotas, and what to do instead (often: file a ticket, see below). |
| `examples` | 2–3 realistic request/response pairs for the most-used tools. |

Keep it structured JSON (arrays of steps, not prose walls) and keep it
honest — an agent that follows a stale `get_help` into an error will stop
trusting it. Treat it like user-facing documentation: it ships with the
feature.

### The feedback loop closes the contract

Self-description handles the known; `report_missing_capability` handles the
unknown. When an agent hits a gap — a missing tool, an insufficient filter,
a workflow that cannot be completed — it files a ticket (deduplicated by the
gateway, optionally webhook-forwarded, or owned by your backend via
`CORTEX_TICKET_BACKENDS`). Your backlog of unmet agent needs builds itself,
logged at the backend that owns the domain. Together, `get_help` +
`report_missing_capability` make a backend *self-describing forward* and
*self-correcting backward*.

## Authentication — two token classes

1. **User OAuth JWT** (data methods). The gateway propagates the caller's
   Bearer token verbatim; the backend re-validates it against the same
   authorization server (signature, issuer, audience, expiry) and applies its
   own ACLs. The `X-Cortex-*` headers carry the already-extracted user
   context for convenience, but the JWT stays the source of truth.

2. **Static technical token** (catalog discovery only). The gateway sends
   `CORTEX_TECHNICAL_TOKEN` for `list_tools`, `list_prompts`,
   `list_resource_templates` and `get_snapshot`. This token is *not an
   identity*: it carries no email and no role, so a backend MUST refuse every
   other method with 403 when auth comes from the static token. See
   `src/contract/static-token.ts`.

## Error contract

| Status | Meaning | Gateway behaviour |
|---|---|---|
| 401 | Token invalid/expired | Surfaced as "Backend auth failed" |
| 403 with `{ "required": "<scope>" }` | Missing OAuth scope | Surfaced as "Backend refused scope" |
| 403 without `required` | Application ACL (role/membership) | Surfaced as "Backend ACL denied" with the body's `error` string |
| 400 / 500 with `{ "error": "..." }` | Business error | The `error` string is propagated to the MCP client, full body in `data.backendError` |

The 403 discrimination matters: a caller holding the right scope but lacking a
role must not be told to go fetch more scopes.

## Tool declaration

```jsonc
{
  "name": "search_documents",
  "scope": "mcp:docs:read",              // required OAuth scope
  "description": "Search documents by keyword.",
  "params": { "query": "string", "limit": "number?" },   // simplified schema
  // OR a standard JSON Schema, propagated verbatim:
  // "inputSchema": { "type": "object", "properties": { ... } },
  "version": "1.0.0",                     // optional semver
  "deprecated": {                          // optional
    "removedAt": "2027-01-01",
    "replacedBy": "search_documents_v2"
  }
}
```

Simplified `params` types: `string`, `number`, `boolean`, `string[]`,
`number[]`, `boolean[]`; suffix `?` = optional.

## Scope convention

`mcp:<domain>:<action>` — e.g. `mcp:docs:read`, `mcp:billing:write`. The
gateway filters `tools/list` by exact scope match against the caller's token,
and re-checks on `tools/call`. Backends re-check again (defense in depth).

## Reference implementation

`examples/demo-backend/server.mjs` — a dependency-free Node server
implementing the whole contract in ~120 lines.
