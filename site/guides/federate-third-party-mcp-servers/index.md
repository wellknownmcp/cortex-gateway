<!-- https://cortex-gateway.dev/guides/federate-third-party-mcp-servers/ -->

# Federate third-party MCP servers without sharing credentials

**TL;DR**

Putting several native MCP servers behind one endpoint is easy. Doing it *without flattening identity* is the whole problem. The usual aggregator configures one credential per downstream server, so every caller shares it and the provider sees a single over-privileged account. The alternative: each user **links their own account once**, their grant is sealed in a per-user encrypted vault, and at call time the proxy presents *their* token. The provider sees their seat, their rate limits, their audit trail. One consent per provider per user — that part is non-negotiable OAuth, not a design choice.

Status: the proxy adapter is **beta**. Its protocol layer is covered by unit tests against the MCP specification (2025-06-18); it is not certified against any particular commercial provider. Tools only in V1 — downstream prompts and resources are not projected, and interactive features (sampling, elicitation) do not cross the bridge.

## What the adapter actually is

It is an MCP *client* pointed downstream, wearing the plain backend contract upstream. It absorbs everything protocol-shaped — `initialize`, sessions, version negotiation, SSE framing — and exposes the same one-endpoint HTTP contract that [your own applications](/guides/rest-api-to-mcp-server/) implement. The gateway core does not learn anything new: it federates the adapter like any other backend.

```
[Agent] ──our JWT──▶ [gateway] ──our JWT──▶ [adapter route]
                                                 │  the USER's downstream token (vault)
                                                 ▼
                                        [mcp.provider.example / ...]
```

Notice where the identity changes hands. Your OAuth JWT never leaves your perimeter; the adapter is the translator, mapping your subject to that user's provider token. Two identity domains, one explicit boundary, no shared account anywhere.

## 1\. Declare the downstream servers, federate them as loopback backends

Each proxied server gets an id, an endpoint, and a Cortex scope. Then each is federated by pointing a backend entry back at the gateway's own adapter route:

```
# downstream targets
CORTEX_MCP_SERVERS=canva,figma
CORTEX_MCP_CANVA_URL=https://mcp.canva.com/mcp
CORTEX_MCP_FIGMA_URL=https://mcp.figma.com/mcp

# federate them like any backend — pointing back at the gateway itself
CORTEX_BACKENDS=studio,canva,figma
CORTEX_BACKEND_STUDIO_URL=http://127.0.0.1:4001          # your own application
CORTEX_BACKEND_CANVA_URL=http://127.0.0.1:3213
CORTEX_BACKEND_CANVA_PATH=/api/mcp-adapter/canva/backend
CORTEX_BACKEND_FIGMA_URL=http://127.0.0.1:3213
CORTEX_BACKEND_FIGMA_PATH=/api/mcp-adapter/figma/backend
```

Tools come out as `canva_*`, `figma_*`, `studio_*`: one uniform catalog, namespaced by source, [filtered per caller by scope](/guides/secure-mcp-with-oauth/). Your own application and a third-party service are indistinguishable to the agent — which is the point.

## 2\. Provision the vault

```
CORTEX_VAULT_KEY=<32 bytes, base64>     # openssl rand -base64 32
CORTEX_DATABASE_URL=postgresql://...    # required by the vault
```

Downstream access and refresh tokens are AES-256-GCM encrypted at rest, keyed by the user's OAuth subject. The key lives only in `CORTEX_VAULT_KEY`. Rotating it invalidates every stored grant and forces users to re-link — which is the correct behaviour, and a real operational event to plan for rather than discover.

Treat the vault database and its key as crown jewels. They are the one place in this architecture where holding something valuable is unavoidable, and the reason the gateway is **self-hosted**: on a hosted tool platform, that vault is somebody else's.

## 3\. Each user links their accounts, once

Every provider demands its own consent screen. No architecture removes that, and any product that claims to has put a shared account somewhere.

```
GET /api/link/canva/start?token=<the user's Cortex JWT>
  → 302 to the provider's consent screen → callback → "canva linked ✓"
```

Under the hood, the flow does what a well-behaved OAuth client does: RFC 9728 discovery of the provider's authorization server, dynamic client registration (RFC 7591) when no static client is configured, PKCE, and an AES-GCM-sealed self-contained `state` so no server-side session is needed. The resulting grant lands in the vault, and the adapter refreshes it silently from then on.

**Linked once, identified on the whole bundle.** A user unlinks with `POST /api/link/<server>/unlink`.

## 4\. Runtime: whose token, and when

The agent calls `canva_create_design`. The gateway routes to the adapter; the adapter verifies the Cortex JWT, looks up *that caller's* Canva token in the vault, refreshes it if expired, speaks real MCP to the provider, and returns the result.

Two failure modes, deliberately distinguishable — because they demand opposite things from the agent:

| Situation | What the agent sees | What it should do |
| --- | --- | --- |
| User has not linked the provider | `403`, ACL-shaped, carrying the link URL | Ask the user to link. More scopes will not help. |
| Token lacks the provider's Cortex scope | The provider's tools are **absent from `tools/list`** | Nothing — it never saw them. Least privilege. |

