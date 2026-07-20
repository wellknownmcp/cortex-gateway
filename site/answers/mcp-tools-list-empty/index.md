<!-- https://cortex-gateway.dev/answers/mcp-tools-list-empty/ -->

# `tools/list` is empty: six causes and how to tell them apart

**TL;DR**

The agent connected, OAuth succeeded, and it sees no tools. Nothing is broken — something **filtered** them. Start by asking which kind of empty you have: *only the gateway builtins* means the catalog is healthy and your **scopes** (or a backend filter header) removed the rest; *literally zero tools* means you are not reading a successful `tools/list` at all. The single most useful next call is `whoami`: it returns your effective scopes and which backends are alive.

## First: which kind of empty?

Gateway builtins — `whoami`, `list_cortex_resources`, `read_cortex_resource`, `report_missing_capability`, `list_cortex_tickets` — are **always listed and never scope-filtered**, because they belong to the gateway rather than to any federated application. That property turns a vague symptom into a two-way branch:

| What you see | What it means |
| --- | --- |
| The builtins, and nothing else | The MCP layer works. Your **scopes**, a **backend filter**, or an **empty catalog** removed the application tools. Causes 1 to 5 below. |
| An empty array, no builtins at all | You are not reading a successful `tools/list`. Either the response is an error body, or you are hitting the wrong endpoint. Check the HTTP status first — a `401` here means [the OAuth challenge story](/answers/mcp-connector-does-nothing/). |
| Most tools, one missing | Cause 6: scope, name collision, or an unconfigured backend. |

## Cause 1 — your token does not carry the scope (most common)

A gateway filters the catalog by **exact string match** between the scope a tool declares and the scopes in the caller's token. A tool requiring `mcp:docs:read` is removed from `tools/list` for a token that does not hold it — silently, and on purpose.

The silence is the feature. Least privilege means an agent must not even *learn* that a tool exists if its user may not call it. So there is no warning, no `403`, no log line saying "hid 14 tools". And because the comparison is literal, `mcp:docs:read` and `mcp:docs.read` are two unrelated scopes: a single character makes an entire application vanish.

```
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{}}}
```

`whoami` returns the scopes your token actually carries, next to the scopes each backend expects. Compare the two strings before suspecting anything else — this is the answer four times out of five.

If the scope is genuinely missing, the fix is at the authorization server: the consent screen must offer it and the client must request it.

## Cause 2 — a header narrowed the catalog

Cortex Gateway accepts `X-Cortex-Backends` to restrict `tools/list` to a subset of applications, which cuts 50–80 % of the context an agent spends on tool definitions. A subtlety bites: **an empty value is not "no filter"**.

```
X-Cortex-Backends: docs,billing   → tools of those two apps, plus builtins
X-Cortex-Backends:                → builtins only
(header absent)                   → every healthy backend
```

A client that always sets the header, from a config value that happens to be an empty string, ends up asking for nothing and getting exactly that. Same for `X-Cortex-Tool-Mode: search`, which does not empty the list but returns compact entries — names and one-line descriptions, with schemas fetched on demand through `find_tools`. An agent expecting full `inputSchema` objects may read that as "no usable tools".

## Cause 3 — the gateway just booted

The federated catalog is built by polling each backend's `list_tools`, and it lives in memory. On a cold start the first refresh has not completed yet, so the catalog is empty and `tools/list` legitimately returns only the builtins. It fills within one refresh cycle — sixty seconds — and pushes `notifications/tools/list_changed` to connected clients.

Before diagnosing anything else after a deploy or a restart: **wait one cycle**. A surprising share of "the tools disappeared" reports are a screenshot taken twenty seconds after `pm2 restart`.

## Cause 4 — a backend is down, and that is not an error

When a backend fails to answer `list_tools`, it loses its tools from the catalog and the refresh continues. This is failure isolation: one broken application must not take down the tool list of the other four. The consequence is that a backend outage looks exactly like a scope problem from the agent's side — tools quietly absent, no error anywhere.

Two things distinguish them. `whoami` aggregates the health of every backend, so a missing entry there points at the backend, not at your token. And the gateway logs the refresh outcome per backend at every cycle, which names the failure directly.

A related trap: a backend id declared in `CORTEX_BACKENDS` with no matching `CORTEX_BACKEND_<ID>_URL` is **silently skipped**. It never appears, never errors, and looks identical to a backend that is down.

## Cause 5 — the backend rejected the discovery token

Catalog discovery does not run as a user. The gateway calls `list_tools` with a **static technical token** that carries no email and no role, precisely so a compromised catalog call cannot read anyone's data — and the backend contract requires every *other* method to be refused when authentication comes from that token.

Implement that rule slightly too broadly and the backend refuses `list_tools` as well. The gateway receives a `403`, treats the backend as unhealthy, and drops its tools. You then debug scopes for an hour while the real problem is a backend that will not describe itself.

Reproduce it directly, with no gateway involved:

```
curl -s -X POST https://docs.internal.example.com/api/cortex/backend \
  -H "Authorization: Bearer $CORTEX_TECHNICAL_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"method":"list_tools","params":{}}' | jq
```

