<!-- https://cortex-gateway.dev/answers/ai-agent-compliance-controls/ -->

# AI agent access controls for ISO 27001, SOC 2, GDPR and the EU AI Act

**TL;DR**

Auditors do not have an opinion about your model. They test four properties of *automated access*: **least privilege**, **attributable identity**, a **complete record**, and **revocation**. An agent running on a shared API key fails all four, which is why it shows up in findings as an ungoverned access path rather than as an AI question. Existing frameworks already cover this — ISO/IEC 27001:2022 Annex A and SOC 2 CC6/CC7 need no AI clause. And the EU AI Act obligations everyone cites almost certainly **do not apply to your agents**, for two independent reasons set out below.

## The finding you are trying to close

An auditor looks at a system where AI agents read customer records and asks three questions. Who authorized this access? Which human is accountable for that action on 14 March? If that person left the company yesterday, what happened to the agent?

With a shared service account, the answers are: an admin, two years ago, in a config file. Nobody — the log says "the integration". And: nothing, the key still works. That is not an AI governance problem. It is a textbook access-control failure with a fashionable cause, and it maps onto controls that predate the technology by a decade.

The reframing is the whole point of this page. **Agents are not a new category of subject; they are a new category of *delegate*.** Once each agent action carries the identity of the person it acts for, every existing control applies unchanged, and you stop needing an "AI policy" to describe what your access-control policy already says.

## The four properties auditors test

| Property | The question behind it | Shared API key | Per-user delegation |
| --- | --- | --- | --- |
| Least privilege | Can the agent do more than the person it acts for? | Yes — it holds the union of everyone's rights | No — scopes bound it to a subset of one user's rights |
| Attributable identity | Who is accountable for this action? | "The integration" | A named person, on every call |
| Complete record | Is every call logged, retained, protected? | Per application, in N formats, if at all | One line per call, one place, one format |
| Revocation | Someone left. Now what? | Rotate the key, notify every consumer, hope | One revocation at the authorization server cuts every application at once |

The mechanism that produces the right-hand column is [identity delegation](/answers/agent-permission-layer/): the agent borrows a specific person's identity through OAuth 2.1, and each application enforces the permission model it already had. Nothing is mirrored, so nothing drifts.

## ISO/IEC 27001:2022 — Annex A, unchanged

No control here mentions artificial intelligence, and none needs to.

| Control | What it requires | What agent access must show |
| --- | --- | --- |
| A.5.15 Access control | Who may access what, on what basis | The agent's authority is derived from its user's, not granted separately |
| A.5.16 Identity management | Identity lifecycle across systems | Agents have no identity of their own — they carry a person's. Nothing to provision or deprovision separately. |
| A.5.17 Authentication information | Management of secrets, tokens, keys | No standing credential in the agent. Third-party tokens encrypted at rest, per user. |
| A.5.18 Access rights | Provisioning, review and *removal* | Removal is one revocation, effective across every application |
| A.8.2 Privileged access rights | Restrict and manage privileged access | No over-privileged service account exists to restrict |
| A.8.15 Logging | Produce, store and protect activity logs | One attributable line per tool call: who, what, which application, outcome |
| A.8.16 Monitoring activities | Monitor for anomalous behaviour | A single stream to monitor, rather than N application logs to correlate |

Read the middle column again with an agent in mind. A shared service account is not "an AI risk" — it is a violation of A.5.16 and A.8.2 with a new name.

## SOC 2 — CC6 and CC7

The Trust Services Criteria land in the same place. **CC6 (logical and physical access controls)** asks whether access is authorized, appropriately provisioned, and — the criterion agents usually fail — *removed* when it is no longer needed. **CC7 (system operations)** asks whether you monitor, detect and evaluate anomalies.

The evidence an auditor will ask for is concrete: show me an agent action, name the human behind it, show me the consent that authorized it, show me what happened when that human was offboarded. Per-user delegation makes those four artefacts one query. A shared key makes them a conversation.

## The EU AI Act: you are probably not in scope, twice over

This section is where vendors overreach, so read it before you buy anything.

**First, the articles everyone cites are high-risk articles.** Article 12 (record-keeping) and Article 14 (human oversight) sit in the chapter governing *high-risk AI systems*. An internal agent that reads your documentation or files a ticket is, in the overwhelming majority of cases, not a high-risk AI system under Annex I or Annex III. If you are not in that category, those articles impose nothing on you.

**Second, the deadline moved.** Following the Digital Omnibus on AI, agreed and formally endorsed by the European Parliament and Council in 2026, the high-risk obligations were deferred: to **2 December 2027** for stand-alone Annex III systems, and to **2 August 2028** for AI embedded in regulated products under Annex I. The originally scheduled 2 August 2026 date no longer applies.

**Third, and most often missed: a gateway is not an AI system.** It is access infrastructure. It processes no inputs, produces no inferences, and makes no decisions. Whatever obligations attach, they attach to you as the provider or deployer of an AI system — never to a component of your network.

So what is honest to say? If you *do* deploy a high-risk system, per-call logging with an attributable identity and an effective human kill-switch are the technical substrate Article 12 and Article 14 presuppose, and you will want them well before 2027 regardless. If you do not, build them anyway, because ISO 27001 and SOC 2 ask for them *today* and neither of those has a grace period.

Legislative dates move. This section reflects the position as of July 2026 — verify against the Official Journal before relying on it, and take actual legal advice rather than a vendor's page.

