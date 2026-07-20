<!-- https://cortex-gateway.dev/guides/secure-mcp-with-oauth/ -->

# Secure your MCP server with OAuth 2.1

**TL;DR**

A remote MCP server is an **OAuth 2.1 resource server**. You are not designing an authentication scheme; you are implementing four things the specification already fixed: publish `/.well-known/oauth-protected-resource`, answer unauthenticated calls with the exact `401` challenge clients wait for, validate the JWT *including its audience*, and enforce scopes. Then stop. The fifth thing — deciding whether *this* person may read *that* record — belongs to the application that owns the record, not to the MCP layer.

## The specification decided this for you

MCP's authorization model does not invent anything. It composes existing RFCs, which means the interoperability problem is already solved and your job is to not get creative:

| Concern | Standard | Who implements it |
| --- | --- | --- |
| Where is the authorization server for this resource? | RFC 9728 — protected resource metadata | Your MCP server |
| What endpoints does that authorization server have? | RFC 8414 — authorization server metadata | Your authorization server |
| How does an unknown agent client register? | RFC 7591 — dynamic client registration | Your authorization server |
| How is the code exchange protected? | RFC 7636 — PKCE (mandatory in OAuth 2.1) | Client + authorization server |
| Which resource is this token for? | RFC 8707 — resource indicators | Client, authorization server, and **your audience check** |
| How does the resource read the token? | RFC 6750 — Bearer + `WWW-Authenticate` | Your MCP server |
| Has this token been revoked? | RFC 7662 — introspection (optional) | Your MCP server, if you need it |

Local stdio servers are outside all of this: a subprocess your client spawned inherits the trust of the user who launched it. OAuth becomes non-negotiable the moment the endpoint is reachable over the network by an agent you did not start yourself.

## Why the API key you were about to use does not work

It fails on both questions a permission layer exists to answer.

**Who is the agent acting for?** A key has no subject. Your audit log records "the integration", which is worth nothing during an incident and worth less during an audit.

**What may that person do?** A key held by an agent that serves many users must hold the union of everyone's rights. Any user's agent can therefore reach any user's data — not by malice, just by asking. That is the confused deputy, and no amount of prompt engineering closes it, because the constraint has to live where the data does.

OAuth 2.1 replaces a standing credential with a *delegation*: bound to one person, scoped to one resource, revocable in one place. The [permission layer](/answers/agent-permission-layer/) page argues the architecture; this page is the wiring.

## 1\. Publish protected-resource metadata

One JSON document at a fixed path tells any client which authorization server may mint tokens for you, and which scopes exist.

```
GET /.well-known/oauth-protected-resource

{
  "resource": "https://mcp.example.com/mcp",
  "authorization_servers": ["https://auth.example.com"],
  "bearer_methods_supported": ["header"],
  "scopes_supported": ["mcp:docs:read", "mcp:billing:read", "mcp:billing:write"],
  "resource_documentation": "https://example.com/docs"
}
```

Keep `scopes_supported` derived from the live tool catalog rather than hand-maintained. In Cortex Gateway it is computed from the federated tools at request time, so shipping a tool with a new scope in one application makes that scope discoverable without touching the gateway.

## 2\. Answer with the challenge clients are waiting for

This is the single most common reason a connector "just doesn't work". An unauthenticated call must return `401` *with* a `WWW-Authenticate` header pointing at your metadata (RFC 9728 §5.1):

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"
```

A bare `401`, or a `403`, or a JSON-RPC error with status `200`, all produce the same symptom: the client never starts the authorization flow and the user sees a connector that fails silently. Clients such as claude.ai discover your authorization server *from this header* — there is no other input.

If the client is a browser, also expose the header across origins: `Access-Control-Expose-Headers: WWW-Authenticate, Mcp-Session-Id`. A challenge the browser cannot read is a challenge that was not sent.

## 3\. Validate the token — and check the audience

Fetch the authorization server's JWKS, verify the RS256 signature, check `iss` and `exp`. Then check the one field people skip: **`aud`**.

A token is not "valid"; it is valid *for a resource*. If your MCP server accepts any well-signed token from your authorization server, then a token your user granted to an unrelated application — a low-trust internal tool, a partner's integration — is silently accepted by your high-trust MCP endpoint. RFC 8707 exists precisely so the client can say which resource it wants a token for. Bind the audience to your canonical resource URI and reject everything else.

```
OAUTH_ISSUER=https://auth.example.com          # JWKS at /.well-known/jwks.json
CORTEX_CANONICAL_URI=https://mcp.example.com/mcp   # = expected audience
```

On revocation, be deliberate. A JWT stays valid until it expires, whatever happened at the authorization server in the meantime. If a revocation must take effect within seconds rather than within a token lifetime, add RFC 7662 introspection with a short cache; otherwise keep access tokens short-lived and rotate refresh tokens. There is no third option, and pretending otherwise is how "we revoked their access" becomes false in an incident report.

## 4\. Scopes, roles, and the line between them

Scopes and RBAC answer different questions, and merging them is the design error that quietly re-creates every problem OAuth was meant to solve.

|  | OAuth scope | Application role / ACL |
| --- | --- | --- |
| Question answered | What did the user allow *this agent* to do on their behalf? | What may *this user* do at all? |
| Granularity | Coarse capability — `mcp:billing:write` | Per record, per team, per state |
| Lives in | The token | The application that owns the data |
| Changes when | The user consents or revokes | Your business rules change |
| If you confuse them | Your permission model is copied into tokens, drifts from the source of truth, and can no longer be changed without re-issuing consent. |

Enforce the scope twice — filter `tools/list` so an agent never sees a tool it may not call, then re-check on `tools/call` — and let the application enforce the role. Keep the two refusals distinguishable, because they mean opposite things to an agent:

| Response | What the agent should do |
| --- | --- |
| `403` with `{ "required": "mcp:billing:write" }` | Ask the user to grant that scope |
| `403` without `required` | Stop. This person may not do this, and consent will not change it. |

An agent told to "go get more scopes" for what is actually a role denial will loop through your consent screen forever.

## 5\. Multi-tenancy: never trust a tool argument

The tenant is not a parameter. An agent can put any string in `{ "tenantId": "..." }`, and a model that has been talked into it will. Derive the tenant from the *verified token* — a `pool` or tenant claim checked at the perimeter — then propagate it as verified user context to the applications behind, which scope every query by it. The rule generalizes: **anything an agent can type is untrusted input**, including identifiers that look like plumbing.

Cortex Gateway can additionally refuse any token whose `pool` claim does not match the deployment, which turns a shared authorization server into isolated populations without a per-tenant deployment.

## The four gotchas that cost real days

-   **The issuer behind a reverse proxy.** Your framework computes URLs from the request it sees — `http://localhost:3000` — while clients and token audiences use the public origin. Every discovery document and every audience check then disagrees with reality. Configure the canonical URI explicitly; never derive it from the inbound request. [Symptoms and fix →](/answers/mcp-oauth-issuer-behind-proxy/)
-   **The missing challenge.** Covered above, and worth repeating: no `WWW-Authenticate`, no flow. It is the top cause of "the connector does nothing". [Five causes, ranked →](/answers/mcp-connector-does-nothing/)
-   **Dynamic client registration.** Agent clients are not in your database and cannot be added by hand. Without RFC 7591 support at the authorization server, each new client is a manual ticket, and some clients simply give up.
-   **Session and SSE behaviour.** Streamable HTTP clients differ in how they handle `Mcp-Session-Id`, reconnection and long-lived streams. This is where a specification-compliant implementation and a working one diverge, and where reading someone else's tested code is worth more than reading the spec again.

