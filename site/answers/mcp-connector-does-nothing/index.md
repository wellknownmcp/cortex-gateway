<!-- https://cortex-gateway.dev/answers/mcp-connector-does-nothing/ -->

# Your MCP connector does nothing: five causes, ranked

**TL;DR**

You paste your server URL into claude.ai or Claude Desktop, the connector is added, and then **nothing** — no OAuth prompt, no error, no tools. In four cases out of five the cause is the same: your server answers unauthenticated requests with a **bare `401`**, and the client is waiting for a `WWW-Authenticate` header it never receives. The header is the only input it has to find your authorization server. This page lists the five causes in order of frequency, each with the `curl` that confirms it in ten seconds.

## What "does nothing" actually looks like

The failure is silent by design, which is why it costs so many hours. The MCP client tries an unauthenticated request first, expecting to be challenged. If the challenge is missing, malformed or unreadable, there is nothing for the client to act on — it cannot invent your authorization server's address. So it stops. From the outside: the connector appears in the list, shows no error, and exposes zero tools.

Every cause below produces that same symptom. Diagnose in order.

## Cause 1 — the 401 has no WWW-Authenticate header

This is the overwhelming majority. An MCP server is an OAuth 2.1 resource server, and RFC 9728 §5.1 requires it to point unauthenticated callers at its protected-resource metadata:

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"
```

The client fetches that document, reads `authorization_servers`, and starts the authorization code flow with PKCE. Without the header there is no discovery, therefore no flow, therefore no error to show you.

Confirm it:

```
curl -i -X POST https://mcp.example.com/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

You must see `HTTP/1.1 401` *and* a `WWW-Authenticate:` line. A `200`, a `403`, or a naked `401` all mean the same thing to the client: dead end.

## Cause 2 — the header is sent, but the browser cannot read it

Web connectors such as claude.ai run in a browser, and browsers hide almost every response header from cross-origin JavaScript. Sending the challenge is not enough; you must expose it:

```
Access-Control-Expose-Headers: Mcp-Session-Id, WWW-Authenticate
```

Miss this and `curl` shows a perfect challenge while the connector still does nothing — the most maddening variant of this bug, because your manual test passes. `Mcp-Session-Id` belongs in the same list: the client needs it to keep a session across requests.

## Cause 3 — an Origin check rejects the client before OAuth runs

The MCP specification tells servers to validate the `Origin` header against an allowlist, to prevent DNS-rebinding attacks from local pages. That check runs *before* authentication. If the client's web origin is not allowed, the CORS preflight receives `403`, the real request is never sent, and no challenge is ever produced.

This is why the same server can work in Claude Desktop and fail on claude.ai: **local MCP clients send no `Origin` header at all**, so they sail past a check that blocks every web connector.

```
curl -i -X OPTIONS https://mcp.example.com/mcp \
  -H 'Origin: https://claude.ai' \
  -H 'Access-Control-Request-Method: POST'
```

Expect `204` with `Access-Control-Allow-Origin`. A `403` here means your allowlist is the problem. In Cortex Gateway that list is `CORTEX_ALLOWED_ORIGINS`, which accepts exact origins (`https://claude.ai`) and hostname suffixes (`*.anthropic.com`).

## Cause 4 — you answered with a JSON-RPC error and HTTP 200

Tempting, because MCP speaks JSON-RPC and JSON-RPC has an error object. But OAuth sits *below* JSON-RPC: the client inspects the HTTP status and the challenge header before it parses any body. An auth failure wrapped in `{"error": {...}}` with status `200` reads as a transaction that completed and failed at the application level — nothing to authorize, nothing to retry.

Authentication failures are HTTP `401` plus the challenge. Authorization failures — a valid token missing a scope — are HTTP `403`. Business errors are the JSON-RPC error object. Three layers, three mechanisms; collapsing them breaks the client.

## Cause 5 — the challenge points at localhost

The header is present, the browser reads it, and it says:

```
WWW-Authenticate: Bearer resource_metadata="http://localhost:3213/.well-known/oauth-protected-resource"
```

Your framework derived the URL from the request it saw behind the reverse proxy. The client dutifully fetches localhost, finds nothing, and gives up. Same silence, different root cause — and it usually travels with an audience mismatch that produces an endless 401 loop *after* login. That failure has its own page: [the OAuth issuer behind a reverse proxy](/answers/mcp-oauth-issuer-behind-proxy/).

