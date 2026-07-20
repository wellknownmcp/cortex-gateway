<!-- https://cortex-gateway.dev/answers/mcp-security-best-practices/ -->

# MCP security best practices: what a gateway can actually enforce

**TL;DR**

The published MCP incident record concentrates in **six threat categories**, and almost none of them are exotic. They are missing input validation, missing least privilege, and implicit trust — the same failures as every previous integration technology, now with a language model in the loop that reads attacker-controlled text as instructions. The security frameworks converging on MCP get the threat taxonomy right and then overreach: their upper tiers ask for **per-invocation message signing and signed tool descriptions that no MCP client implements**. This page separates what you can enforce today from what is still a proposal, and states which of those a federating gateway is the right place for — including the ones Cortex Gateway does *not* solve.

## The six threat categories

Independent analyses — the Cloud Security Alliance's MCP guidance, the OWASP Top 10 for Agentic Applications, the agent-focused additions to MITRE ATLAS — converge on the same short list. It is worth reading as a checklist of what to defend, not as a novelty:

| Threat | What it actually is | Where it must be stopped |
| --- | --- | --- |
| **Tool poisoning** | Adversarial instructions hidden in a tool description, which the model follows and the user never reads | Review before approval + content scanning. Not a runtime control. |
| **Rug pull** | A tool's description or schema rewritten *after* approval, under an unchanged name | Definition fingerprinting wherever catalogs are read — a gateway, or the client itself |
| **Session hijacking** | Token theft: plaintext transport, tunnel subdomain reassignment, long-lived high-privilege sessions | Enforced TLS, short token lifetimes, refresh rotation, sessions carrying no authority |
| **Supply chain** | A malicious, typosquatted or hijacked package in the server's dependency tree | Pinning, SBOM, CVE monitoring — your build pipeline, not your runtime |
| **Cross-tenant leakage** | One organization's context or data reaching another, often via unfiltered queries or shared context | The application that owns the data. Nothing upstream can reconstruct its tenancy rules. |
| **Pre-auth RCE** | Server-supplied data used unsafely by the client that received it — CVE-2025-6514 passed an unsanitized URL from server metadata to the OS shell | Validate everything a remote party sends before acting on it. Especially URLs. |

The single most useful sentence in the CSA's own analysis is the concession that most real incidents "stem from standard engineering failures — input validation, least privilege, explicit trust — not exotic zero-days." That is true, and it should change how you sequence the work.

## Which recommendations are implementable today

Maturity models are useful for planning and dangerous for procurement, because they list aspirational controls beside shipping ones without marking which is which. Here is the honest split for MCP as of mid-2026:

| Control | Status |
| --- | --- |
| OAuth 2.1 + PKCE, per-tool scopes, per-call authorization | **Shipping.** In the MCP spec, implemented by real clients. No excuse not to. |
| TLS everywhere, short-lived tokens, refresh rotation with theft detection | **Shipping.** Ordinary OAuth hygiene, nothing MCP-specific. |
| Tool definition change detection | **Implementable** without any protocol extension — you already re-read the catalog. Rarely implemented, which is the gap. |
| SBOM, pinning, CVE monitoring, curated registry | **Shipping.** Your existing supply-chain program, applied to MCP servers. |
| Attributable audit trail, SIEM forwarding, anomaly baselines | **Implementable.** The hard part is deciding what a line must contain, not the plumbing. |
| Cryptographically *signed* tool descriptions | **Proposal.** No standard, no client verifies signatures. Local-only benefit at best. |
| Per-invocation request/response signing | **Proposal.** Not in the MCP spec. Implementing it means a private extension no client understands. |
| Enhanced Tool Definition Interface (JWT-bound tools) | **Research.** A promising direction, not something to require of a vendor in 2026. |
| Hardware enclaves / micro-VM isolation per invocation | **Real but narrow.** Justified for untrusted code execution; overkill for a server calling your own internal APIs. |

The practical conclusion: doing the first five properly eliminates the large majority of what has actually gone wrong. Partially implementing the bottom four buys compliance narrative, not security.

## What a federating gateway is the right place for

A gateway is not automatically safer — it concentrates traffic, so a compromised one is serious, and one that holds a service account or makes its own authorization decisions [flattens identity](/answers/agent-permission-layer/) and makes things worse. The version that helps is the one holding no rights of its own. Then it becomes the single component that sees every backend's tool definitions, every hop, and every call, which makes it the natural enforcement point for three of the six categories:

### Rug pulls — the one that needs a chokepoint

Detecting a rewritten tool definition requires remembering what it looked like when it was approved. Individual clients rarely do this, and when many agents connect to many servers there is no shared memory of the approved state. A gateway re-reads each backend's catalog on a schedule anyway, which makes fingerprinting nearly free.

Cortex Gateway hashes the security-relevant surface of every federated tool — `description`, `inputSchema`, required `scope`, `version`, deprecation — at first sight, and re-checks it at each refresh. Key ordering is normalized so a backend reserializing an identical schema is not a false positive. Two modes:

```
CORTEX_TOOL_INTEGRITY_MODE=warn    # default: log the mutation, name the changed
                                   # fields, push tools/list_changed, serve it
CORTEX_TOOL_INTEGRITY_MODE=block   # quarantine: withheld from tools/list and
                                   # refused at tools/call until reviewed
```

In `block` mode the baseline deliberately keeps the *approved* definition, so a mutation keeps being reported instead of quietly becoming the new normal — and a backend that reverts clears its own quarantine.

