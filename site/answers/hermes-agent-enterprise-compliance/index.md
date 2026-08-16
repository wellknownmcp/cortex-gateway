<!-- https://cortex-gateway.dev/answers/hermes-agent-enterprise-compliance/ -->

# Hermes Agent on a company VPS: what an auditor will ask — and what to add

**TL;DR**

Hermes Agent's security model is **genuinely good at the machine boundary** — command approval, a hardline blocklist, container isolation, credential-store write protection. It is **absent at the organizational boundary, openly and by design**: its documentation targets individuals and small teams. On the "$5 VPS" its own README suggests, that gap is invisible for one person and disqualifying for a company: every allowed user acts through the same API keys, nothing attributes an action to a person, and there is no audit trail or central revocation. Auditors ask exactly four questions the default install cannot answer. The fix is not replacing Hermes — it is putting an identity layer between Hermes and company data, which Hermes supports natively in [two lines of YAML](/connect/hermes/).

**Transparency.** We maintain [Cortex Gateway](https://github.com/wellknownmcp/cortex-gateway), an open-source access layer that solves the organizational half of this page. Facts about Hermes Agent are taken from its repository and its [security documentation](https://hermes-agent.nousresearch.com/docs/user-guide/security), checked **16 August 2026**. Corrections welcome as a GitHub issue.

## Why this page exists

Hermes Agent (Nous Research) is the breakout agent of 2026 — 230k+ GitHub stars, messaging-native, with a built-in scheduler that runs jobs unattended. A service industry has grown around it: installers deploying Hermes on a VPS for small and mid-sized companies, wired to Telegram or Slack, connected to the company's mail, CRM and files. The install takes an afternoon and the demo lands every time.

Then someone — a client's IT provider, an insurer's questionnaire, a due-diligence checklist, a DPO — asks how access is controlled. The honest answer about the default install is: by a platform allowlist, in front of one set of shared keys, with no log of who did what. This page is for the installer who wants a better answer, and for the company asking the question.

## What Hermes secures well — credit where due

Its [security documentation](https://hermes-agent.nousresearch.com/docs/user-guide/security) is more serious than most of the category:

-   **Command approval** with three modes, and a hardline blocklist of catastrophic commands that stays active *even in `--yolo` mode*.
-   **Container isolation** done properly: `--cap-drop ALL`, `no-new-privileges`, pid limits, tmpfs.
-   **Credential hygiene at the host**: keys in `~/.hermes/.env` under `chmod 600`, blocked writes to `~/.ssh/` and credential stores, environment filtering for MCP subprocesses, token redaction in error messages.
-   **Hostile-input defenses**: SSRF prevention, prompt-injection scanning of context files, supply-chain advisories.

All of this protects *the machine from the agent and the agent from hostile input*. None of it answers *organizational* questions — who may do what, as whom, logged where. Those are different problems, and Hermes' docs do not pretend otherwise: multi-user access control is a platform allowlist plus DM pairing, and no per-user audit trail or RBAC is described. For its stated audience — one person and their agent — that is the right scope.

## The four questions an auditor asks

Whether the framework is ISO 27001, SOC 2 or an insurer's questionnaire, automated access always gets the same four questions. Here is how the default company-VPS install answers, and which control each maps to:

| Question | Default VPS install | Maps to |
| --- | --- | --- |
| **Who acted?** Is each action attributable to a person? | No — every allowlisted user acts as the same instance; downstream systems see the instance's account | ISO 27001 A.5.16, SOC 2 CC6.1 |
| **With what rights?** Least privilege per person? | No — one `~/.hermes/.env` key set holds the union of all rights for all users | A.5.15, A.8.2, CC6.3 |
| **Logged where?** An attributable, reviewable trail? | Local session state; no per-user audit log, no export | A.8.15, CC7.2 |
| **Revoked how?** One action to cut a leaver's access? | Rotate every key the instance holds, by hand, and hope none was copied | A.5.18, CC6.2 |

Note what is *not* on this list: nothing about the model, prompt injection or containers. Hermes already covers those better than most. Audits fail deployments on the boring half.

## The GDPR angle — sharper than most installers expect

**The agent's memory is personal data.** Hermes' headline feature is persistence: it searches its own past conversations and "builds a deepening model of who you are across sessions." On a company VPS, that is a growing store of employee and customer personal data with no documented retention or erasure story — the operator must supply one (GDPR Art. 5(1)(e), Art. 17).

**Art. 32** requires security measures appropriate to the processing — shared credentials and absent access logs on a box that reads company mail is a hard position to defend in an incident report.

**Art. 30** requires records of processing activities. An unattended scheduler running natural-language jobs against customer data is processing; someone has to be able to say which.

**Art. 28 is the one that lands on the installer personally.** An installer who keeps operating the VPS — updates, restarts, SSH access to a machine processing the client's customer data — is a *processor*, and needs a data processing agreement saying so. Installing an agent for a client without one is carrying liability for free.

## The fix keeps Hermes

Nothing above argues for a different agent. It argues for a **separation of layers**: Hermes stays the runtime — the skills, the scheduler, the messaging surfaces — and company-data access moves behind an identity layer it already knows how to talk to.

Hermes ships a complete OAuth 2.1 MCP client: dynamic client registration, PKCE, token refresh. Pointed at an OAuth-protected MCP gateway, the shape changes entirely:

-   **Each employee authenticates as themselves** — the browser flow, once. Their Hermes calls carry *their* identity; each application enforces the permissions that person already has. The [permission layer](/answers/agent-permission-layer/), instead of a shared key.
-   **Least privilege becomes scopes**, granted per user — not the union of everything the instance was ever given.
-   **Every tool call writes one attributable audit line**, on your infrastructure, exportable to whoever is asking.
-   **Revocation is one act**: cut the OAuth grant, and every backend is cut at once — including for the scheduler's unattended jobs.

Model-provider keys can stay in `~/.hermes/.env`; they authenticate the agent to its brain, not to your business. It is *company-data access* that must never ride shared static credentials. The Hermes-side setup is the shortest of any client we document: [two lines of YAML](/connect/hermes/).

## The installer's checklist

What separates "I installed an agent" from "I deployed governed automation" — the version that survives the client's next audit:

1.  **Per-user identity** for every business tool (OAuth 2.1 in front of company data; no shared API keys past the model provider).
2.  **Least-privilege scopes** per employee, reviewed when roles change.
3.  **Attributable audit trail**, per call, exportable — test that you can answer "what did the agent do as Alice last Tuesday?"
4.  **Central revocation**, tested: offboard a user in one action, verify the scheduler's jobs lose access too.
5.  **The paperwork**: a DPA if you operate the VPS, records of processing for the agent's jobs, and a retention/erasure answer for Hermes' persistent memory.

The controls-to-frameworks mapping — ISO 27001:2022 Annex A, SOC 2 CC6/CC7, and why the EU AI Act probably does not apply to an internal agent — is on [AI agent compliance controls](/answers/ai-agent-compliance-controls/). The threat-model side (tool poisoning, rug pulls, session hijacking) is on [MCP security best practices](/answers/mcp-security-best-practices/).

[Connect Hermes to a gateway — two lines of YAML →](/connect/hermes/)

## FAQ

### Is Hermes Agent GDPR compliant?

Software is never GDPR-compliant by itself — deployments are. A company install raises Art. 32 (security measures: who can access the instance, with what rights), Art. 30 (records of what the agent processes), retention and erasure for Hermes' persistent conversation memory — which is personal data — and Art. 28: an installer who keeps operating the VPS is a processor and needs a DPA. None of this is Hermes' fault; all of it is the operator's job.

### Does Hermes Agent have an audit trail?

Not in the auditor's sense, as of August 2026: session state persists locally, and the security documentation describes no per-user attributable log, RBAC or SIEM export. Since every allowed user acts through one credential set, downstream systems record the instance, not the person. Attribution has to be added at the access layer, where each call carries a real user identity.

### Can several employees share one Hermes on a VPS?

Technically yes — allowlists and DM pairing gate who may talk to it. But everyone admitted acts through the same `~/.hermes/.env` keys, holding the union of all granted rights, unattributed, with one shared memory. That is the shared-service-account pattern audits exist to catch. Multi-user shape has to come from an identity layer in front of the tools.

### Is Hermes ISO 27001 or SOC 2 certified?

Certifications apply to organizations, not open-source software — the question is malformed for Hermes as for any framework. The real question is whether *your deployment* passes *your* audit: A.5.15–A.5.18, A.8.15, CC6/CC7 all bite on how the agent authenticates to company systems, whether actions map to people, and whether access revokes centrally.

### What should an installer add for a company deployment?

Per-user OAuth identity for business tools, least-privilege scopes, an exportable per-call audit trail, tested central revocation, and the paperwork (DPA, records of processing, a retention answer for the agent's memory). Model keys can stay in `.env` — company-data access is what must not ride shared static credentials.
