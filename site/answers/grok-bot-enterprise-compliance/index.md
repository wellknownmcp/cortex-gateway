<!-- https://cortex-gateway.dev/answers/grok-bot-enterprise-compliance/ -->

# Grok Bot in your company: what IT, auditors and the GDPR will ask

**TL;DR**

Grok Bot (xAI/SpaceXAI, beta since 11 August 2026) gives each user always-on agents on a **cloud Linux VM that signs into apps with the employee's own credentials** — the way a human would, including tools with no API. That is the pitch, and it is also the compliance surface: sign-ins from a datacenter VM sit outside your device-trust perimeter (xAI's docs say so), the promised **audit view of bot actions doesn't exist yet**, killing a bot **keeps its durable storage**, and downstream systems can no longer tell the employee from their bot. Unlike the [Hermes](/answers/hermes-agent-enterprise-compliance/) and [OpenClaw](/answers/openclaw-enterprise-compliance/) cases, this is not an installer's mistake — it is the product working as designed, reachable through a *consumer* subscription your IT never sees. The governable path exists and xAI's own docs point at it: **Grok Bot inherits your team's MCP policy** — so put company tools behind an OAuth 2.1 MCP gateway and make that the lane the bot uses.

**Transparency.** We maintain [Cortex Gateway](https://github.com/wellknownmcp/cortex-gateway), an open-source access layer relevant to the fix below. Facts about Grok Bot are taken from xAI's [announcement](https://x.ai/news/introducing-grok-bot) and its [teams & enterprises documentation](https://docs.x.ai/grok-bot/teams-and-enterprises), checked **17 August 2026**. Grok Bot is in beta and enterprise access is waitlisted — details will change; corrections welcome as a GitHub issue. Same series for [Hermes Agent](/answers/hermes-agent-enterprise-compliance/) and [OpenClaw](/answers/openclaw-enterprise-compliance/). [Cette page existe en français.](/fr/grok-bot-entreprise/)

## What Grok Bot is — and why the pitch is the risk

Grok Bot is a team of always-on agents, each working on a persistent cloud computer, available to SuperGrok Heavy, Cursor Ultra and Cursor Teams Premium subscribers. Its differentiator is precisely what makes governance hard: a bot *navigates websites, clicks buttons and types into fields the way a human would*, signing into the tools the employee already uses with the employee's own credentials — including "legacy enterprise software" with *no clean API or MCP*. It keeps working while the laptop is off, and bots can coordinate with each other in group chat.

Hermes and OpenClaw raise VPS questions because installers deploy them wrong. Grok Bot raises them *as designed*: the credential handling, the unsupervised execution and the cloud residency are the product. The questions below are therefore for IT and security leadership, not for installers.

## What xAI got right — credit where due

-   **Per-member computers**, which admins can inspect and remove; members can self-reset.
-   **Hardware keys survive**: WebAuthn prompts are forwarded to the member's desktop app, so phishing-resistant factors are not simply broken.
-   **MCP done properly**: Grok Bot inherits the team's existing MCP configuration and allowlist/denylist policy, and sign-in tokens for hosted MCP servers *stay with the Cursor backend, not stored on the computer*.
-   **Org-wide controls** for Cursor Teams admins: disable Grok Bot entirely, toggle cloud-agent launching, scope team rules; Privacy Mode (Legacy) blocks Grok Bot outright.
-   **Training follows team privacy settings**, same as Cursor's.

These are real controls. The findings below are what they do not yet cover — much of it stated by xAI's own documentation.

## The audit grid, applied

| Question | Grok Bot today (per xAI's docs, Aug 2026) | Maps to |
| --- | --- | --- |
| **Who acted?** | Ambiguous by construction: the bot signs in as the employee, so downstream systems cannot distinguish the person from their always-on bot | ISO 27001 A.5.16, SOC 2 CC6.1 |
| **With what rights?** | All of the employee's rights — password sign-ins cannot be scoped; least privilege is structurally unavailable in that lane | A.5.15, A.8.2, CC6.3 |
| **Logged where?** | Spend and usage analytics; "an audit view of Bot actions is coming" — i.e., not today | A.8.15, CC7.2 |
| **Revoked how?** | Kill the VM ("durable storage is kept") and rotate every password the bot used, by hand | A.5.18, CC6.2 |
| **Inside the security perimeter?** | No — sign-ins happen in a datacenter VM; "device-trust agents unavailable natively", so conditional-access policies are bypassed or must be weakened to let the bot in | A.8.1, CC6.6 |

The fifth row deserves emphasis because it is self-inflicted on day one: an organization enforcing device-trust either blocks the bots (and users route around IT), or punches an exception for a cloud VM it does not manage. Both outcomes appear in the next audit.

## The shadow-IT multiplier

Everything above assumes the company knows the bots exist. Grok Bot is also sold through **SuperGrok Heavy — a consumer subscription**. An employee can create a bot on a personal account, hand it their work logins, and produce an always-on ghost worker IT has never heard of, exercising corporate credentials from an unmanaged VM. Enterprise onboarding is waitlisted; personal onboarding is not. Policy, detection (impossible-travel and datacenter-IP sign-in alerts) and an approved alternative are the only levers — a ban with no sanctioned path is how the personal-account version proliferates.

## The GDPR angle

**Everything the bot sees transits and persists on a US provider's cloud VM.** Screens, documents, mailboxes — processing of employee and customer personal data on xAI/Cursor infrastructure, to inventory under Art. 30 and assess under Chapter V (transfers). The Grok Bot documentation we checked states nothing about data residency, a DPA, or SOC 2 for this product; until the enterprise tier ships terms, that absence *is* the answer to put in the DPIA.

**"Durable storage is kept."** Killing a bot deletes the VM but not its durable storage — a retention and erasure (Art. 5(1)(e), Art. 17) question with no documented deletion path yet.

**Training follows team privacy settings** — which means for personal-tier usage, whatever the individual's settings say. A DPIA for sanctioned use, and the assumption of unsanctioned use, are both warranted (Art. 35, Art. 32).

## The fix: make the MCP lane the only lane for company data

The remarkable thing in xAI's documentation is that the governed path is already built in: **Grok Bot follows your team's MCP policy** — allowlists, denylists, shared MCP authentication with Cursor, hosted-server tokens kept off the VM. The browser-credential lane and the MCP lane coexist; governance means moving company data to the second:

-   **Expose company tools as MCP servers behind one OAuth 2.1 gateway** — [a ~120-line contract per app](/guides/rest-api-to-mcp-server/), or [an integration backend](/guides/github-app-mcp-backend/) for third-party APIs. Allowlist the gateway in the team MCP policy; denylist the rest.
-   **Each employee's bot then acts on a scoped, per-user OAuth grant**, not their passwords: least privilege becomes [scopes](/answers/agent-permission-layer/), and bot actions become distinguishable from human ones — the attribution the "coming" audit view cannot provide.
-   **Every call writes one attributable audit line** on your infrastructure — no waiting on a vendor roadmap for A.8.15.
-   **Revocation returns to one act**: cut the grant, and the bot's access to every backend dies with it — no password-rotation hunt, regardless of what the durable storage kept.

What remains in the browser lane — legacy tools with no API — remains ungoverned by construction; that residue is a risk-acceptance decision to write down, not a detail to discover in an incident. The controls-to-frameworks mapping is on [AI agent compliance controls](/answers/ai-agent-compliance-controls/); the threat-model side on [MCP security best practices](/answers/mcp-security-best-practices/).

[Put an OAuth 2.1 gateway in front of your tools →](https://github.com/wellknownmcp/cortex-gateway)

## FAQ

### Is Grok Bot safe to use with company tools?

Depends on the lane. The browser lane — the bot signing in with the employee's credentials from its cloud VM — bypasses device-trust, has no per-action audit today, and carries the employee's full rights unsupervised. The MCP lane inherits your team's allowlist policy and keeps hosted-server tokens off the VM. Company data belongs in the second.

### Where do Grok Bot credentials live?

Sign-ins happen inside the bot's Linux VM; WebAuthn is forwarded to the member's desktop, and xAI recommends passkeys in a password manager for re-authentication — corporate credentials exercised and stored on a VM outside your perimeter. Hosted MCP server tokens, by contrast, "stay with the Cursor backend, not stored on the computer."

### Does Grok Bot have an audit trail?

Not yet — usage analytics today, "an audit view of Bot actions is coming" per the docs. And since the bot acts as the employee, downstream logs cannot separate the person from the bot; that requires the bot's access to be separately identified, which per-user OAuth scopes provide.

### Can IT control or block it?

With Cursor Teams: org-wide disable, cloud-agent toggle, team rules, MCP allowlists, computer inspection/removal; Privacy Mode (Legacy) blocks it entirely. The gap: SuperGrok Heavy is a consumer subscription, so personal-account bots with work logins are a shadow-IT problem no team setting reaches.

### How do you revoke a bot's access when someone leaves?

Remove the member's computer — "Kill deletes the running virtual machine. Durable storage is kept." Then rotate every password the bot used, because killing the VM invalidates none of them. An OAuth grant behind a gateway revokes in one act; that difference is the whole argument.