### Transport — because the gateway forwards your token

Every federated call carries the caller's bearer token to the backend, so a plaintext hop is a credential leak, not a performance choice. Cortex refuses `http://` to any remote host and drops that backend at load rather than trusting the scheme to be right in every environment; loopback stays allowed, since that is where the [stdio bridge](/guides/expose-http-mcp-server-over-stdio/) and local development live.

The same validation applies to URLs the gateway did not choose. When it [federates a third-party MCP server](/guides/federate-third-party-mcp-servers/), the issuer and the authorization, token and registration endpoints all come from the *remote server's* metadata — one of them is where a user's browser gets sent, another is where an authorization code gets presented. Each is validated before use. That is precisely the class of bug behind CVE-2025-6514: server-controlled data acted on by the client that received it.

### Audit — "which tool" is not "which system"

A federated audit line that records only a tool name leaves the reader inferring the destination from a naming convention. Cortex records the backend that served each call and the scope that gated it, alongside a pseudonymized caller identity and hashed parameters. That is the difference between a log and an audit trail an investigation can lean on — the same controls [auditors test for](/answers/ai-agent-compliance-controls/) under ISO 27001 and SOC 2.

## What a gateway does not solve

Being explicit here matters more than the feature list, because the failure mode of security infrastructure is believing it covers something it doesn't:

-   **Cross-tenant leakage.** Only the application owning the data knows its tenancy rules. A gateway that tried to reconstruct them would be replicating permissions — the exact anti-pattern. Cortex propagates the real user's identity and lets each backend enforce its own model; if a backend leaks across tenants, nothing upstream will catch it.
-   **Supply chain.** This belongs to your build pipeline: pinning, SBOM, CVE monitoring, a curated registry. No runtime component fixes a malicious dependency.
-   **A tool that was malicious from the first refresh.** Fingerprinting answers "did it change since you approved it", not "was it honest to begin with". That still requires reading the description before approving the server, and scanning it — `mcp-scan` and equivalents exist for exactly this.
-   **Attestation.** Cortex's fingerprint baseline is per-process and rebuilt at boot, so a restart implicitly re-approves the current state and each replica keeps its own. It is mutation detection during a process's lifetime. A persistent, operator-signed baseline is the next step — stated here as a limit, not sold as a feature.

## A sequencing that reflects the real risk

1.  **Inventory.** Every MCP server your organization actually runs, including the ones developers added to their own IDE. You cannot secure what is not on a list.
2.  **Authenticate everything.** OAuth 2.1 with PKCE, no unauthenticated servers, no personal tokens with admin scope. [Wiring guide](/guides/secure-mcp-with-oauth/).
3.  **Enforce TLS and scope the tools.** Per-tool scopes, not per-server. A caller should not see tools it may not call.
4.  **Detect definition changes.** Cheap, unimplemented almost everywhere, and the only defense against the rug pull.
5.  **Make the audit attributable.** Caller, tool, backend, scope, outcome — per call.
6.  **Then** consider the advanced tiers, on the understanding that some of them do not exist yet.

## Try it

Cortex Gateway is MIT-licensed and self-hosted: one OAuth 2.1 MCP endpoint in front of N applications, no permission mirroring, the security controls above enforced in the one place that can see across backends. The full control documentation, including the stated limits, is in [docs/security.md](https://github.com/wellknownmcp/cortex-gateway/blob/main/docs/security.md).

```
docker run ghcr.io/wellknownmcp/cortex-gateway
```

[Get started on GitHub →](https://github.com/wellknownmcp/cortex-gateway)

## FAQ

### What are the main MCP security threats?

Six categories cover nearly every published incident: tool poisoning, rug pulls, session hijacking, supply chain compromise, cross-tenant leakage, and pre-authentication remote code execution. Most are ordinary engineering failures — missing input validation, missing least privilege, implicit trust — rather than novel attacks on the protocol itself. What is new is that a language model reads attacker-controlled text as instructions, which turns a tool description into an injection surface.

### What is a rug pull attack on an MCP server?

A bait-and-switch on tool definitions: the server exposes an honest tool, gets approved, then rewrites that tool's description or input schema while keeping the name. The approval is keyed on the name, so nothing re-prompts, but the model now reads different instructions. Name-level change detection cannot see it — catching it requires fingerprinting the full definition at approval time and re-checking it on every catalog refresh.

### Does an MCP gateway improve security, or add attack surface?

Both, and it only nets out positive if the gateway holds no rights of its own. Concentrating traffic makes a compromise serious; in exchange, the gateway is the one component that sees every backend's tool definitions, every hop and every call, which is where definition integrity, transport policy and an attributable audit trail can be enforced. A gateway with a service account adds risk. One that validates, propagates the user's own identity, and decides nothing adds enforcement without adding trust.

### Is per-invocation message signing required for MCP security?

It appears in published maturity frameworks, but nothing in the MCP specification defines it and no mainstream client implements it — so building it means a private extension no client understands, against a threat most deployments don't face. The same caveat applies to signed tool descriptions and to JWT-bound tool interfaces: worthwhile directions, not yet standards. Doing the fundamentals well removes far more real risk than partially implementing the advanced tiers.

### How do you stop tool poisoning in an MCP deployment?

Two distinct controls. A description that was adversarial from the start is caught by content scanning and human review before approval — a process, not a runtime check. A description that turned adversarial after approval is caught by definition fingerprinting and change alerts, which a gateway can automate because it re-reads catalogs on a schedule. Neither replaces reading what you are about to trust.
