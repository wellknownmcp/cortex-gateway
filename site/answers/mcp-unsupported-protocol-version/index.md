<!-- https://cortex-gateway.dev/answers/mcp-unsupported-protocol-version/ -->

# `unsupported_protocol_version`: why `initialize` gets a 400 and then times out

**TL;DR**

An MCP server answered `HTTP 400 {"error":"unsupported_protocol_version"}` and, a minute later, the client reported `MCP error -32001: Request timed out`. The cause is almost always the `MCP-Protocol-Version` **header** being sent during `initialize`: version negotiation happens in the **body** (`params.protocolVersion`), and the header only carries the *negotiated* version on requests *after* initialize. Fix: never send the header on `initialize`; store `result.protocolVersion` from the response and send that value on every subsequent request.

## The symptom, exactly

The MCP client — or a stdio-to-HTTP proxy in front of it, such as `mcp-proxy` — sends `initialize` and the server responds with HTTP 400 and a body like:

```
{"error":"unsupported_protocol_version","supported":["2025-06-18","2025-03-26"]}
```

Nothing else happens for sixty seconds, then the client gives up:

```
McpError: MCP error -32001: Request timed out   { timeout: 60000 }
```

The timeout is misleading. The server answered immediately — with a rejection that is **not a JSON-RPC message**, so the client's transport discarded it as noise and kept waiting for a response to the `initialize` request id that was never coming. When you see `-32001` on a fresh connection, look for a 4xx earlier in the transport log; that is the real failure.

## Two version channels, one rule

MCP's Streamable HTTP transport carries the protocol version in two places, and they have different jobs:

| Channel | Carries | When |
| --- | --- | --- |
| `params.protocolVersion` in the `initialize` body | The version the client *proposes* | During `initialize` — this is where negotiation happens |
| `MCP-Protocol-Version` HTTP header | The version that was *negotiated* | Every request *after* `initialize` |

The rule that follows: **during `initialize`, the header has no defined value yet** — its value is the outcome of the negotiation that `initialize` performs. The specification covers the gap explicitly: a server receiving a request without the header SHOULD assume `2025-03-26`, the last revision before the header existed. Omitting the header on `initialize` is therefore always safe with a compliant server.

## How the bug happens

SDKs default to the newest protocol revision they implement. In mid-2026, a current MCP TypeScript SDK proposes `2025-11-25`, while a large share of deployed servers — Cortex Gateway included — speak `2025-06-18` and `2025-03-26`. That skew is normal and the body negotiation is designed to absorb it: the server sees an unknown proposal in the body and answers with the latest revision it supports.

The failure needs one more ingredient: an intermediary — a stdio bridge, a proxy, a hand-rolled HTTP client — that *copies the client's proposed version into the header* of the `initialize` request. A server that validates the header strictly (a legitimate choice for post-initialize requests) now rejects the request **before the body negotiation can run**. The recoverable skew has become a hard 400.

This is exactly how Cortex Gateway's own stdio bridge failed its first [Glama](https://glama.ai/mcp/servers/wellknownmcp/cortex-gateway) Docker inspection: the sandbox's `mcp-proxy` proposed `2025-11-25`, the bridge relayed that value as the header, and the gateway — which validates the header on every request — answered 400. The bridge has since been fixed to omit the header during `initialize`.

## What correct negotiation looks like

```
→ POST /mcp        (no MCP-Protocol-Version header)
  {"jsonrpc":"2.0","id":1,"method":"initialize",
   "params":{"protocolVersion":"2025-11-25", ...}}

← 200
  {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18", ...}}
                                     └── the negotiated version

→ POST /mcp
  MCP-Protocol-Version: 2025-06-18   ← from result, not from the request
  {"jsonrpc":"2.0","id":2,"method":"tools/list"}
```

Three behaviors to implement, whether you are writing a client, a bridge, or a proxy:

