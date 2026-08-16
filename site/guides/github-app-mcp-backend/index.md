<!-- https://cortex-gateway.dev/guides/github-app-mcp-backend/ -->

# GitHub access for AI agents — without paying for seats

**TL;DR**

On private repositories **every human account costs a paid seat, even read-only** — and the minimum Read permission includes full code access anyway. A **GitHub App consumes zero seats**: register it with minimal permissions, install it on an explicit repo list, and front it with a thin MCP backend (~1 route) behind your gateway. Executives and ops staff who will never open github.com get governed, attributable access to issues and docs through their agent — authenticated against *your* identity provider, not GitHub's. The same pattern wraps any third-party API: Slack, Stripe, Google.

## The problem it solves: seats

Suppose non-technical stakeholders — executives, ops, a client's project lead — need to *interact* with your GitHub repos: read issues, file requests, check a doc. They will never open github.com, but on private repositories GitHub has no free "guest" tier. Every account you invite consumes a paid seat, and the smallest permission you can grant (Read) still exposes the entire codebase.

So the usual outcomes are all bad: pay seats for people who log in twice a year, share a machine user's token, or copy-paste issues into email. There is a fourth option.

## Zero seats: the GitHub App

A GitHub App is a machine identity, not a member — it appears in no seat count. Register one with only the permissions your tools need (`issues: write`, `contents: read`, `metadata: read`), install it with **"Only select repositories"**, and authenticate machine-to-machine:

```
RS256 JWT (iss = app id, exp ≤ 10 min, signed with the app's private key)
  → POST /app/installations/{id}/access_tokens
  → 1-hour installation token, scoped to the installed repos + app permissions
```

A repo outside the installation answers 404 — least privilege is enforced by GitHub itself, before any logic of yours runs.

## The architecture

```
Stakeholder's agent (Claude, …)
        │  MCP (OAuth 2.1, scopes mcp:github:read / mcp:github:write)
        ▼
Cortex gateway ── federates ──▶ github backend (plain HTTP, ~1 route)
                                      │  installation token (cached, 1 h)
                                      ▼
                                GitHub REST API
```

The backend is a normal Cortex backend — the same [~120-line contract](/guides/rest-api-to-mcp-server/) every first-party app implements: one `POST` endpoint, `list_tools`, per-method scope checks. It can be hosted anywhere; a pragmatic choice is **inside the gateway app itself** (an integration has no natural "owning" business app), registered in the backend list with a `localhost` base URL.

Typical tools, prefixed `github_` by the gateway: `list_repos`, `list_issues`, `get_issue`, `create_issue`, `comment_issue`, `read_file`, plus the conventional `get_help` / `get_snapshot` / `whoami`.

## The three design rules

### 1\. Attribution lives in your layer, not the provider's

GitHub only sees the App — every issue would look machine-authored. So: writes require a real OAuth identity (the static discovery token is rejected for them), the backend logs `actor + method + target`, and the author is signed into the payload itself:

> *Created by jane@yourco.example via Cortex (your-app-name).*

This is the [permission layer](/answers/agent-permission-layer/) doing its job: the agent proves it acts for a specific person, and that person's name survives into the record even when the provider cannot carry it.

### 2\. Validate the perimeter yourself, before the provider does

The backend resolves the `repo` parameter against the cached installation repo list and refuses anything else with a clear error. You get least privilege twice: once enforced by the installation, once explained by your backend.

### 3\. Scope taxonomy stays yours

`mcp:github:read` / `mcp:github:write` are declared in [your OAuth server's catalog](/guides/secure-mcp-with-oauth/) like any other domain. Who may obtain them is your policy — pools, roles — not GitHub's. The App's credentials never leave the backend.

## Why this beats the alternatives

| Approach | Seats | Blast radius | Attribution |
| --- | --- | --- | --- |
| Personal accounts + read access | 1 per person | full code read | native |
| Shared machine user + PAT | 1 | whatever the PAT holds, until revoked | none |
| **GitHub App behind a backend** | **0** | app permissions × installed repos | your layer (signed + logged) |

## Not the same problem as federating an MCP server

If your users all have their own accounts at a provider that ships a native MCP server, you want the other pattern: [proxy the provider's MCP server](/guides/federate-third-party-mcp-servers/) with each user's own linked token, so the provider sees their account, seat and rate limits. This guide is for the opposite case — people who have *no* account at the provider and never will. One machine identity, zero seats, and your OAuth layer supplies the identity the provider cannot see.

## Operational notes

-   Cache the installation token in-process (renew ~5 min before expiry) and the installed-repo list (minutes — it only changes via the provider's UI).
-   Ship the private key as a base64 env var; without it the backend should answer a clean 503 "not configured" while still serving `list_tools`.
-   The webhook can stay disabled: this pattern is pull-only. Enable it only when you want provider events to flow back in.
-   One GitHub subtlety: the issues endpoint also returns pull requests — filter on the `pull_request` key.

The full worked example, including the token flow and design rationale, lives in the repository: [integration backends — wrapping a third-party API](https://github.com/wellknownmcp/cortex-gateway/blob/main/docs/integration-backend-github-app.md).

[Get started on GitHub →](https://github.com/wellknownmcp/cortex-gateway)

## FAQ

### Does a GitHub App consume a paid seat?

No. A GitHub App is a machine identity: it is installed on repositories, not invited as a member, so it appears in no seat count on any plan. Its access is bounded by the permissions declared at registration intersected with the repositories selected at installation — far narrower than the Read role a human account would need, since even GitHub's minimum private-repo permission includes full code access.

### Can someone without a GitHub account read issues in a private repository?

Not on github.com — private repos require an account with access, and on paid plans that access is a seat. But through an agent they can: a GitHub App installed on the repos, fronted by an MCP backend behind an OAuth 2.1 gateway, lets a stakeholder's agent list issues, read files and file requests. The person authenticates against *your* identity provider, never against GitHub.

### Why not a shared machine user with a personal access token?

It still costs a seat, and it is strictly worse on governance: the PAT holds whatever the machine user holds, for everyone who can reach it, until someone remembers to revoke it — and every action is attributed to the machine user rather than a person. A GitHub App costs zero seats, scopes access to declared permissions × installed repos, mints short-lived one-hour tokens, and leaves attribution to your OAuth layer where it belongs.

### If GitHub only sees the App, who is the author of an issue?

Attribution moves into your layer, by design. The backend requires a real OAuth identity for every write, logs actor, method and target on each call, and signs the acting person into the payload itself — *"Created by jane@yourco.example via Cortex"*. GitHub shows the App as the technical author; your audit trail and the issue body name the human.

### Does this pattern work for APIs other than GitHub?

Yes — any provider with app-style machine identities: Slack apps, Google service accounts, Stripe restricted keys. One integration backend per provider, provider credentials confined to that backend, your gateway's OAuth perimeter, scope taxonomy and audit trail in front.
