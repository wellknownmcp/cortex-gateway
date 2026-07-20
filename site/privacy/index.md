<!-- https://cortex-gateway.dev/privacy/ -->

# Privacy

**TL;DR**

This website sets no cookies and runs no client-side tracking. The hosted demo asks for an email address to sign you in, keeps a pseudonymized audit trail, and deletes inactive accounts automatically. Everything is hosted in the EU. The same data-minimization posture the gateway advertises is applied to this site.

## The website (cortex-gateway.dev)

-   **No cookies, no JavaScript, no client-side analytics.** The pages are static HTML.
-   **Standard web-server logs** (IP address, user agent, requested URL) are kept for up to **14 days** for security and operations, then rotated away.
-   **Aggregate traffic statistics** are derived server-side from those logs; IP addresses are **truncated before import** (last octet removed for IPv4, tail removed for IPv6), so the analytics store never contains full addresses.

## The hosted demo (mcp. and auth.cortex-gateway.dev)

The demo exists so you can evaluate the gateway with a real OAuth 2.1 flow. It collects the minimum that flow requires:

| Data | Purpose | Retention |
| --- | --- | --- |
| Email address | Magic-link sign-in and account identity | Deleted after **90 days without sign-in** (with all tokens, sessions and consents) |
| OAuth artifacts (codes, tokens, consents) | Operating the OAuth 2.1 flow | Expired items removed within 7 days of expiry; all removed with the account |
| Gateway audit trail | Demonstrating pseudonymized auditing (hashed identifiers, no raw email) | **90 days** |
| Demo notes (write tools) | Demonstrating scope tiering | In-memory only — gone on restart, never stored in a database |

Deletion happens automatically (daily job). To have your demo account removed sooner, open an issue on [GitHub](https://github.com/wellknownmcp/cortex-gateway/issues) — no need to include your email publicly; a maintainer will follow up.

## Processors and hosting

-   **Hosting**: a server operated by us in the EU (OVH, France).
-   **Email delivery**: magic-link emails are sent through [Resend](https://resend.com); your address transits their service for delivery only.
-   No data is sold, shared or used for advertising. There are no other third parties.

## If you self-host Cortex Gateway

This page covers *this website and demo only*. A self-hosted deployment stores everything on your own infrastructure — that is the point of the project — and its privacy posture is yours to define.

Last updated: 2026-07-05. Material changes to this page will appear in the [repository history](https://github.com/wellknownmcp/cortex-gateway/commits/main).
