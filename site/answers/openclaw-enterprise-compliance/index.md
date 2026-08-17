<!-- https://cortex-gateway.dev/answers/openclaw-enterprise-compliance/ -->

# OpenClaw on a company VPS: what an auditor will ask — and what to add

**TL;DR**

OpenClaw is unusually honest about its trust model: one gateway instance is **single-user by design** — its docs state it is "not a hostile multi-tenant security boundary," and recommend one instance per person. Installers deploy it for whole teams anyway: one VPS, one credential store in `~/.openclaw/`, a pairing allowlist as the only gate — and, by default, **one conversation session shared across every DM**. That install fails the four questions access audits ask, plus a data-segregation question Hermes-style agents don't even raise. The fix is not one-VPS-per-employee (that multiplies the problem twenty-fold); it is an identity layer between OpenClaw and company data, which its MCP client supports natively in [three commands](/connect/openclaw/).

**Transparency.** We maintain [Cortex Gateway](https://github.com/wellknownmcp/cortex-gateway), an open-source access layer that solves the organizational half of this page. Facts about OpenClaw are taken from its repository and its [security documentation](https://docs.openclaw.ai/gateway/security), checked **17 August 2026**. Corrections welcome as a GitHub issue. Same analysis for Hermes Agent: [here](/answers/hermes-agent-enterprise-compliance/). [Cette page existe en français.](/fr/openclaw-entreprise/)

## Why this page exists

OpenClaw is the most-starred agent on GitHub — 385k+ stars, MIT-licensed, messaging-native, the personal assistant that made "always-on agent on a $5 VPS" a normal thing to have. The same service industry that installs [Hermes for companies](/answers/hermes-agent-enterprise-compliance/) installs OpenClaw for companies: one instance on a VPS, wired to WhatsApp or Slack, connected to company mail and files, the whole team paired to it.

The difference is that OpenClaw's documentation already told the installer not to. Its security page states the trust model plainly and recommends separate instances per user. The gap this page covers is not hidden in the product — it is the distance between what the docs say and what gets deployed.

## What OpenClaw secures well — credit where due

For its stated scope — one person and their agent — the security work is serious:

-   **Credential hygiene**: secrets under `~/.openclaw/` with `600`/`700` permissions; workspace `.env` files are blocked from overriding provider credentials.
-   **Inbound gating**: DM pairing with approval codes (default), allowlists, mention-gating and per-group controls, context-visibility filters for non-allowlisted senders.
-   **Tool policy and sandboxing**: sensitive tools (`exec`, `browser`, `process`) restricted or disabled by default; opt-in Docker/Podman sandboxes; an owner-only `elevated` escape hatch.
-   **Self-audit**: `openclaw security audit` checks network exposure, tool blast radius, permissions and plugin loading, with `--fix` auto-remediation. More than most agents ship.
-   **Log redaction**: transcripts on disk with pattern-based secret redaction, extensible via `logging.redactPatterns`.

All of it protects *the machine and the inbound surface*. The docs are equally clear about what is absent: no per-user authorization (a `sessionKey` "is a routing selector, not an auth token"), no multi-tenant isolation. For one person, the right scope. For a company, the whole question.

## The four questions an auditor asks — plus a fifth OpenClaw raises itself

| Question | Default shared-instance install | Maps to |
| --- | --- | --- |
| **Who acted?** Attributable to a person? | No — every paired user acts as the instance; sessionKey routes, it does not authenticate | ISO 27001 A.5.16, SOC 2 CC6.1 |
| **With what rights?** Least privilege per person? | No — one `~/.openclaw/` credential store holds the union of the instance's rights | A.5.15, A.8.2, CC6.3 |
| **Logged where?** Attributable, reviewable trail? | Transcripts on disk (redacted), machine-posture audit — no per-user trail, no export | A.8.15, CC7.2 |
| **Revoked how?** One action for a leaver? | Unpair the user, then rotate every credential the instance holds, by hand | A.5.18, CC6.2 |
| **Is data segregated between users?** | By default, **no**: all DMs share one session unless `session.dmScope: "per-channel-peer"` is set — one employee's session can surface another's context | A.5.15, GDPR Art. 5(1)(f), CC6.1 |

The fifth row is specific to OpenClaw's defaults and is the one that turns a compliance finding into an incident: cross-employee context bleed needs no attacker, only two colleagues and the default configuration.

## "One instance per user" is honest — and doesn't scale

OpenClaw's documented answer for multiple users is separate gateway instances with isolated credentials, ideally separate OS accounts or hosts. As isolation advice, it is correct. As a company deployment model, count what it creates for a 20-person SMB: twenty instances to patch, twenty credential stores to rotate when anything leaks, twenty transcript sets to govern for GDPR retention — and still *zero* central audit trail, *zero* single revocation, and downstream systems that see twenty service accounts instead of twenty people.

Isolation between users is necessary. It is not the same thing as organizational access control, and multiplying instances buys the first while leaving the second untouched.

## The GDPR angle

**Transcripts are personal data.** Session transcripts persist on disk — employee and customer conversations included. Redaction patterns catch secrets, not personal data; retention and erasure (Art. 5(1)(e), Art. 17) are the operator's to answer.

**Art. 32**: shared credentials, a default shared session and no access log on a box reading company mail is a hard position in an incident report — the shared-session default alone is an integrity-and-confidentiality (Art. 5(1)(f)) finding.

**Art. 30**: unattended jobs against customer data are processing activities; someone must be able to list them.

**Art. 28 lands on the installer.** Whoever keeps operating the VPS — updates, restarts, SSH — is a processor and needs a DPA. This is the clause most installers discover after the fact, and it carries their liability, not the client's.

## The fix keeps OpenClaw

Keep the runtime — the skills, the channels, the sandboxing, one instance per user if you follow the docs. Move *company-data access* behind an identity layer OpenClaw already speaks. Its MCP client supports Streamable HTTP with managed OAuth tokens (v1.5.0+): [three commands](/connect/openclaw/), and the agent holds a short-lived token bound to one real person instead of raw API keys scattered in its config.

-   **Each employee authenticates as themselves** — their OpenClaw calls carry *their* identity; each application enforces the permissions that person already has. The [permission layer](/answers/agent-permission-layer/), not a shared key.
-   **Least privilege becomes scopes**, per user, reviewed when roles change.
-   **Every tool call writes one attributable audit line**, on your infrastructure, exportable.
-   **Revocation is one act** — cut the OAuth grant, every backend is cut, unattended jobs included.

Model-provider keys can stay local; they authenticate the agent to its brain, not to your business. The five-point installer checklist and the controls-to-frameworks mapping are the same as for Hermes: see [the installer's checklist](/answers/hermes-agent-enterprise-compliance/) and [AI agent compliance controls](/answers/ai-agent-compliance-controls/). And whatever else you change, run `openclaw security audit --fix` — the machine half stays yours to harden.

[Connect OpenClaw to a gateway — three commands →](/connect/openclaw/)

## FAQ

### Is OpenClaw multi-user?

No — its docs say a gateway instance is "not a hostile multi-tenant security boundary" and recommend one instance per person. Pairing and allowlists gate who may talk to it, but everyone admitted acts through the same credential store, and by default all DMs share one session context.

### Does OpenClaw have an audit trail?

Transcripts and logs on disk with secret redaction, plus a machine-posture `security audit` command — but no per-user attributable trail: a sessionKey routes, it does not authenticate. Downstream systems record the instance, not the person. Attribution must be added at the access layer.

### Can a team share one OpenClaw instance on a VPS?

The docs advise against it. Shared credentials with the union of all rights, no attribution — and unless `session.dmScope` is changed, a shared conversation context where one employee's session can surface another's. A shared-service-account finding and a data-segregation finding in one install.

### Is one instance per employee a workable company setup?

It is the documented, honest answer — and it multiplies rather than solves: N instances to patch, N credential stores, N transcript sets, still no central audit or revocation. Keep per-user instances for the runtime; put company-data access behind one OAuth 2.1 gateway where identity, scopes, audit and revocation exist once.

### What should an installer add for a company deployment?

Per-user OAuth 2.1 identity for business tools (OpenClaw supports managed OAuth from v1.5.0), least-privilege scopes, an exportable per-call audit trail, tested central revocation, and the paperwork — DPA (Art. 28), records of processing, a retention answer for transcripts. Plus `openclaw security audit --fix` for the machine half.