## GDPR: pseudonymized is not anonymous

An audit trail that hashes the user's email is **pseudonymized**, not anonymous. Article 4(5) is explicit: data that can be attributed to an individual with additional information remains personal data — and in an audit trail it must be attributable, or the log would serve no purpose.

What that means in practice, and what a vendor claiming "anonymous logs" is getting wrong:

-   The audit trail stays inside your record of processing (Article 30) and needs a defined retention period.
-   Pseudonymization is a *security measure* recognized by Article 32, not an exit from scope. It limits the blast radius of a log leak; it does not remove the log from the regulation.
-   Data-subject rights still apply to it, with the usual tension against the legal grounds for keeping security logs.

Saying this plainly is a better signal of a serious security model than any badge.

## What self-hosting actually changes

This is the argument a decision-maker should care about, and it is not about features.

A hosted agent-tool platform holds your users' OAuth tokens, sees every tool call, and stores the record of it. That makes it a **processor** under GDPR Article 28 and a vendor inside your SOC 2 boundary — with the due diligence, the contract, the sub-processor notice, and the annual review that follow. Sometimes that trade is right. It should be a decision, not a discovery.

A self-hosted gateway runs on your infrastructure. The token vault, the audit trail and every call remain inside a perimeter you have already described to your auditor. Nothing new enters the scope, so nothing new has to be assessed. That is the whole compliance argument for self-hosting, stated without embellishment.

## What no gateway can do for you

It cannot certify you. Software supplies technical controls; frameworks test controls *and* the policies, risk assessments, evidence and processes around them. What infrastructure removes is one specific finding — *agents cannot be scoped, attributed or revoked* — and it removes it by construction rather than by procedure.

A gateway that decides nothing also adds nothing to trust. [Cortex Gateway](https://github.com/wellknownmcp/cortex-gateway) holds no rights of its own, mirrors no permission rules, and makes no authorization decision: it carries each user's identity to the application that owns the data, refuses what the token's scopes forbid, writes one pseudonymized line per call, and lets a single OAuth revocation cut every application at once. Everything else — the policy, the evidence, the auditor — stays where it belongs.

## Four questions for any agent platform

1.  When my agent calls an application, **whose credential** arrives at that application — mine, or a shared one?
2.  When an employee is offboarded, **how many actions** revoke their agent's access across every system?
3.  Where does the **audit trail live**, who can read it, and is that location already in my compliance scope?
4.  Where do **third-party OAuth tokens** rest, encrypted with which key, held by whom?

The answers are architecture, not roadmap. A vendor who needs a call to answer question one has already answered it.

[Get started on GitHub →](https://github.com/wellknownmcp/cortex-gateway)

## FAQ

### What do auditors actually test when AI agents access company systems?

Four things, none about the model. Least privilege: can the agent exceed the person it acts for? Attributable identity: does each action name a responsible human? Completeness: is every call logged and retained? Revocation: does one action cut a departing employee's agent everywhere? A shared API key fails all four — which is why agents appear in findings as an ungoverned access path, not as an AI question.

### Which ISO 27001 controls apply to AI agent access?

The access-control and logging families of ISO/IEC 27001:2022 Annex A, unchanged: A.5.15 Access control, A.5.16 Identity management, A.5.17 Authentication information, A.5.18 Access rights, A.8.2 Privileged access rights, A.8.15 Logging, A.8.16 Monitoring activities. The standard needs no AI clause — a shared service account is a violation of A.5.16 and A.8.2 with a new name.

### Which SOC 2 criteria do agents touch?

CC6 (logical access: authorization, provisioning, and above all removal) and CC7 (system operations: monitoring and evaluating anomalies). The evidence request is concrete — show an agent action, name the human, show the consent, show what offboarding did. Per-user delegation makes that one query.

### Does the EU AI Act require logging of AI agent actions?

Only for high-risk AI systems, and most internal agents are not. Articles 12 and 14 sit in the high-risk chapter, and after the 2026 Digital Omnibus those obligations were deferred to 2 December 2027 (stand-alone Annex III) and 2 August 2028 (Annex I embedded). A vendor promising EU AI Act compliance today is selling a control you may not owe, on a deadline that moved.

### Is a gateway itself an AI system under the EU AI Act?

No. It is access infrastructure: no inputs processed, no inferences produced, no decisions made. Obligations attach to the provider or deployer of an AI system, not to a component of the network it runs on.

### Does a self-hosted gateway add a sub-processor to my SOC 2 or GDPR scope?

No — and that is the practical difference from a hosted platform. Self-hosted, the token vault and audit trail stay inside a perimeter already described to your auditor. A hosted platform holds your users' tokens and observes every call, making it a processor under GDPR Article 28 and a vendor in your SOC 2 scope.

### Is a pseudonymized audit trail anonymous under GDPR?

No. Hashing an email yields pseudonymized data, which Article 4(5) still treats as personal data — and an audit trail must remain attributable or it is useless. Pseudonymization is a security measure under Article 32, not an exit from scope: the record of processing, retention and data-subject rights all still apply.

### Can a gateway make my company compliant?

No software certifies anyone. Infrastructure supplies technical controls and removes one finding — that agents cannot be scoped, attributed or revoked. Policies, risk assessment, evidence and the audit stay yours. A vendor claiming to deliver compliance is telling you about their sales process.
