<!-- https://cortex-gateway.dev/answers/mcp-gateway-vs-mcp-server/ -->

# MCP gateway vs MCP server: what's the difference?

**TL;DR**

An **MCP server** implements the protocol and exposes tools it owns. An **MCP gateway** is also an MCP server — clients cannot tell, and should not have to — but its tools belong to other systems. The gateway owns the protocol; the systems behind it own the domain. Whether something is called a gateway, a router, a proxy or a hub matters far less than one question: **what happens to the user's identity as a call passes through it?** Either it is replaced by a shared credential, and every caller becomes the same over-privileged actor, or it is propagated, and each application keeps enforcing its own rules.

## The definitions, briefly

|  | MCP server | MCP gateway |
| --- | --- | --- |
| Speaks MCP to the client | Yes | Yes — indistinguishable from a server |
| Owns the tools | Yes — it *is* the domain | No — they come from applications, APIs or other MCP servers |
| Tool catalog | Static, written in the code | Federated: aggregated from backends, refreshed as they deploy |
| Typical count | One per application | One per organization |
| The client sees | One connector per application | One connector, tools namespaced by their source |

Note what the gateway is not: it is not a proxy in the transparent sense. It terminates the protocol, holds the session, answers `initialize`, and hands the agent a catalog assembled from several places. The backends behind it may not speak MCP at all.

## Three things people call a gateway

The word covers three architectures with very different consequences. The interesting axis is not features; it is what happens to identity.

### The router (aggregation)

One endpoint in front of several existing MCP servers, dispatching each call to whichever server owns the tool. Downstream credentials are configured at the router, so every caller shares them and any per-user permissions the underlying servers had are flattened on the way through. Access control, if any, is re-implemented as router rules — a second permission model, drifting from the first.

This is a genuinely good fit for a personal setup, or for tools that have no per-user permissions to lose in the first place. It is the wrong shape the moment two people in an organization should legitimately see different data.

### The hosted tool platform

A vendor runs the connectors, holds the OAuth tokens for hundreds of SaaS products, and gives your agent one endpoint. The catalog is enormous and you maintain none of it. In exchange the vendor's infrastructure holds your users' tokens, sees every tool call, and becomes a sub-processor in your compliance scope. Perfectly reasonable trade — as long as it was a trade you made on purpose. The [Composio](/alternatives/composio/) and [Pipedream](/alternatives/pipedream/) pages compare that model to self-hosting without pretending either is universally right.

### The identity-propagating federation gateway

One OAuth 2.1 perimeter, and nothing behind it holds anyone else's rights. The user authenticates once against *your* authorization server; the gateway validates the token, filters the catalog to that user's scopes, and passes their identity through to each application, which applies the permission model it already had. For third-party MCP servers, it passes the user's *own* linked token from a per-user encrypted vault, so the provider sees that person's account, seat and rate limits.

The defining property is what the gateway does *not* do: it makes no authorization decision, holds no standing credential, and mirrors no permission rules. It carries identity and refuses what the scopes forbid. There is nothing new to trust — which is the only property that makes a component sitting in front of everything acceptable.

|  | Router | Hosted platform | Federation gateway |
| --- | --- | --- | --- |
| Identity reaching the backend | The router's credential | The vendor's stored token | The real user's |
| Permission model | Re-implemented at the router | The vendor's, plus the app's | Unchanged — the app's own |
| Audit line reads | "the router" | "the platform" | "this person's agent" |
| Revocation | Rotate the shared credential | At the vendor | One OAuth revocation, everywhere |
| Token custody | Config file | The vendor | Your perimeter, per user, encrypted |

## When you do not need a gateway

One application, one MCP server, one connector. A gateway adds a hop and a moving part in exchange for nothing. Ship the server.

The same holds for a handful of MCP servers used by one person on one laptop: separate connectors already keep each provider's native per-user permissions, which is the property that matters. Aggregation is not a virtue in itself.

## When a gateway starts paying for itself

Not when you have "several servers" — when the *operational surface* of those servers becomes the problem:

-   **Consent.** N connectors mean N authorization flows per employee, N times to onboard, N to offboard. One perimeter means one.
-   **Revocation.** Someone leaves. Either one revocation cuts every application at once, or you go hunting.
-   **Audit.** One pseudonymized line per call, in one place, naming the person — instead of N logs in N formats naming N integrations.
-   **Entitlements.** Scopes that mean something across applications: a scope is granted once and gates tools in three systems. Free and paid tiers with no paywall logic anywhere.
-   **Context budget.** Every tool definition is re-sent on every request. One filtered catalog beats several unfiltered ones — and filtering by the caller's scopes means an agent never sees a tool its user may not call.

