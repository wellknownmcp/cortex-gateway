<!-- https://cortex-gateway.dev/alternatives/open-source-mcp-gateways/ -->

# Best open-source MCP gateways (2026): an honest comparison

**Transparency.** This page is written by the maintainers of Cortex Gateway, one of the seven projects below. We rank nothing. Each entry says what the project is for and where it beats us — three of them beat us at things we do not attempt at all. Everything is verified from each project's own repository and documentation, **last checked 9 July 2026**. No commercial relationship with any project listed. Corrections welcome as a GitHub issue.

**TL;DR**

Seven projects share the name "MCP gateway" and solve four different problems. Before comparing features, ask the two questions that actually separate them: **whose credential reaches the downstream server** — one shared by every caller, or each user's own? And **where is the authorization decision made** — at the gateway, or in the application that owns the data? Everything else is packaging. If you are one developer on a laptop, none of this matters and you want *1MCP* or *Docker MCP Gateway*.

## The two axes

Feature tables go stale in six weeks. These two questions do not, because they are architecture rather than roadmap.

**Axis 1 — whose credential goes downstream.** A gateway that stores one API token per backend presents that token for every caller. The backend then sees a single account holding the union of everyone's rights, its rate limits are pooled, and its audit log names the integration. A gateway that carries each user's own token preserves all three. The cost is real: one consent screen per provider per user.

**Axis 2 — who decides.** Either the gateway holds rules — ACLs, RBAC, a policy engine — that mirror what your applications already know, or it holds none and lets each application enforce its own model on a propagated identity. Mirrors are attractive because they look like control, and they drift: every copied permission is a liability with a half-life, concentrated in the one component that talks to everything.

Neither answer is universally right. A Kubernetes data plane *should* enforce policy at the edge; that is what a data plane is. An enterprise agent platform in front of applications that already have permission models should not re-implement them. Pick the axis position your situation demands, then pick the tool.

## Pick by what you are actually doing

| If you want… | Use |
| --- | --- |
| To run several MCP servers for yourself, on your laptop, with your coding agent | **1MCP** |
| To sandbox MCP servers you do not trust, in containers, with managed secrets | **Docker MCP Gateway** |
| Prompt-injection and PII guardrails between your agent and its tools | **Lasso mcp-gateway** |
| A small team, a self-hosted registry with per-client ACLs, and no OAuth server of your own | **MCPJungle** |
| Enterprise federation of MCP + A2A + REST behind one governed endpoint, on Kubernetes, with a vendor behind it | **IBM ContextForge** |
| A policy-driven data plane proxy for agent traffic, with RBAC as code | **agentgateway** |
| Each user's own identity to reach every application, so each application enforces its own permissions — and nothing new to trust in the middle | **Cortex Gateway** |

Note that five of these seven rows are not competitive with the last one. That is the honest state of this category: the word "gateway" is doing far too much work.

## The seven, in detail

### [IBM ContextForge](https://github.com/IBM/mcp-context-forge) — the enterprise federation platform

Apache-2.0, v1.0.x, reached 1.0 GA in June 2026, roughly 4.1k GitHub stars. Federates MCP servers, A2A servers and REST/gRPC APIs into one MCP-compliant endpoint, with centralized governance and observability across multi-cluster Kubernetes.

On axis 1 it is **configurable**, which is worth stating precisely because it is often mischaracterized: it supports user-scoped OAuth tokens and forwards a caller's bearer token between federated gateways, *and* it can hold gateway-side credentials encrypted with an `AUTH_ENCRYPTION_SECRET`. You choose. On axis 2 it carries RBAC of its own.

**Where it beats us:** breadth, plainly. A2A and REST/gRPC federation, multi-cluster operations, observability, and an actual vendor. If you are standardizing agent access across a large organization and you already run Kubernetes, this is the serious answer. **The cost:** it expects real Kubernetes investment and a platform team; rollouts are measured in weeks, not an afternoon.

### [agentgateway](https://github.com/agentgateway/agentgateway) — the data plane

Apache-2.0, a Linux Foundation project, roughly 3.8k stars. A proxy built on MCP and A2A for agent-to-tool, agent-to-agent and agent-to-LLM traffic, with JWT, API-key and OAuth authentication, tool federation, and fine-grained RBAC driven by a CEL policy engine.

Axis 2 is its entire premise: the authorization decision lives at the gateway, expressed as policy. This is the correct shape for a data plane — it is what Envoy-lineage infrastructure is for, and policy-as-code is a feature, not a compromise, when the gateway *is* your network's control point.

**Where it beats us:** if your organization already treats the mesh as the enforcement layer, agentgateway fits your operational model and Cortex does not. It also has performance engineering we have not attempted. **The trade:** your applications' permission rules now exist in two places, and the second copy must be kept honest.

### [MCPJungle](https://github.com/duaraghav8/MCPJungle) — the small-team registry