## The five-minute diagnostic

Run these three commands in order. The first one that misbehaves is your bug.

| # | Command | Expected |
| --- | --- | --- |
| 1 | Unauthenticated `POST /mcp` | `401` + `WWW-Authenticate: Bearer resource_metadata="…"` |
| 2 | `OPTIONS /mcp` with `Origin: https://claude.ai` | `204`, `Access-Control-Allow-Origin`, and `WWW-Authenticate` in `Access-Control-Expose-Headers` |
| 3 | `GET /.well-known/oauth-protected-resource` | JSON with a public `resource` URI and a non-empty `authorization_servers` |

```
curl -s https://mcp.example.com/.well-known/oauth-protected-resource | jq
```

If all three pass and the connector still shows no tools, the OAuth layer is fine and your problem is downstream — see [why `tools/list` comes back empty](/answers/mcp-tools-list-empty/).

## Why this keeps happening

Nothing in the MCP specification is ambiguous here. What makes the bug expensive is that **every failure mode produces the same non-event**: no exception, no log line on the client, no red banner. The server looks healthy in every test that does not send an unauthenticated request and read the headers.

The general lesson holds beyond MCP: when a protocol's discovery step is a single header, that header is a load-bearing wall. Test it explicitly, in CI, on the deployed URL — not on localhost, where causes 3 and 5 cannot reproduce.

[Cortex Gateway](https://github.com/wellknownmcp/cortex-gateway) implements the challenge, the Origin allowlist and the exposed headers once, in front of every application behind it, so no service has to get this right twice. The [hosted demo](https://mcp.cortex-gateway.dev/) is a live server you can point these three `curl` commands at to see the correct responses.

[Get started on GitHub →](https://github.com/wellknownmcp/cortex-gateway)

## FAQ

### Why does my claude.ai custom connector do nothing when I add it?

Almost always: your server answers unauthenticated requests with a bare `401` and no `WWW-Authenticate` header. That header is the client's only way to discover your authorization server, so without it the OAuth flow never starts and the connector fails silently. Send `401` with `WWW-Authenticate: Bearer resource_metadata="https://your-server/.well-known/oauth-protected-resource"`.

### What exact WWW-Authenticate header does an MCP server have to send?

A Bearer challenge whose `resource_metadata` parameter is the absolute URL of your protected-resource metadata document (RFC 9728 §5.1). Build that URL from your canonical public origin, never from the inbound request — see cause 5.

### Why can the browser not see my WWW-Authenticate header?

Cross-origin responses expose only a handful of headers to JavaScript. Add `Access-Control-Expose-Headers: Mcp-Session-Id, WWW-Authenticate`. A challenge the browser cannot read is a challenge that was never sent — and `curl` will not reproduce the failure.

### Why does my MCP server return 403 to claude.ai before authentication?

An `Origin` allowlist is rejecting the connector, and that check runs before OAuth. Local clients send no `Origin` header, which is exactly why the same server works in Claude Desktop and fails on claude.ai.

### Can I signal an auth error with a JSON-RPC error and HTTP 200?

No. The client reads the HTTP status and the challenge header before parsing any body. Authentication failure is `401` + challenge; missing scope is `403`; business errors are the JSON-RPC error object. Collapsing the three breaks the client.

### It works in Claude Desktop but not on claude.ai. Why?

Two causes are specific to web connectors: the `Origin` allowlist (cause 3) and the missing `Access-Control-Expose-Headers` (cause 2). Neither can reproduce from a local client, which sends no `Origin` and does not run in a browser.

### How do I test the OAuth challenge without a client?

Send an unauthenticated `POST` to the MCP endpoint with `curl -i` and read the headers. You must see `401` and a `WWW-Authenticate` line. Then fetch the URL that header points at: it must return JSON with a non-empty `authorization_servers`.

### The connector authenticates but then loops back to login. Is that the same bug?

No — that is the audience or issuer mismatch, and it happens *after* the challenge worked. See [the OAuth issuer behind a reverse proxy](/answers/mcp-oauth-issuer-behind-proxy/).
