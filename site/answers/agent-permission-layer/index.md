<!-- https://cortex-gateway.dev/answers/agent-permission-layer/ -->

# The permission layer for AI agents: proving an agent acts for a real person

**TL;DR**

An AI agent is not a user. Before it touches anything that matters — data, money, other people's systems — it has to answer two questions: **who is it acting for, and what may that person do?** The infrastructure that answers them on every call is the permission layer. There are two ways to build one: *replicate* permissions into the agent's tooling (and watch the copies drift), or *delegate* — carry the real person's identity into every call and let each application enforce its own rules. Cortex Gateway is an open-source, self-hosted implementation of the delegation approach.

## What is the permission layer?

The permission layer for AI agents is the infrastructure that makes every agent action **attributable and bounded**: attributable to a specific real person (or organization) the agent acts for, and bounded by exactly the rights that person holds. It sits between agents and the applications they call, the same place IAM sits between employees and applications today.

It is not a firewall, not a prompt guardrail, and not a policy engine bolted onto the agent. Those constrain *what the agent tries*. The permission layer constrains *what the world accepts from it* — which is the only side you can actually trust, because it doesn't depend on the agent behaving.

## Why everything downstream depends on it

Most of the agent-economy infrastructure people are excited about — spend controls, escrow between machines, dispute resolution, insurance for agent actions, agent-to-agent commerce — quietly assumes this layer already exists. Every one of those reduces to the same primitive:

-   **Spend controls** need to know *whose budget* an action draws on before they can cap it.
-   **Escrow** needs to know which principal is bound by the release conditions.
-   **Disputes and liability** need a responsible party — and legally, responsibility always rolls up to a person or a company, never to the agent itself. The same is true of an audit: see [what auditors actually test on agent access](/answers/ai-agent-compliance-controls/).
-   **Agent-to-agent payments** need both sides to verify the counterparty's authority, not just its wallet.

None of these can be built on anonymous, over-privileged access. The permission layer isn't one idea on the list of agent infrastructure to build — it is upstream of most of the list.

## Two ways to build it: replicate or delegate

|  | Replicate permissions | Delegate identity |
| --- | --- | --- |
| How it works | Copy each app's roles and rules into the agent platform; enforce them there | Carry the real user's identity into every call; each app enforces its own rules |
| Source of truth | Two — the app and the copy, which drift apart | One — the app that owned the rules all along |
| Failure mode | Stale copies, confused deputy, service accounts holding everyone's rights | None new: a call with the wrong identity is refused by the app itself |
| Audit | "The integration did it" | "This person's agent did it" — one attributable line per call |
| Revocation | Per app, per copy, hopefully | One revocation at the authorization server cuts everything |

Replication is tempting because it looks like control. But every copied permission is a liability with a half-life, and the copies concentrate in exactly the wrong place: a component that talks to everything. Delegation inverts this — the gateway in the middle holds *no* rights of its own and decides *nothing*. There is nothing new to trust.

## What delegation looks like in practice

This is not hypothetical architecture; the pieces are standard and shipping today. Mapped to concrete mechanisms, MCP + OAuth 2.1 already answer each requirement:

| Requirement | Mechanism |
| --- | --- |
| Prove the agent acts for a real person | OAuth 2.1 authorization code flow: the person logs in and consents once; the agent gets a token bound to their identity |
| Prove the person holds the authority | Scopes on the token — granted per user by the authorization server, verifiable by every app |
| Keep each app's rules authoritative | Identity propagation: first-party apps receive the user's JWT; third-party services receive the user's own linked account from a per-user encrypted vault — never a service account |
| Least privilege by default | The tool catalog itself is filtered by scope: an agent doesn't even see tools its person may not use |
| Accountability | One pseudonymized audit line per tool call: who-hash, tool, backend, outcome |
| Kill switch | One OAuth revocation ends the delegation across every connected app at once |

[Cortex Gateway](https://github.com/wellknownmcp/cortex-gateway) packages exactly this: one OAuth 2.1 MCP endpoint in front of N applications, identity propagated on every call, permissions never mirrored. The [company-federation worked example](/use-cases/company-federation/) shows it at organization scale; [securing an MCP server with OAuth 2.1](/guides/secure-mcp-with-oauth/) is the wiring, and [MCP gateway vs MCP server](/answers/mcp-gateway-vs-mcp-server/) situates the component that carries the identity.

## From copilots to autonomous agents

Today the common case is a copilot: a person watching their agent work. The permission-layer question gets sharper, not different, as agents become autonomous — acting for hours without a human in the loop, possibly spending money. The delegation model already covers it: the agent still borrows a specific person's identity, its authority is still bounded by that person's scopes, every action still lands in the audit trail, and the person (or their organization) is still the accountable party. Autonomy changes how often a human looks, not who answers for the action. An architecture that only works while a human watches was never a permission layer.

## Try it

The [hosted demo](https://mcp.cortex-gateway.dev/) is a live permission layer in miniature: sign up with a magic link, connect from [claude.ai](/connect/claude-ai/) or [Claude Code](/connect/claude-code/), and watch `whoami` and a scope-filtered `tools/list` prove the delegation on your own account. Then run it yourself:

```
docker run ghcr.io/wellknownmcp/cortex-gateway
```

[Get started on GitHub →](https://github.com/wellknownmcp/cortex-gateway)

## FAQ

### What is a permission layer for AI agents?

The infrastructure that lets an agent prove, on every action, that it acts on behalf of a specific real person and that this person holds the required rights. Without it, agent access runs on shared keys and service accounts — anonymous and over-privileged. With it, every call carries the user's real identity and each application enforces its own permission model, exactly as it does for the human.

### How does an AI agent prove it is acting on behalf of a real person?

Through OAuth 2.1 delegation: the person authenticates and consents once; the agent receives a token bound to that person's identity and scopes, and presents it on every tool call. The receiving application verifies the token cryptographically. The agent holds no standing credentials of its own, and one revocation ends the delegation everywhere.

### Why is a shared API key or service account not enough?

Because it flattens identity: one credential holding the union of everyone's rights, used by every agent, producing an audit trail with one anonymous actor. That is the confused-deputy problem, and it destroys both answers a permission layer exists to give — who the agent acts for, and what that person may do.

### Is OAuth 2.1 enough for AI agent authorization?

It provides the primitive — delegated identity, scoped authority, revocation — and MCP builds on it. What it doesn't give you across many apps is the bundle: one consent perimeter instead of N, cross-app entitlements, a single audit trail, one kill switch. That operational bundle is what a federation gateway adds, without making a single authorization decision itself.