## Do it once, in front of everything

Everything on this page is per-server work: discovery document, challenge, JWKS validation, audience binding, scope filtering, introspection, session handling. Implementing it in each of your applications means maintaining an OAuth resource server per application — and then, for the user, one connector and one consent screen per application.

[Cortex Gateway](https://github.com/wellknownmcp/cortex-gateway) implements it once, in front of all of them. Each application behind it stays a plain web service that [exposes one HTTP endpoint](/guides/rest-api-to-mcp-server/), re-validates the propagated JWT, and keeps enforcing its own rules. The gateway makes no authorization decision of its own — it carries identity and refuses what the scopes do not allow. There is nothing new to trust, which is the only property that makes a component sitting in front of everything acceptable.

The repository ships a complete demo authorization server (dynamic client registration, PKCE, magic-link signup, introspection, revocation) so the OAuth side is a working reference rather than an exercise. The [hosted demo](https://mcp.cortex-gateway.dev/) is the same code: probe the `401`, read the metadata, run the flow.

[Get started on GitHub →](https://github.com/wellknownmcp/cortex-gateway)

## FAQ

### Does MCP require OAuth?

For remote servers, yes in practice: the MCP authorization specification models the MCP server as an OAuth 2.1 resource server and the client as an OAuth client, with PKCE, protected-resource metadata (RFC 9728) and authorization-server metadata (RFC 8414). A local stdio server spawned by your client inherits that process's trust and uses no OAuth at all.

### Why is a static API key not enough?

It answers neither question. A key has no subject, so the audit trail names the integration instead of the person. And a key serving many users must hold the union of everyone's rights, so any user's agent can reach any user's data — the confused-deputy problem. OAuth replaces the standing credential with a delegation: one person, one resource, one revocation.

### How do OAuth scopes relate to RBAC?

A scope is a coarse capability the user delegated to *this agent*. A role is what your application already decided *the user* may do. Scopes bound the agent's authority to a subset of the user's; roles bound the user's. Encoding roles as scopes copies your permission model into tokens, where it goes stale. Filter the catalog by scope, let the application enforce the role, and keep the two refusals distinguishable.

### How do you make an MCP server multi-tenant?

Never from a tool argument — an agent can pass anything. Derive the tenant from a verified claim in the token, check it at the perimeter, and propagate it as verified context to applications that scope every query by it. Enforce audience binding too: a token minted for another resource by the same authorization server must be rejected, not trusted.

### Does a valid JWT mean the token has not been revoked?

No. It is valid until it expires, whatever happened at the authorization server. For revocation within seconds, add RFC 7662 introspection with a short cache; otherwise keep access tokens short-lived and rotate refresh tokens. Decide on purpose — this is where the stateless-token story has a real cost.

### Which authorization server works with MCP?

Any OAuth 2.1 server issuing RS256 JWTs with a JWKS endpoint and PKCE. Dynamic client registration (RFC 7591) matters in practice, since agent clients are not pre-registered and cannot be onboarded by hand. The Cortex Gateway repository ships a complete demo authorization server as a starting point.

### Should the gateway or the application enforce permissions?

The application. A gateway that decides who may read what has to mirror every application's rules, and mirrors drift — while concentrating authority in the one component that talks to everything. Enforce scopes at the perimeter (an agent must not exceed what its user delegated), enforce everything else where the data lives, and re-check at both layers.
