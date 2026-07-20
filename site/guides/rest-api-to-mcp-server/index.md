<!-- https://cortex-gateway.dev/guides/rest-api-to-mcp-server/ -->

# How to expose your REST API as an MCP server

**TL;DR**

There are three ways to put an existing API in front of AI agents: embed an **MCP SDK in every service**, **generate a wrapper from your OpenAPI spec**, or run **one gateway** and give each service a thin HTTP contract. The first duplicates protocol machinery per service. The second produces a catalog shaped like your routes rather than like the agent's task, and has no answer for authorization. The third keeps the protocol in one place and — if the gateway propagates identity rather than holding a credential — keeps each application's own per-user permissions intact. This guide walks the third path in five steps.

## Start with the question the code doesn't ask

"How do I turn my REST API into an MCP server" is usually the second question. The first one is *who will the agent be acting for*, because the answer changes the architecture:

-   **Nobody in particular.** Public documentation, a product catalog, a status page. A standalone read-only MCP server is fine. No auth, no gateway, ship it.
-   **A specific signed-in user.** Their invoices, their tickets, their documents. Now the MCP endpoint has to be an OAuth 2.1 resource server, every call has to carry that person's identity, and your existing permission model has to still apply. This is where most integrations quietly cheat — one API key, one service account, everyone's data — and where the [permission layer](/answers/agent-permission-layer/) stops being optional.

Everything below assumes the second case, because the first one needs no guide.

## Three approaches, honestly compared

|  | MCP SDK per service | Generate from OpenAPI | Gateway + thin contract |
| --- | --- | --- | --- |
| Protocol code | In every service, upgraded in every service | In the generator's runtime | Once, in the gateway |
| Catalog shape | Whatever you write | Mirrors your routes — one tool per endpoint | Whatever you write, per domain |
| Authorization | You implement OAuth in each service | Usually a single shared API key | One OAuth perimeter; each app keeps its own ACLs |
| Agent sees | N connectors, N consent screens | N connectors, one credential's worth of rights | One endpoint, scope-filtered tools |
| Audit | Per service | "The integration did it" | One attributable line per call |
| Good when | You ship one product and MCP *is* the product | Prototype, internal tool, read-only public API | Several apps, real users, real permissions |

## Why "just generate it from the OpenAPI spec" disappoints

It is the tempting move and it demos well. Three things go wrong once an agent actually uses it.

**An endpoint is not a task.** REST decomposes a domain into resources; an agent needs the workflow that spans them. `POST /orders`, `GET /orders/{id}`, `PATCH /orders/{id}/status` and `GET /customers/{id}` are four tools that together mean "place an order for this customer" — a sequence the agent has to rediscover by trial and error on every conversation, because nothing in the spec says the third call requires the first.

**Catalogs cost context.** Every tool definition is re-sent on every request. A hundred generated tools push out the room the model needs to reason, and measurably degrade which tool it picks. Ten task-shaped tools beat a hundred endpoint mirrors, every time.

**OpenAPI has nothing to say about who is calling.** Security schemes describe *how* a credential travels, not *whose* it is. So the generated server holds one key, that key holds the union of everyone's rights, and the audit log names the integration instead of the person. That is the confused-deputy problem, shipped by default.

None of this means the spec is useless — it is a fine inventory of what your API *can* do while you decide which handful of tools an agent should *see*.

## The gateway path, in five steps