MPL-2.0, v0.4.5, roughly 1.1k stars. A self-hosted MCP gateway and registry in one binary: register servers, discover tools, control which clients reach which servers.

Verified on both axes. Downstream credentials — a bearer token, custom headers — are supplied when a server is *registered*, so every caller of that server shares them. Callers authenticate with static tokens the gateway issues, per MCP client or per human account; its documentation lists OAuth as **not yet supported**. Access control is gateway ACLs, tool groups and admin/standard roles.

**Where it beats us:** you can be running in ten minutes without owning an OAuth 2.1 authorization server, and for tools that have no per-user permissions to lose — a weather API, a search index — there is nothing to preserve and its model costs you nothing. **Where it does not:** the moment two people in your organization should legitimately see different data, shared downstream credentials cannot express that, and the gateway ACLs become a second permission model to maintain.

### [Docker MCP Gateway](https://github.com/docker/mcp-gateway) — the sandbox

MIT, roughly 1.5k stars. The Docker CLI plugin that powers Docker Desktop's MCP Toolkit. Runs MCP servers in isolated containers, gives `npx` and `uvx` servers minimal host privileges, and keeps API keys out of environment variables through `docker mcp secret`. Built-in OAuth flows for connecting to external services.

Neither axis applies: there is no end-user authentication layer, because it is a **single-user developer tool**.

**Where it beats us, unambiguously:** isolation. Running an MCP server you did not write, from an npm package you have not read, directly on your machine is the most under-discussed risk in this ecosystem. Docker's answer is a container. **Cortex does not sandbox anything** — it assumes the backends behind it are yours, or are remote services you reach over HTTPS. These are complementary tools, not alternatives.

### [1MCP](https://github.com/1mcp-app/agent) — the personal runtime

Apache-2.0, v0.34.x, roughly 469 stars. A unified runtime that aggregates your MCP servers into one `serve` process, aimed at coding agents — Claude Code, Codex, Cursor — to cut configuration sprawl and shrink the working surface.

Its repository documents configuration and lifecycle rather than credential scoping; we did not find a clear statement of its per-user model and **we make no claim about it here**. The intended shape is a personal aggregator, where "which user" has a single obvious answer.

**Where it beats us:** it is the right tool for the job we are not doing. One developer, one machine, several MCP servers, less configuration. Deploying an OAuth 2.1 perimeter to solve that would be absurd.

### [Lasso mcp-gateway](https://github.com/lasso-security/mcp-gateway) — the guardrail

MIT, roughly 377 stars, Python, latest release January 2026. A *local* proxy between an LLM and its MCP servers that intercepts requests and responses to detect prompt injection, mask PII, sanitize tokens, and scan server reputation before loading.

It is on this list because it is called an MCP gateway and it will appear in your search results. It solves an orthogonal problem: **content** safety, not identity. **Cortex does none of what it does** — no prompt-injection detection, no PII masking, no reputation scanning — and it authenticates no end users. Read them as complementary layers.

### [Cortex Gateway](https://github.com/wellknownmcp/cortex-gateway) — identity propagation, and nothing else

MIT. An OAuth 2.1 resource server: one spec-compliant MCP endpoint over Streamable HTTP in front of N applications, each of which exposes [one plain HTTP endpoint](/guides/rest-api-to-mcp-server/) rather than embedding an MCP library. The user's JWT is propagated to first-party applications; third-party MCP servers receive [that user's own linked token](/guides/federate-third-party-mcp-servers/) from a per-user AES-256-GCM vault.

On axis 1: per-user, always, with no configuration that would make it otherwise. On axis 2: the gateway makes **no authorization decision**. It enforces the delegation boundary — an agent may not exceed the scopes its user granted — and refuses everything else to the application that owns the data. Because it decides nothing and holds no standing rights, there is nothing new to trust.

**What it costs you.** An OAuth 2.1 authorization server issuing RS256 JWTs with a JWKS endpoint. The repository ships a complete demo one — dynamic client registration, PKCE, magic-link signup, introspection, revocation — but if you have no identity provider and no intention of getting one, MCPJungle will make you happier this week.

**What it does not do.** No policy engine. No container sandboxing. No prompt-injection guardrails. No A2A or REST federation. No observability stack. The third-party proxy adapter is **beta** — protocol layer unit-tested against MCP 2025-06-18, not certified against any specific commercial provider, tools only in V1, one scope per proxied provider.

## The comparison that survives a version bump

| Project | Downstream credential | Authorization decided | Scope | Licence |
| --- | --- | --- | --- | --- |
| IBM ContextForge | Configurable — user-scoped OAuth or gateway-held, encrypted | Gateway RBAC (+ downstream) | Enterprise, Kubernetes | Apache-2.0 |
| agentgateway | Gateway | Gateway, CEL policy engine | Data plane proxy | Apache-2.0 |
| MCPJungle | Gateway, set at registration, shared | Gateway ACLs and roles | Team registry | MPL-2.0 |
| Docker MCP Gateway | Local secrets store | n/a — single user | Dev tool, sandboxing | MIT |
| 1MCP | Local configuration | n/a — single user | Personal runtime | Apache-2.0 |
| Lasso mcp-gateway | n/a | n/a — content guardrails | Local safety proxy | MIT |
| Cortex Gateway | The user's own, per-user encrypted vault | The application that owns the data | Access layer | MIT |

