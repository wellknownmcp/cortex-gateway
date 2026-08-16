# Integration backends: wrapping a third-party API (GitHub App case study)

Most Cortex backends front a business app you own. But the same ~120-line
contract works for a second family: **integration backends**, where the backend
is a thin authenticated proxy to a third-party API — GitHub, a CRM, a billing
provider — and the gateway gives your agents governed access to it.

This note documents the pattern with GitHub as the worked example.

## The problem it solves: seats

Suppose non-technical stakeholders (executives, ops) need to *interact* with
your GitHub repos — read issues, file requests, check a doc — but will never
open github.com. On private repositories, **every human account consumes a
paid seat, even read-only**: GitHub has no free "guest" tier, and the minimum
private-repo permission (Read) includes full code access anyway.

A **GitHub App consumes zero seats.** Register an app with minimal
permissions (`issues: write`, `contents: read`, `metadata: read`), install it
on an explicit repo list ("Only select repositories"), and authenticate
machine-to-machine:

```
RS256 JWT (iss = app id, exp ≤ 10 min, signed with the app's private key)
  → POST /app/installations/{id}/access_tokens
  → 1-hour installation token, scoped to the installed repos + app permissions
```

A repo outside the installation answers 404 — least privilege is enforced by
GitHub itself, before any logic of yours runs.

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

The backend is a normal Cortex backend: one `POST` endpoint, `list_tools`,
per-method scope checks, static-token discovery tier. It can be hosted
anywhere; a pragmatic choice is **inside the gateway app itself** (an
integration has no natural "owning" business app), registered in the backend
list with a `localhost` base URL.

Typical tools (prefixed `github_` by the gateway): `list_repos`,
`list_issues`, `get_issue`, `create_issue`, `comment_issue`, `read_file`,
plus the conventional `get_help` / `get_snapshot` / `whoami`.

## The three design rules

**1. Attribution lives in your layer, not the provider's.** GitHub only sees
the App — every issue would look machine-authored. So: writes require an
OAuth identity (the static discovery token is rejected for them), the backend
logs `actor + method + target`, and the author is signed into the payload
itself:

> _Created by jane@yourco.example via Cortex (your-app-name)._

**2. Validate the perimeter yourself, before the provider does.** The backend
resolves the `repo` param against the cached installation repo list and
refuses anything else with a clear error. You get least privilege twice: once
enforced by the installation, once explained by your backend.

**3. Scope taxonomy stays yours.** `mcp:github:read` / `mcp:github:write` are
declared in your OAuth server's catalog like any other domain. Who may obtain
them is your policy (pools, roles), not GitHub's — the App's credentials never
leave the backend.

## Why this beats the alternatives

| Approach | Seats | Blast radius | Attribution |
|---|---|---|---|
| Personal accounts + read access | 1 per person | full code read | native |
| Shared machine user + PAT | 1 | whatever the PAT holds, until revoked | none |
| **GitHub App behind a backend** | **0** | app permissions × installed repos | your layer (signed + logged) |

The same shape applies to any provider with app-style machine identities
(Slack apps, Google service accounts, Stripe restricted keys): one
integration backend per provider, provider credentials confined to that
backend, your gateway's OAuth + audit in front.

## Operational notes

- Cache the installation token in-process (renew ~5 min before expiry) and
  the installed-repo list (minutes — it only changes via the provider's UI).
- Ship the private key as a base64 env var; without it the backend should
  answer a clean 503 "not configured" while still serving `list_tools`.
- Webhook can stay disabled: this pattern is pull-only. Enable it only when
  you want provider events to flow back in.
- One GitHub subtlety: the issues endpoint also returns pull requests —
  filter on the `pull_request` key.