This must return the catalog. The same call with `{"method":"list_notes"}` must return `403`. If the first is refused, or the second succeeds, the backend has the rule backwards. Details in the [backend contract](https://github.com/wellknownmcp/cortex-gateway/blob/main/docs/backend-contract.md), and the surrounding design in [exposing a REST API as an MCP server](/guides/rest-api-to-mcp-server/).

## Cause 6 — one tool is missing, not all of them

Three candidates, in order:

-   **Scope.** Same as cause 1, restricted to one tool. Write tools are the usual victims: a read-only token sees `list_notes` but never `save_note`. That is the system working.
-   **Name collision with a builtin.** Every backend exposes `whoami` by contract, so a federated `docs_whoami` would duplicate the gateway builtin. The gateway masks it from `tools/list` — the builtin already aggregates every backend's answer, and takes priority at dispatch.
-   **Deprecated, not absent.** A tool marked deprecated is still listed, with its removal date prefixed into the description. Agents that filter on description text have been known to drop them.

## The chicken-and-egg you will hit exactly once

The `scopes_supported` field of `/.well-known/oauth-protected-resource` is derived from the live catalog: ship a tool with a new scope in any backend and that scope becomes discoverable without touching the gateway. Elegant — and it means that on a cold boot, or when every backend is unreachable, the document advertises **no scopes at all**.

A client reading it at that exact moment requests no scopes, receives a token that grants none, and sees a catalog filtered down to the builtins. Everything then looks like cause 1, and re-authenticating fixes it, which teaches you nothing. The rule that saves the hour: **after any restart, let one refresh cycle pass before you let a client run discovery.**

## The diagnostic, in order

| # | Check | What it rules out |
| --- | --- | --- |
| 1 | Are the builtins listed? | No → not a catalog problem. Read the HTTP status. |
| 2 | `whoami`: scopes + backend health | Distinguishes cause 1 (scopes) from causes 3–5 (catalog). |
| 3 | Is `X-Cortex-Backends` being sent, possibly empty? | Cause 2. |
| 4 | Has one refresh cycle elapsed since boot? | Cause 3, and the discovery race above. |
| 5 | Gateway refresh logs, per backend | Causes 4 and 5, by name. |
| 6 | `curl` the backend's `list_tools` with the technical token | Cause 5, definitively. |

The [hosted demo](https://mcp.cortex-gateway.dev/) is a working reference: connect an agent, call `whoami`, and compare a read-only token's `tools/list` with one that also holds the write scope. The write tools are not forbidden — they are *invisible*, which is what least privilege looks like from the agent's side.

[Get started on GitHub →](https://github.com/wellknownmcp/cortex-gateway)

## FAQ

### Why does my MCP agent see no tools after connecting successfully?

If OAuth succeeded, the tools were filtered, not lost. Usually scopes: the catalog is filtered by exact match between each tool's required scope and the token's scopes, so a token never granted `mcp:docs:read` makes every docs tool disappear without an error. Otherwise the catalog itself is empty — a backend is down, or the gateway just booted. Call `whoami`: it reports your effective scopes and which backends are healthy.

### Should tools/list ever return literally zero tools?

Not on a healthy gateway. Builtins like `whoami` are always listed and never scope-filtered, so a successful `tools/list` always contains at least those. An entirely empty array means you are reading an error body or hitting the wrong endpoint. Seeing *only* the builtins is a different diagnosis entirely: the catalog is fine, your scopes or a backend filter removed the rest.

### Why does a scope typo silently remove tools instead of raising an error?

Because scope filtering is least privilege, not error handling: an agent must not learn that a tool exists if its user may not call it. The comparison is literal, so `mcp:docs:read` and `mcp:docs.read` are unrelated scopes — one character, one invisible application.

### Why do my tools disappear right after a restart?

The catalog is in memory and rebuilt by polling each backend. On a cold boot the first refresh has not finished, so only the builtins are listed. It fills within one cycle (60 s) and pushes `tools/list_changed`. Wait one cycle before diagnosing.

### Why is scopes\_supported empty in my protected-resource metadata?

It is derived from the live catalog. Cold boot or all backends unreachable means no tools, therefore no scopes advertised — and a client reading it then requests none, gets a token granting none, and sees only builtins. Let one refresh cycle pass before running discovery.

### Why is one backend tool missing while the others are listed?

Its scope is not in your token; or its name collides with a gateway builtin (`whoami` is masked, since the builtin aggregates every backend); or its backend is declared without a URL and is silently skipped at refresh. The per-backend refresh logs settle the third case immediately.

### A backend is down. Why is there no error?

Failure isolation: a backend that cannot answer `list_tools` loses its tools and the refresh continues, so one broken application does not take down the other four. The cost is that an outage looks like a scope problem from the agent's side. `whoami` and the refresh logs distinguish them.

### My tools have no inputSchema. Is the catalog broken?

No — you are in `search` mode (`X-Cortex-Tool-Mode: search`), which returns names and one-line descriptions to save context, with full schemas fetched on demand via `find_tools`. It cuts the `tools/list` payload by roughly 80 %.