## How we checked

Each project's own repository and documentation, read on 9 July 2026. Licences, version numbers, credential handling and access-control model are taken from primary sources — not from other comparison pages, most of which are published by vendors selling a seventh gateway. Star counts are approximate and are the fastest-moving number here; treat them as a rough maturity signal and nothing more.

What we did **not** do: production benchmarks, load testing, or long-running deployments of the six projects that are not ours. Where a repository did not state something clearly — 1MCP's credential scoping — we say so instead of inferring it. If you maintain one of these projects and we have described it wrongly, open an issue on [our repository](https://github.com/wellknownmcp/cortex-gateway) and we will correct this page.

## And the case for no gateway at all

Worth saying, on a page like this. One application and one MCP server: skip the gateway. Separate connectors already preserve each provider's native per-user permissions — that is the baseline, not a differentiator someone sells you. A gateway earns its place when the *operational surface* of many connectors becomes the problem: one consent perimeter instead of N, one attributable audit trail, one revocation that cuts everything at once, scopes that mean something across applications, and a tool catalog that [does not flood the agent's context](/answers/mcp-too-many-tools/).

A gateway that gives you that surface but *loses* per-user permissions along the way has sold you a downgrade. The point of federation is the operational surface of one connector with the permission model of N. The reasoning in full: [MCP gateway vs MCP server](/answers/mcp-gateway-vs-mcp-server/).

[Get started on GitHub →](https://github.com/wellknownmcp/cortex-gateway)

## FAQ

### What is the best open-source MCP gateway?

There is no single best one — these projects solve four different problems under one name. Enterprise federation of MCP, A2A and REST on Kubernetes: **IBM ContextForge**. A policy-driven data plane: **agentgateway**. A lightweight self-hosted registry with per-client ACLs and no OAuth server of your own: **MCPJungle**. One developer on a laptop: **1MCP** or **Docker MCP Gateway**. Each user's own identity reaching every application, with each application enforcing its own permissions: **Cortex Gateway**, which is ours.

### What actually differs between MCP gateways?

Two questions. Whose credential reaches the downstream server — one shared by every caller, or each user's own? And where is the authorization decision made — at the gateway, or in the application that owns the data? The answers determine whether your audit trail names a person or an integration, and whether a permission change happens in one place or two. Everything else is packaging.

### Does MCPJungle support OAuth?

Not as of v0.4.5 (July 2026). Callers authenticate with static bearer tokens the gateway issues; its documentation lists OAuth as not yet supported. Downstream credentials are supplied at server registration and are therefore shared by every caller of that server. That is coherent for a small team without an authorization server — and it is a different design from an OAuth 2.1 resource server.

### Is the Docker MCP Gateway a multi-user gateway?

No. It is a Docker CLI plugin powering the MCP Toolkit, designed as a single-user developer tool: isolated containers, minimal host privileges for `npx`/`uvx` servers, secrets via Docker Desktop. Its real contribution is sandboxing MCP servers you do not trust — which none of the multi-tenant gateways here do, including ours.

### Which open-source MCP gateway propagates the end user's identity?

Two, differently. **ContextForge** supports user-scoped OAuth tokens and forwards a caller's bearer token between federated gateways, alongside encrypted gateway-held credentials — configurable rather than fixed. **Cortex Gateway** is built only on propagation: the user's JWT to first-party applications, their own linked token from a per-user encrypted vault to third-party MCP servers, no shared credential, no authorization decision of its own.

### Which one sandboxes untrusted MCP servers?

**Docker MCP Gateway.** Running an MCP server you did not write, from a package you have not read, directly on your machine is the most under-discussed risk in this ecosystem. Cortex does not sandbox anything — it assumes the backends behind it are yours, or remote services reached over HTTPS.

### Which one protects against prompt injection?

**Lasso mcp-gateway**, a local proxy doing prompt-injection detection, PII masking and server-reputation scanning. It authenticates no end users and federates nothing. It is a complementary layer, not an alternative to the identity gateways here.

### When should I not use a gateway at all?

One application, one MCP server: a gateway adds a hop for nothing. Separate connectors already preserve each provider's per-user permissions. A gateway earns its place when the operational surface of many connectors becomes the problem — one consent perimeter, one audit trail, one revocation, cross-application scopes, a catalog small enough for the agent's context.

### Why should I trust a comparison written by one of the projects?

Check it. Every claim here comes from a repository you can open, and the version numbers and dates are stated so you can see when it went stale. We say where each project beats us, including three that do things we do not attempt. If we have got something wrong, the correction is one issue away — and a comparison that cannot survive its subjects reading it was never worth publishing.
