<!-- https://cortex-gateway.dev/answers/mcp-proxy-vs-supergateway/ -->

# mcp-proxy vs supergateway: which MCP transport bridge?

**TL;DR**

Same job: both bridge MCP transports in either direction — expose a **stdio** server over **SSE / Streamable HTTP**, or let a stdio-only client reach a remote server. Three things actually separate them: **runtime** (mcp-proxy is Python; supergateway is Node/npx), **maintenance** (mcp-proxy released May 2026; supergateway has been silent since **October 2025**), and **features** (mcp-proxy: named servers, config file, Docker; supergateway: WebSocket output, CORS flags, health endpoints). Neither does interactive OAuth, and neither is a multi-user gateway.

**Transparency.** We maintain [Cortex Gateway](https://github.com/wellknownmcp/cortex-gateway), which is a different category of tool (an identity-propagating MCP gateway) and competes with neither project. Facts below are verified from both repositories on **16 August 2026**; corrections welcome as a GitHub issue.

## What they both do

MCP has two transport worlds: local servers speaking **stdio**, and remote servers speaking **Streamable HTTP** (or legacy SSE). Clients and servers do not always match, so a bridge process translates:

-   **stdio server → HTTP.** You have a local stdio MCP server (a filesystem server, a database tool) and want it reachable over the network, or from a client that only speaks HTTP.
-   **Remote server → stdio.** Your client only launches stdio subprocesses (older Claude Desktop configurations, various coding agents) and the server you need is remote — [a problem with more traps than it looks](/guides/expose-http-mcp-server-over-stdio/).

Both projects handle both directions, both are MIT-licensed, and both sit at roughly 2.7–2.8k GitHub stars — popularity will not decide this for you.

## Side by side

|  | mcp-proxy (sparfenyuk) | supergateway (supercorp-ai) |
| --- | --- | --- |
| Runtime | Python — pip, uv, official Docker images | Node — single `npx -y supergateway` command |
| Latest release | v0.12.0, May 2026; commits into July 2026 | v3.4.3, **October 2025** — nothing since |
| Transports | stdio ↔ SSE / Streamable HTTP | stdio ↔ SSE / Streamable HTTP, plus WebSocket output |
| Multi-server | **Named servers**: one config file, several stdio servers behind one port | One server per process |
| Upstream auth | Static headers; OAuth2 *client-credentials* flags (client id/secret, token URL) | Static `--oauth2Bearer` token; custom `--header` |
| Serving extras | Config-driven deployment, container-first | CORS flags, health endpoints, stateful Streamable HTTP mode |
| License / stars | MIT, ~2.7k | MIT, ~2.8k |

## How to choose

**Default to mcp-proxy** on maintenance alone: a bridge sits in every request path and forwards auth headers, and mcp-proxy shipped a release three months before our check while supergateway has been silent for ten. Its named-servers mode is also the cleaner shape for running several stdio servers on one box — one config file, one port, one container.

**Reach for supergateway** when you specifically need what only it has: WebSocket output, or a zero-install one-liner in a Node-only environment where adding a Python runtime is a real cost. It still works — transports have not changed incompatibly since its last release — but pin the version and treat it as frozen.

Disambiguation: there are *two* projects named mcp-proxy. This page compares [sparfenyuk/mcp-proxy](https://github.com/sparfenyuk/mcp-proxy) (Python CLI bridge, ~2.7k stars). [punkpeye/mcp-proxy](https://github.com/punkpeye/mcp-proxy) (~280 stars) is a TypeScript *library* for exposing stdio servers over HTTP inside Node projects — actively released, different tool, different use. Tutorials rarely say which one they mean; check before copying commands.

## The two gaps neither covers

**Interactive OAuth.** Both can attach a token you already possess (and mcp-proxy can run a machine-to-machine client-credentials flow). Neither implements the OAuth 2.1 authorization-code flow — dynamic client registration, PKCE, a browser consent step — that spec-compliant remote MCP servers require for end users. If the remote server answers `401` with a `WWW-Authenticate` challenge, you want `mcp-remote` or a self-contained bridge instead; our [stdio bridging guide](/guides/expose-http-mcp-server-over-stdio/) compares those options and the six gotchas that break them.

**Identity.** A bridge carries one credential for whoever runs it. It has no notion of users, so the moment several people reach shared tools — per-user permissions, consent, attribution, revocation — you are in [gateway territory](/answers/mcp-gateway-vs-mcp-server/), which is an identity problem rather than a transport problem. The two compose cleanly: a bridge can connect one stdio-only client to a gateway's single OAuth-protected endpoint.

[The full stdio bridging guide →](/guides/expose-http-mcp-server-over-stdio/)

## FAQ

### What is the difference between mcp-proxy and supergateway?

They do the same job — bridge MCP transports in both directions. The practical differences: mcp-proxy is Python (uv, Docker, named servers in a config file) and actively maintained (v0.12.0, May 2026); supergateway is Node (one npx command, WebSocket output, CORS and health flags) with no release since October 2025. Both MIT, both ~2.7–2.8k stars in August 2026.

### Is supergateway still maintained?

Its last release and last push date from October 2025 — ten months before this page's check. It still works, but for a component in every request path that forwards auth headers, that silence is worth weighing; mcp-proxy is the safer default on maintenance alone.

### Can they handle OAuth-protected MCP servers?

Only with a token you already have (both), or a client-credentials flow (mcp-proxy). Neither does the interactive authorization-code flow with DCR and PKCE that end-user MCP servers use — for that, `mcp-remote` or a [self-contained bridge](/guides/expose-http-mcp-server-over-stdio/).

### Are there two projects called mcp-proxy?

Yes: sparfenyuk/mcp-proxy, the Python CLI bridge this page compares, and punkpeye/mcp-proxy, a TypeScript library for Node projects. Check which one a tutorial means before copying its commands.

### When is a transport bridge the wrong tool?

When the problem is *who is calling*, not how bytes travel. Several people, shared tools, per-user permissions, attribution, revocation: that is a [gateway](/answers/mcp-gateway-vs-mcp-server/), not a bridge. They compose — a bridge can front a gateway's OAuth-protected endpoint for a stdio-only client.