-   **Never send `MCP-Protocol-Version` on `initialize`.** There is nothing negotiated to declare yet.
-   **Read `result.protocolVersion`** from the initialize response and send exactly that value on every subsequent request — not the version you proposed.
-   **Do not forward non-JSON-RPC bodies to a JSON-RPC stream.** A 400 or 401 rejection body without a `jsonrpc` field must be converted into a proper JSON-RPC error for the pending request id, otherwise the client hangs until timeout instead of failing with a message a human can act on.

## If you maintain the server

Strict header validation is defensible — Cortex Gateway does it — but only if `initialize` can still negotiate. The two lenient behaviors that keep version skew recoverable:

-   An **absent** header is not an error: assume `2025-03-26`, per the specification.
-   In the `initialize` handler, negotiate from the **body**: echo the client's `params.protocolVersion` when you support it, otherwise answer with your preferred supported revision. The client disconnects if it cannot accept it — that is its call to make, not yours.

Rejecting `initialize` because its header names a revision you do not support turns every newer-SDK client into a hard failure for no security benefit: the request has not been dispatched yet, and the body negotiation would have resolved the skew one line later.

## Related failures that look the same

| Symptom | Actually |
| --- | --- |
| `-32001` timeout, but the earlier response is a `401` | OAuth, not versioning — see [the connector does nothing](/answers/mcp-connector-does-nothing/) and [securing MCP with OAuth 2.1](/guides/secure-mcp-with-oauth/). |
| `SyntaxError: Expected property name … in JSON` in a proxy log | Something non-JSON-RPC reached the stdio stream — an error body forwarded verbatim, or a server logging to stdout. Both fixes are in [exposing an HTTP MCP server over stdio](/guides/expose-http-mcp-server-over-stdio/). |
| 400 on requests *after* a successful initialize | The client is sending the version it *proposed* instead of the one the server *returned*. Same fix, other half. |

[Get started on GitHub →](https://github.com/wellknownmcp/cortex-gateway)

## FAQ

### What does the MCP error unsupported\_protocol\_version mean?

A Streamable HTTP server validated the `MCP-Protocol-Version` header against the revisions it supports and rejected the request with HTTP 400 before reading the body. Nine times out of ten the request was `initialize` and the header should not have been sent at all: negotiation happens in the body's `params.protocolVersion`, and the header only carries the negotiated version afterwards.

### When should an MCP client send the MCP-Protocol-Version header?

On every HTTP request after initialization, carrying the version the server returned in the `initialize` result — the negotiated version, not the proposed one. During `initialize` the header has no defined value yet. A compliant server treats an absent header as `2025-03-26`, so omitting it during initialize is safe.

### Why does my client ask for 2025-11-25 when my server only supports 2025-06-18?

SDKs default to the latest revision they implement, and the protocol absorbs the skew: the server answers the initialize body with the most recent version it supports, and the client continues on it or disconnects. Skew only becomes a bug when an intermediary copies the proposed version into the header, where a strict server rejects it before negotiation runs.

### Why a 60-second timeout instead of a clear error?

The 400 body is plain JSON, not a JSON-RPC message. A proxy forwarding it verbatim hands its client an unparseable line; the client discards it and keeps waiting for a response to the `initialize` id, surfacing `MCP error -32001: Request timed out` a minute later. The timeout is the symptom; the 400 is the failure.

### How does MCP protocol version negotiation work?

The client proposes a revision in `params.protocolVersion`. The server echoes it if supported, otherwise answers with its preferred supported revision — and the client disconnects if it cannot accept that. Only after this exchange does a negotiated version exist, and that value goes into the `MCP-Protocol-Version` header of every subsequent request.

### Should my server reject initialize when the header names an unsupported version?

Validating the header on post-initialize requests is fine. Rejecting `initialize` for it turns recoverable skew into a hard failure — the body negotiation would have resolved it. Treat an absent header as `2025-03-26` and let `initialize` negotiate in the body regardless of the header.
