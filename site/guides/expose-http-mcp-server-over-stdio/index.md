<!-- https://cortex-gateway.dev/guides/expose-http-mcp-server-over-stdio/ -->

# Expose an OAuth-protected HTTP MCP server over stdio

**TL;DR**

Your MCP server speaks Streamable HTTP with OAuth 2.1. Some clients — and every directory inspection sandbox, including [Glama's](https://glama.ai/mcp/servers/wellknownmcp/cortex-gateway) — only speak **stdio**. The bridge is conceptually trivial (stdin → `POST /mcp` → stdout) and operationally full of teeth: OAuth with no browser, stdout purity, protocol-version headers, sessions, error bodies that are not JSON-RPC. This guide compares the three approaches and lists the six gotchas, with a working ~200-line reference: [`scripts/stdio-bridge.mjs`](https://github.com/wellknownmcp/cortex-gateway/blob/main/scripts/stdio-bridge.mjs).

## Why this problem exists at all

MCP has two transports. **stdio** — the client spawns the server as a child process and speaks newline-delimited JSON-RPC over stdin/stdout — is how local servers run, and how sandboxes test servers: they control the process, no network to trust. **Streamable HTTP** is how remote servers run, with OAuth 2.1 in front. A production gateway like Cortex Gateway is HTTP-only by design: identity lives in the Bearer token, and there is no meaningful identity story for a spawned child process.

The mismatch surfaces in three places: an MCP client that only supports stdio configuration; CI that wants to smoke-test the server without standing up an authorization server; and directory harnesses — Glama's Docker inspection wraps your start command in `mcp-proxy` and expects JSON-RPC on stdout. Point that harness at an HTTP server and you get the signature failure: `could not start the proxy McpError: MCP error -32001: Request timed out`, then *“Container exited with code 1 before responding to ping.”* The server booted fine; nobody was listening where the harness was talking.

## Three approaches, one honest table

| Approach | OAuth story | Works headless? | Use when |
| --- | --- | --- | --- |
| `npx mcp-remote <url>` | Real flow, opens a browser for consent | **No** — needs a browser and a human | A person's stdio-only client (e.g. an older Claude Desktop config) targeting a deployed server |
| Auth bypass / dev token in the server | None — verification skipped | Yes | Local development only. A production build should refuse it: Cortex Gateway's dev bypass is disabled under `NODE_ENV=production`, which is exactly why it cannot help in a sandbox running the production build |
| **Self-contained bridge + ephemeral issuer** | Real verification path — RS256, issuer, audience, expiry all checked | **Yes** | Directory inspections, CI, local smoke tests. The approach this guide details |

The third approach exists because the first two fail the same requirement from opposite sides: headless environments have no browser, and skipping verification proves nothing about the server you actually ship.

## The ephemeral-issuer bridge, in five steps

The insight: the bridge does not need to *bypass* OAuth — it can *be* the authorization server, for one process, for one lifetime. JWT verification needs an issuer URL, a JWKS document and a signed token; all three can be manufactured locally in a few lines of Node with no dependency beyond a JOSE library.

1.  **Generate an RSA keypair in memory** and serve the public half as a JWKS document on an ephemeral loopback port: `http://127.0.0.1:<port>/.well-known/jwks.json`. That URL *is* your issuer.
2.  **Boot the production server as a child process**, overriding exactly the auth environment: `OAUTH_ISSUER` and `OAUTH_JWKS_URL` point at the loopback issuer, the audience is pinned to the local canonical URI (`http://localhost:3213/mcp`). Everything else — catalog, scopes, audit — runs unmodified.
3.  **Mint a short-lived RS256 JWT**: `iss` = the loopback issuer, `aud` = the canonical URI, plus `sub`, `jti`, `exp` and a `scope` claim (empty is fine when the server's builtins need none). The server verifies it through its normal code path — nothing knows the issuer is twenty lines away.
4.  **Wait for readiness before reading stdin**: poll the HTTP port until it answers. The harness's `initialize` timeout budget (60 s in `mcp-proxy`) includes your boot time.
5.  **Relay**: read stdin line by line, parse, `POST /mcp` with `Authorization: Bearer`, write each JSON-RPC response to stdout with a trailing newline. Track two pieces of response state: the `Mcp-Session-Id` header from `initialize` (echo it on every later request) and `result.protocolVersion` (send it as the `MCP-Protocol-Version` header on every later request).

Security property worth stating precisely: the private key never leaves process memory, the token expires with the hour, and the issuer dies with the process. Nothing is added to any trust store. What the bridge proves is that the server's *real* verification path — issuer match, audience match, signature, expiry — accepts a well-formed token and rejects everything else; a bypass proves neither.

With Cortex Gateway the whole thing is packaged: `npm run start:stdio` runs [`scripts/stdio-bridge.mjs`](https://github.com/wellknownmcp/cortex-gateway/blob/main/scripts/stdio-bridge.mjs); `BRIDGE_SCOPES` sets the self-granted scopes and `BRIDGE_GATEWAY_PORT` the port. In a directory build spec the CMD becomes `["mcp-proxy","--","node","scripts/stdio-bridge.mjs"]`.

## The six gotchas (each one cost a failed run)

| # | Symptom | Cause → fix |
| --- | --- | --- |
| 1 | `[mcp-proxy] ignoring non-JSON output`, `SyntaxError: Expected property name … in JSON` | **stdout is the wire.** Framework banners (`▲ Next.js … ✓ Ready`) and every `console.log` corrupt the stream. The bridge owns stdout; pipe the child's stdout *and* stderr to the bridge's stderr. |
| 2 | `400 unsupported_protocol_version` on `initialize` | The bridge copied the client's proposed version into the `MCP-Protocol-Version` header. Negotiation happens in the body; the header only exists after `initialize`. Full story: [unsupported\_protocol\_version](/answers/mcp-unsupported-protocol-version/). |
| 3 | Client hangs 60 s, then `-32001 Request timed out` | A non-JSON-RPC error body (400/401/429 `{"error": …}`) was forwarded verbatim; the client discarded it and kept waiting. Convert any body without a `jsonrpc` field into a JSON-RPC error for the pending id. |
| 4 | Every request after `initialize` answers 404 `Invalid or expired session` | The server issued an `Mcp-Session-Id` response header on `initialize` and the bridge never echoed it. Capture it once, attach it always. |
| 5 | Duplicate or garbled responses on stdout | Notifications (messages without an `id`) are acknowledged with an empty HTTP 202 — relay *nothing* for them. And keep the relay sequential: `initialize` must settle before the session id it produces is needed. |
| 6 | Works locally, times out only in the sandbox | Readiness budget. The 60-second `initialize` timeout starts when the harness spawns the CMD, and cold container boots are slower than your laptop. Poll readiness aggressively (250 ms) and keep build work in the image's build steps, never in the CMD. |

## What a bridge does not solve

The bridge grants itself scopes, so it answers “what can this *process* do,” never “what may this *user* do.” The per-user identity propagation that justifies putting an OAuth gateway in front of your applications — each user's own rights, enforced by each app, per call — only exists when real users authenticate against the real authorization server. Use the bridge for inspections, CI and local development; point real agents at the HTTPS endpoint. How the real flow works end to end: [secure your MCP server with OAuth 2.1](/guides/secure-mcp-with-oauth/). What the gateway federates behind that endpoint: [expose your REST API as an MCP server](/guides/rest-api-to-mcp-server/).

[Get started on GitHub →](https://github.com/wellknownmcp/cortex-gateway)

## FAQ

### How do I run a remote Streamable HTTP MCP server as a stdio MCP server?

With a bridge process: newline-delimited JSON-RPC on stdin, `POST /mcp` per message, responses to stdout. For a personal client with a browser, `npx mcp-remote <url>` does this and runs the OAuth flow interactively. Headless environments have no browser, so the bridge must obtain a token differently — the ephemeral local issuer above is the pattern that keeps the real verification path.

### Why does my MCP server fail Glama's Docker inspection with “Container exited with code 1 before responding to ping”?

The harness runs your start command inside `mcp-proxy` and speaks stdio to it. An HTTP-only server never answers on stdout, `initialize` times out after 60 seconds, the container exits 1. Configure a stdio entrypoint as the CMD — for Cortex Gateway, `["mcp-proxy","--","node","scripts/stdio-bridge.mjs"]`.

### How can a stdio bridge authenticate against an OAuth-protected MCP server without a browser?

By being the issuer for one process lifetime: RSA keypair in memory, JWKS on a loopback port, server booted with `OAUTH_ISSUER`/`OAUTH_JWKS_URL` pointed there, and a short-lived RS256 JWT signed with the matching claims. The server verifies through its normal OAuth code path; the keypair dies with the process.

### Why must an MCP stdio server never write logs to stdout?

In the stdio transport, stdout is parsed as JSON-RPC — a banner or a `console.log` is stream corruption, seen client-side as parse errors or a silent hang. Log to stderr, and redirect a child server's stdout to stderr in any bridge.

### Is a self-authenticating stdio bridge safe for production?

Safe, but not a production access path: it self-grants scopes, so it proves what the process may do, not what a user may do. Inspections, CI and local dev only; real agents go through the HTTPS endpoint and the real authorization server.

### Should the bridge forward the client's requested protocol version as a header?

No. `MCP-Protocol-Version` carries the *negotiated* version and only exists after `initialize`; during initialize the negotiation lives in `params.protocolVersion`. Copying the proposed version into the header gets a 400 from strict servers — the [unsupported\_protocol\_version](/answers/mcp-unsupported-protocol-version/) failure.