Notice that per-user permissions are absent from this list. Separate connectors already give you those. A gateway that *loses* them in exchange for the items above is a bad trade; the point of federation is to get the operational surface of one connector while keeping the permission model of N.

## What a gateway must never do

Because it sits in front of everything, a gateway's failure modes are the organization's failure modes. Two rules follow.

**It must not hold rights of its own.** A gateway with a credential for each backend is a single component holding the union of everyone's access. Compromise it and the blast radius is total; audit it and every line names the gateway.

**It must not re-implement the applications' rules.** Mirrored permissions are copies with a half-life. The application that owns a record already knows who may read it — and will still know after next quarter's refactor, which the mirror will not survive. Enforce the delegation boundary at the gateway (an agent may not exceed its user's granted scopes), and everything else where the data lives. Re-check at both layers; defense in depth is cheap when neither layer is inventing anything.

This is the [replicate-versus-delegate](/answers/agent-permission-layer/) distinction, applied to the component in the middle.

## Concretely

[Cortex Gateway](https://github.com/wellknownmcp/cortex-gateway) is the third archetype, self-hosted and MIT-licensed: one spec-compliant MCP server over Streamable HTTP, protected by OAuth 2.1, federating applications that expose [a single plain-HTTP endpoint](/guides/rest-api-to-mcp-server/) — no MCP library in your services. Catalogs refresh in the background, so a tool shipped in one application appears to connected agents without a gateway redeploy. Native third-party MCP servers federate through a proxy adapter with a per-user encrypted token vault.

The [company-federation worked example](/use-cases/company-federation/) shows the shape at organization scale: one application per department, scopes as the org chart, one connector for everyone. If you are earlier than that, the [hosted demo](https://mcp.cortex-gateway.dev/) takes about thirty seconds.

[Get started on GitHub →](https://github.com/wellknownmcp/cortex-gateway)

## FAQ

### What is the difference between an MCP gateway and an MCP server?

A server implements MCP and exposes tools it owns. A gateway is also an MCP server — clients cannot tell — but its tools belong to other systems. The gateway owns the protocol; the systems behind it own the domain. The question that actually matters is what it does with identity: hold one credential in front of everything, or carry each user's identity through to the system that enforces their permissions.

### Is an MCP gateway just an API gateway for MCP?

Only superficially. Both route and apply cross-cutting concerns. Only the MCP gateway has to federate a *catalog*: aggregate tool definitions from every backend, filter them per caller, keep them fresh, and push changes to connected agents. That catalog is re-sent to the model on every request, which makes its size a design concern with no API-gateway equivalent.

### Do I need an MCP gateway for a single MCP server?

No. One application, one connector — a gateway would add a hop for nothing. It starts paying at the point where users would otherwise install several connectors: one consent surface, one audit trail, one revocation, cross-application scopes, and a catalog you can filter.

### What is an MCP router?

The aggregation archetype: one endpoint in front of several existing MCP servers. Routers typically configure downstream credentials at the router, so every caller shares them and per-user permissions are flattened. Good for personal setups and for tools with no per-user permissions to lose; wrong wherever two people should legitimately see different data.

### Does a gateway add latency to tool calls?

One hop, usually inside your own network, on calls already dominated by model generation and backend work. Catalog operations do not reach the backends at all — `tools/list` is served from a cache refreshed in the background. The filtered catalog usually saves more model time than the hop costs.

### Should the gateway enforce permissions?

It should enforce the delegation boundary — an agent may not exceed the scopes its user granted — and nothing else. Fine-grained authorization belongs to the application that owns the data. A gateway that decides who may read what must mirror every application's rules, and mirrors drift while concentrating authority in the one component that talks to everything.

### Can a gateway federate MCP servers it did not write?

Yes, through a proxy adapter that speaks MCP downstream. The design question is whose credential it presents. Holding one shared token for all callers re-creates the router's flattening; holding each user's own linked token in a per-user encrypted vault preserves the provider's per-user permissions, seats and rate limits. Worked example: [federating third-party MCP servers](/guides/federate-third-party-mcp-servers/).