These compose usefully. If your authorization server grants `mcp:canva:read` only to users who completed linking, unlinked users never see the `canva_*` tools at all: the gateway already filters the catalog by scope. Downstream `401`s are mapped to that ACL-shaped `403` upstream — "re-link your account" — and never confused with a missing Cortex scope. A caller told to fetch more scopes for what is actually a broken link will loop through consent forever.

## 5\. The non-obvious part: discovering the catalog

Here is the problem nobody anticipates. The gateway refreshes its catalog every 60 seconds by calling `list_tools` with a **static technical token** that carries no identity — deliberately, so a compromised catalog call can read nobody's data. But most commercial MCP servers require authentication even for `tools/list`. The background job therefore has no way to ask what tools exist.

The resolution is to nominate one linked account for discovery only:

```
CORTEX_MCP_CANVA_CATALOG_SUB=<the sub of a linked account>
```

That account's token is used to enumerate the provider's tools, and **only** for that. Every actual tool invocation still uses the calling user's own token. The distinction is the whole security argument in miniature: reading a catalog is not acting on data, and the two must not share a credential.

If discovery quietly returns nothing, the symptom looks exactly like every other empty-catalog cause — see [why `tools/list` comes back empty](/answers/mcp-tools-list-empty/).

## What you are and are not buying

| Property | Shared-credential aggregator | Per-user vault |
| --- | --- | --- |
| Provider sees | One account, everyone's rights | Each user's own account |
| Rate limits, seats | Pooled, and exhausted by the noisiest user | Per user, as the provider intends |
| Provider-side audit | "the integration did it" | "this person did it" |
| Consent screens | One, at setup, by an admin | One per provider per user |
| Blast radius of a breach | Every user's data at that provider | The vault — encrypted, in your perimeter |

The honest cost is the consent screens. Per-user linking is more friction than an admin pasting an API key once, and if a provider genuinely has no per-user permissions to preserve, that friction buys you nothing but the audit trail. Decide per provider.

## Limits worth knowing before you commit

-   **Tools only, in V1.** Downstream prompts and resources are not projected upstream. Interactive MCP features — sampling, elicitation — do not cross the bridge.
-   **One scope per provider.** All tools of a downstream server share a single Cortex scope; per-tool scope mapping is future work. If a provider mixes read and write tools, your scope is as coarse as its worst tool.
-   **Session cache is in-process.** Multi-instance deployments re-initialize per instance. Harmless — just extra handshakes.
-   **Licensing.** Federation moves *access*, not licences. Each user links their own account and must hold the appropriate plan or seat. Read each provider's terms before re-exposing their MCP server; re-exposing a service under a shared account is precisely what per-user linking exists to avoid.

## Where this sits

This is the third gateway archetype from [MCP gateway vs MCP server](/answers/mcp-gateway-vs-mcp-server/), applied to servers you did not write. A router puts one credential in front of N MCP servers. This puts *each user's own identity* in front of them — and the gateway in the middle still decides nothing, holds no standing rights of its own, and mirrors no permission rules.

Full configuration reference: [the MCP adapter documentation](https://github.com/wellknownmcp/cortex-gateway/blob/main/docs/mcp-adapter.md).

[Get started on GitHub →](https://github.com/wellknownmcp/cortex-gateway)

## FAQ

### How do I aggregate several MCP servers behind one endpoint?

Put a gateway in front that terminates MCP for the agent and acts as an MCP client toward each downstream server, absorbing `initialize`, sessions, negotiation and SSE, then presenting one uniform catalog namespaced per provider. The design question is not routing but credentials: one shared token, or each user's own.

### How can a proxied MCP server still see each user's own account?

The user links their account once through an authorization code flow at the provider; the resulting grant is sealed in a vault keyed by their subject. At call time the adapter presents *their* token, refreshing as needed. The provider sees their seat, their rate limits, their audit trail — never a shared service account.

### Does an MCP proxy have to hold one shared credential for all users?

No, and that is what separates an aggregating router from an identity-propagating gateway. Downstream credentials configured at the proxy are shared by every caller, flattening the provider's per-user permissions and naming the integration in its audit log. Per-user tokens preserve both, at the cost of one consent screen per provider per user.

### What happens when a user has not linked a provider?

If the scope is granted only to linked users, the provider's tools never appear in `tools/list`. If the scope is present but no grant is stored, the call returns an ACL-shaped `403` carrying the link URL — deliberately distinct from a missing-scope error, so the agent asks the user to link rather than to consent to more scopes.

### How does the gateway discover the tools of an authenticated third-party server?

The periodic refresh uses a static technical token with no downstream identity, but commercial MCP servers usually require auth even for `tools/list`. Nominate one linked account (`CORTEX_MCP_<ID>_CATALOG_SUB`) whose token serves discovery *only*; every real invocation uses the calling user's own token.

### Does federating a provider give my users access to their product?

No. Federation moves access, not licences. Each user links their own account and must hold whatever plan or seat the provider requires. Check their terms before re-exposing their MCP server.

### What happens if I rotate the vault key?

Every stored grant becomes unreadable and users must re-link. That is correct behaviour, and a planned operational event — not something to discover during an incident.

### Is the adapter production-ready?

It is beta. The protocol layer is unit-tested against the MCP specification (2025-06-18) but not certified against any specific commercial provider, and V1 projects tools only. Treat a new provider as an integration to validate, not a checkbox.