With [Cortex Gateway](https://github.com/wellknownmcp/cortex-gateway) in front, an application never becomes an MCP server. It stays a plain web service and exposes one endpoint the gateway knows how to call — the [backend contract](https://github.com/wellknownmcp/cortex-gateway/blob/main/docs/backend-contract.md), about 120 lines to implement from scratch.

### 1\. Add one POST endpoint

One route, JSON in, JSON out. No MCP library, no stdio, no SSE — `initialize`, sessions, Streamable HTTP and version negotiation live in the gateway, once.

```
POST /api/cortex/backend
Content-Type: application/json
Authorization: Bearer <token>
X-Cortex-User-Id / -User-Email / -User-Role / -Scopes

{ "method": "search_documents", "params": { "query": "q3 report" } }
```

The response is the method's return value, with ordinary HTTP status codes. Because it is just HTTP, the same endpoint remains callable from your tests, batch jobs and other integrations.

### 2\. Declare a tool catalog, not a route list

The single method every backend must implement is `list_tools`. Each tool names the OAuth scope it requires; the gateway filters the catalog per caller, so a read-only user never even sees the write tools.

```
{
  "name": "search_documents",
  "scope": "mcp:docs:read",
  "description": "Search documents by keyword.",
  "params": { "query": "string", "limit": "number?" },
  "version": "1.0.0"
}
```

Scopes follow `mcp:<domain>:<action>`. Write it for the agent, not for your router: name the task, describe when to use it, and let one tool span several internal calls if that is what the task means.

### 3\. Verify the caller — two token classes, one rule

The gateway sends two kinds of Bearer token, and conflating them is the one security mistake that matters here.

| Token | Sent for | Your backend must |
| --- | --- | --- |
| Static technical token | Catalog discovery only — `list_tools`, `list_prompts`, `list_resource_templates`, `get_snapshot` | Accept it for those methods and **refuse every other method with 403**. It carries no email and no role: it is not an identity. |
| The user's OAuth JWT | Every data method | Re-validate it against the same authorization server (signature, issuer, audience, expiry) and apply your existing ACLs. The `X-Cortex-*` headers are a convenience; the JWT stays the source of truth. |

Note what did *not* happen: you did not write a permission model for agents. The rules you already enforce for the human are the rules the agent inherits, because the call arrives as that human. See [securing an MCP server with OAuth 2.1](/guides/secure-mcp-with-oauth/) for the validation details.

### 4\. Distinguish "wrong scope" from "wrong role" in errors

A caller holding the right scope but lacking the role must not be told to go fetch more scopes — they will loop through consent forever.

| Status | Meaning |
| --- | --- |
| `403` with `{ "required": "mcp:docs:write" }` | Missing OAuth scope — the agent can ask for it |
| `403` without `required` | Application ACL: this person may not do this. No amount of consent changes that. |
| `400`/`500` with `{ "error": "..." }` | Business error, propagated verbatim to the agent |

### 5\. Register the backend and connect a client

```
CORTEX_BACKENDS=docs,billing
CORTEX_BACKEND_DOCS_URL=https://docs.internal.example.com
CORTEX_BACKEND_BILLING_URL=https://billing.internal.example.com
```

The gateway polls each catalog every 60 seconds, so shipping a new tool in your app makes it appear to connected agents without redeploying the gateway. Tools arrive namespaced — `docs_search_documents` — and any spec-compliant MCP client can reach them through one OAuth 2.1-protected URL.

## Teach the agent your domain, not just your signatures

A tool catalog says *what* can be called. It never says *why*, or *in what order*, or what a "workspace" is in your product. That explanation belongs in the application that owns the domain, versioned with the code, rather than copied into every client's system prompt. The contract reserves a method for it:

-   `get_help(topic?)` — your domain concepts, the two to five workflows that actually matter, naming and pagination conventions, quotas, and what the backend deliberately does not do. Connected agents are instructed to prefer it over guessing.
-   `report_missing_capability` — when an agent hits a gap, it files a ticket instead of hallucinating a tool. Your backlog of unmet agent needs assembles itself, at the backend that owns the domain.

Keep `get_help` honest and structured. An agent that follows stale documentation into an error stops trusting it, and you have lost more than you gained.

## Connecting your SaaS to Claude and other agents

Once an application sits behind the gateway, "connect it to an agent" is no longer per-application work. The user adds one connector, authenticates once against your authorization server, consents to a set of scopes, and their agent sees exactly the tools those scopes allow across every application you federated. One consent surface, one audit trail, and a single revocation that cuts access everywhere at once.

Client-side, it is a URL: see [claude.ai](/connect/claude-ai/), [Claude Desktop](/connect/claude-desktop/), [Claude Code](/connect/claude-code/), [OpenClaw](/connect/openclaw/) or [Hermes](/connect/hermes/). Any client implementing MCP over Streamable HTTP with OAuth 2.1 works the same way — the gateway implements the specification, not a particular vendor.

Already running third-party MCP servers? [They federate too](/guides/federate-third-party-mcp-servers/), through a proxy adapter that holds each user's own linked OAuth token in an encrypted per-user vault — so the provider sees the user's own account, seat and rate limits, never a shared service account.

## Try it in five minutes

Clone the repository and run the reference backend — a single dependency-free file implementing the full contract — then point the gateway at it:

```
node examples/demo-backend/server.mjs   # your "REST API", ~120 lines
docker run ghcr.io/wellknownmcp/cortex-gateway
```

Or skip the setup and probe the [hosted demo](https://mcp.cortex-gateway.dev/): sign up with a magic link, connect an agent, and watch a scope-filtered `tools/list` come back for your own account.

[Get started on GitHub →](https://github.com/wellknownmcp/cortex-gateway)

## FAQ

### Can I turn a REST API into an MCP server automatically from its OpenAPI spec?

You can generate one, and it will demo well. It rarely survives a real agent. OpenAPI describes endpoints, not tasks: a hundred CRUD routes become a hundred tools that flood the context window and say nothing about which sequence accomplishes anything. It is also silent on authorization, so generated wrappers ship one API key shared by every caller. The useful unit of an MCP catalog is the task the agent performs, not the route your REST design happened to expose.

### Do I need an MCP SDK inside my application?

Not behind a gateway. Transport and lifecycle — `initialize`, sessions, Streamable HTTP, SSE, version negotiation — are identical for every server, so they belong in one place. Your app stays a normal web service exposing one JSON endpoint, still callable from tests and batch jobs. The repository's reference backend implements the whole contract in about 120 dependency-free lines.

### How do I add an MCP server to my website or SaaS?

Decide who the agent acts for. Same data for everyone: a standalone read-only MCP server is enough. Acting for a signed-in user: the endpoint must be an OAuth 2.1 resource server, so each call carries that person's identity and your existing permission model still applies. A gateway gives you that perimeter once, in front of every app you run, rather than once per service.

### How many tools should an MCP server expose?

As few as make each real workflow completable. Tool definitions are re-sent on every request, so a large catalog costs tokens and degrades selection accuracy before any work happens. Prefer coarse, task-shaped tools; scope-filter the catalog so a caller sees only what they may use; and for large surfaces, serve a compact `tools/list` and let the agent fetch full schemas on demand.

### What is the difference between an MCP wrapper and an MCP gateway?

A wrapper is one adapter in front of one API — you end up with one per service, each with its own connector, consent screen and credential. A gateway is a single MCP server federating many services behind one endpoint, one OAuth perimeter and one audit trail. What really separates them is identity: a wrapper typically holds a shared credential, while an identity-propagating gateway carries the real user's token through to each application. More in [MCP gateway vs MCP server](/answers/mcp-gateway-vs-mcp-server/).

### Does my backend need to speak MCP to third-party agents directly?

No, and it is usually a mistake to try. Speaking MCP means owning session state, protocol version negotiation and an OAuth resource-server implementation in every service. Behind a gateway those exist once. Your services keep the one thing they cannot delegate: their own permission rules.
