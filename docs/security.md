# Security controls

The gateway's authorization model is documented in the README ("Security
model"). This file covers the controls that exist because a *federating*
gateway sees things a single MCP server does not: the tool definitions of
every backend, the transport to each of them, and the full call path from
agent to application.

Each section states what the control does, how to configure it, and what it
does **not** cover.

---

## 1. Tool definition integrity (rug-pull detection)

**The attack.** A backend serves an honest tool, gets approved, and later
rewrites that tool's `description` or `inputSchema` while keeping the name.
The client's approval still points at the same name, so nothing re-prompts —
but the model now reads different instructions. This is the "rug pull", and
change detection on tool *names* misses it entirely.

**The control.** At every catalog refresh the gateway fingerprints the
security-relevant surface of each federated tool — `scope`, `description`,
`params`, `inputSchema`, `version`, `deprecated` — and compares it against the
definition first seen for that name. Key order is normalized, so a backend
reserializing the same schema is not a false positive.

Three outcomes are reported per refresh: `added`, `removed`, `mutated` (with
the list of fields that changed).

```bash
CORTEX_TOOL_INTEGRITY_MODE=warn   # default
CORTEX_TOOL_INTEGRITY_MODE=block
```

- **`warn`** — the mutation is logged (`[cortex/tool-integrity]`, with the
  changed field names) and a `tools/list_changed` notification is pushed so
  clients that cache tool definitions re-read them. The new definition is
  served.
- **`block`** — the tool is *quarantined*: withheld from `tools/list` and
  refused at `tools/call` with a distinct error (`Tool quarantined: definition
  changed since approval`), not a generic "unknown tool". The baseline keeps
  the **approved** definition, so the mutation keeps being reported instead of
  quietly becoming the new normal. A backend that reverts to the approved
  definition clears its own quarantine.

### Reviewing a quarantine

A quarantine is cleared by an operator, over a dedicated endpoint. It is
deliberately not an MCP tool: acknowledging a mutation is the human decision
the quarantine exists to force, and a tool in `tools/list` would let a model
clear a rug pull on its own.

```bash
# What is quarantined, and which fields changed
curl -H "x-cortex-admin-secret: $CORTEX_ADMIN_SECRET" \
  https://gateway.example/api/admin/tool-integrity

# Approve the current definition of one tool, by name
curl -X POST -H "x-cortex-admin-secret: $CORTEX_ADMIN_SECRET" \
  -H 'Content-Type: application/json' -d '{"tool":"docs_search"}' \
  https://gateway.example/api/admin/tool-integrity
```

Acknowledging adopts the tool's **current** definition as the approved one and
triggers a catalog refresh, so the tool is served again immediately rather than
at the next 60-second tick, and clients get a `tools/list_changed`. The
acknowledgement is logged on the same `[cortex/tool-integrity]` tag as the
detection, with the tool, its backend, the fields that changed and the date the
superseded definition was approved — so one grep shows a mutation and the
decision made about it.

`CORTEX_ADMIN_SECRET` is separate from `CRON_SECRET` on purpose: purging audit
rows past retention is maintenance, re-approving a tool definition is a
security decision, and a scheduler's secret should not carry it. **Unset, the
endpoint does not exist** (404) — there is no default and no open fallback.

### Where the approved state lives

```bash
CORTEX_TOOL_BASELINE_FILE=/var/lib/cortex/tool-baseline.json
```

Without it the baseline is rebuilt at boot from whatever the backends declare,
so a restart re-approves the current state — and a restart is often inducible
by whoever runs a backend. Set it whenever you set `block`; the gateway warns
at boot if you did not.

The store holds the approved definitions **and** the open quarantines, so
neither an approval nor a pending review is lost across a restart. It is
written with `mode 0600`, through a write-then-rename so a crash mid-write
leaves the previous baseline intact rather than a truncated file. In Docker,
point it at a mounted volume; replicas sharing that volume share their
approvals, replicas with local disks each keep their own.

A **corrupt** store is not treated as "no baseline yet": that would make
`echo > baseline.json` a one-command way to launder a rewritten definition
into a fresh approval. In `block` mode the gateway withholds every federated
tool and reports `degraded` until an operator repairs or deliberately removes
the file. It never overwrites a store it could not read.

### Signing the baseline

An unsigned store is forgeable by anyone who can write the file. There are two
ways to close that, and they are not equally strong.

```bash
node scripts/sign-baseline.mjs keygen     # Ed25519 keypair
```

**Self-signed** — give the gateway the private key:

```bash
CORTEX_BASELINE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."
```

It signs every write and verifies at boot. This stops a forged file arriving
by another route — a restored backup, a volume mounted elsewhere, a process
that can write the path but not read the environment. It does **not** stop
whoever compromised the host, because the key is right there.

**Operator-signed** — give the gateway only the public half:

```bash
CORTEX_BASELINE_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n..."
```

Now the gateway verifies approvals but cannot mint them. A changed definition
stays quarantined until you approve it deliberately, off-host:

```bash
scp gateway:/var/lib/cortex/tool-baseline.json .
node scripts/sign-baseline.mjs verify tool-baseline.json   # read what changed
node scripts/sign-baseline.mjs sign   tool-baseline.json   # approve it
scp tool-baseline.json gateway:/var/lib/cortex/
```

This is the mode that actually moves the trust boundary: forging an approval
now requires the signing key, which never touches the server. The cost is that
catalog changes need a human, which is the point.

The envelope follows [LLMFeed](https://llmca.org)'s `trust` block —
`signed_blocks`, `scope`, `algorithm`, `trust_level`, `public_key_hint` —
because declaring *what* a signature covers beats implying it covers
everything. `trust_level` distinguishes the two modes above, so a reader can
tell whether the signer is the machine that could be compromised.

Three refusals worth knowing: a store that arrives **unsigned** while signing
is configured is rejected (otherwise deleting two keys restores trust); a store
signed by a key **other** than the configured public key is rejected (the key
embedded in the file is a convenience for tooling, never the authority); and a
**tampered** store is rejected exactly like a corrupt one — every federated tool
is withheld in `block` mode.

**Limits, stated plainly.** This answers "did this definition change since it
was approved on this deployment", not "is this the definition the vendor
published". There is no chain back to the backend author — signing that would
require the backend to sign its own catalog, which nothing in MCP does today.
And the fingerprint sorts object keys, so a backend that only **reorders** an
`inputSchema` produces no mutation: see the note in
`src/lib/tool-integrity.ts` on why that is deliberate for change detection, and
why llmca.org's canonicalization profile reaches the opposite conclusion for
documents a model reads as text.

Nothing here inspects the *content* of a description for injected
instructions. Detecting an adversarial description that was malicious from the
first refresh is a different problem (see `mcp-scan` and similar scanners);
this control answers "did it change since you approved it".

---

## 2. Outbound transport policy

Every federated call forwards the caller's bearer token to the backend. Over
plaintext HTTP that token is readable by anything on the path — the cheapest
way to turn a correct OAuth setup into a credential leak.

The gateway refuses to speak plaintext to a **remote** host rather than trust
the operator to have gotten the scheme right in every environment. A backend
whose URL violates the policy is dropped at load, with an error on stderr; the
other backends keep serving.

Allowed with no configuration:

- any `https://` URL
- `http://` to a loopback host (`localhost`, `127.0.0.0/8`, `::1`) — where the
  stdio bridge and local development run, and where the traffic never leaves
  the machine

```bash
CORTEX_ALLOW_INSECURE_BACKENDS=true   # permits remote plaintext, warns on every load
```

Intended for a trusted private network with transport security at another
layer (a service mesh, a WireGuard link). Not for production over the open
internet.

The same policy applies to URLs the gateway did not choose. When the adapter
discovers a third-party MCP server's authorization server (RFC 9728 → RFC
8414), the issuer and the `authorization_endpoint` / `token_endpoint` /
`registration_endpoint` all come from the **remote server's** metadata — one of
them is where a user's browser gets sent, another is where an authorization
code gets presented. Each is validated before use, and a discovered endpoint
that is cross-origin to its issuer is logged (legitimate for many providers,
also what hijacked metadata looks like).

This is the class of bug behind CVE-2025-6514: server-controlled data used
without validation by the client that received it.

---

## 3. Audit attribution

Every POST to `/mcp` writes one pseudonymized audit line (hashed email, hashed
params — see the README on why pseudonymized is not anonymous under GDPR).

Two fields answer "who reached what":

- **`target_app`** — the backend that served the call. Resolved from the
  federated catalog for `tools/call`, from the URI scheme for
  `resources/read`. `gateway` marks a builtin (served in-process, federating
  nowhere). `null` means the method reaches no backend, or the tool was
  unknown — in which case the call failed anyway.
- **`scope_used`** — the OAuth scope that gated the call.

Without these, an audit trail of a federated gateway can only say *which tool
name* was called, leaving the reader to infer the destination from a naming
convention. That is not an audit trail an investigation can lean on.

---

## 4. What `X-Cortex-Backends` is not

`X-Cortex-Backends` narrows `tools/list` to the named backends. It is a
**context-size optimization, not an access control**: it shapes what the agent
is shown, not what the token may call. A caller that sends
`X-Cortex-Backends: docs` can still invoke `billing_*` if its scopes allow it.

Authorization lives in the per-tool scope check at `tools/call` — deliberately,
so that trimming context can never be mistaken for revoking access.

---

## 5. Baseline scope

Per-tool OAuth scopes are the authorization model. The gateway builtins
(`whoami`, `list_cortex_resources`, `read_cortex_resource`,
`report_missing_capability`, `list_cortex_tickets`) require none by design —
which means that without a floor, any syntactically valid token for this
audience reaches them.

```bash
OAUTH_REQUIRED_SCOPES=mcp:access   # comma- or space-separated
```

When set, the scope is required before any dispatch; a token without it gets
403 `insufficient_scope`. Unset (the default) keeps the builtins open to any
valid token for this resource.

---

## 6. Token forwarding — what it implies

**How it works.** A call carries the caller's own JWT to the backend that
serves it. That is what removes the over-privileged service account: the
backend sees the real user and applies the user's own rights. It is also a
deliberate departure from the MCP authorization spec, which tells an MCP
server not to pass through the token it received. The trade-off is stated
here so you can decide whether it fits your deployment.

**What a backend receives.** A token whose `aud` is the **gateway**, valid for
its remaining lifetime, for the scopes the user granted to the client — not
only the scope of the tool being called. A backend that is compromised, or run
by someone you do not fully trust, can replay it against the gateway and reach
every other backend the token's scopes cover.

**What the gateway does about it.**

- The token goes **only** to the backend that serves the call. The fan-out
  builtins — `whoami`, `list_cortex_tickets`, and the forwarding of
  `report_missing_capability` — reach only backends on which the caller holds
  at least one declared scope. Before 0.3.0 they reached every healthy
  backend, whatever the caller's scopes.
- Plaintext transport to a remote backend is refused (§2), so the token is not
  readable on the path.
- Each backend may only declare scopes under its own prefix (§7), so a backend
  cannot widen the set of tokens it is sent.

**What you should do.** Treat every federated backend as part of the trust
boundary of the tokens it receives: federate backends you operate or trust,
keep access tokens short-lived, and have backends re-validate the token
without ever storing or re-sending it. If a backend sits outside that trust
boundary, front it with the MCP adapter (`docs/mcp-adapter.md`), which holds a
separate downstream token per user and never forwards the gateway token.

**What is not done yet.** Per-backend audiences — exchanging the caller's
token for one scoped and audienced to the target backend (RFC 8693 token
exchange) — would remove the replay surface entirely. It needs support on the
authorization server side and is on the roadmap.

---

## 7. What a backend may declare

The gateway trusts backends with their catalog, not with each other's
namespace. At every refresh it drops — with an error on stderr naming the
backend — any declaration a backend does not own:

- **Scopes.** A tool, prompt or resource template must carry a scope under one
  of the backend's prefixes. Default: `mcp:<id>:` (so `docs` may declare
  `mcp:docs:read`, not `mcp:billing:write` nor the floor scope `mcp:access`).
  Without this, a backend could put its tool behind another backend's grant,
  or make it visible to every token.

  ```bash
  CORTEX_BACKEND_DOCS_SCOPE_PREFIXES=mcp:docs:,mcp:quality:
  ```

- **URI schemes.** `resources/read` is routed by scheme, with the caller's
  token. A backend may only claim its own schemes — default: its id — and
  `cortex://` is reserved to the gateway. Two backends configured with the same
  scheme: the first in `CORTEX_BACKENDS` keeps it, the second's templates are
  refused.

  ```bash
  CORTEX_BACKEND_DOCS_URI_SCHEMES=docs,kb
  ```

- **Prompt names** are prefixed like tools (`<app>_<name>`), so two backends
  declaring the same prompt no longer collide, and neither can shadow the
  other's.

**Upgrading from 0.2.x.** A backend whose scopes do not start with
`mcp:<id>:` loses those tools at the first refresh after upgrade — set its
`_SCOPE_PREFIXES` explicitly. Prompt names change from `<name>` to
`<app>_<name>` on the agent side; backends still receive their own name.

---

## 8. Resource reads are scope-checked

`resources/templates/list` was always filtered by scope; `resources/read` was
not, so any valid token could read any resource of a known scheme by guessing
its URI. A read now resolves the templates the URI falls under and requires
the scope of **every** one of them — with overlapping templates
(`docs://{kind}/{id}` at read, `docs://admin/{id}` at admin), granting on any
match would let the broad one open the narrow one. A URI that matches no
declared template is refused: the scope that gates it cannot be determined, so
it cannot be granted. Matching is case-sensitive past the scheme, and a URI
carrying dot segments or a percent-encoded `/`, `.`, `\` or `%` is refused
before matching, since the backend could resolve it into a path the matcher
never saw. The `read_cortex_resource` builtin goes through the same check.

`cortex://architecture` is readable by any token, so it is rendered for the
caller: only the backends it holds a scope on, the tools it can see there,
and no backend URL. The server instructions (`initialize`,
`server/discover`) likewise name only the backends the caller holds a scope
on.

---

## 9. Smaller hardening

- **Pool sandbox closed by default.** With `CORTEX_REQUIRED_POOL` set, a token
  **without** a `pool` claim is refused too — it used to pass — and the check
  covers the SSE stream (GET) and session termination (DELETE), not only POST.
- **Canonical URI required in production.** Without `CORTEX_CANONICAL_URI`
  the gateway answers 503 `server_misconfigured`, with the reason on stderr,
  rather than falling back to `http://localhost:3213/mcp` as its audience.
- **Dev bypass.** Compared in constant time, accepted only for an exact
  loopback `Host` with no forwarding header, never under
  `NODE_ENV=production`, and with no implicit role (it used to default to
  `admin`). `npm run dev` binds to 127.0.0.1.
- **Client IP.** `X-Forwarded-For` is read only when you declare your proxies
  (`CORTEX_TRUSTED_PROXY_HOPS=1` behind one nginx), and then from the right:
  the leftmost entry is whatever the client wrote. The request limit keys on
  the token's `jti`, then its `sub`; the IP is only the last resort.
- **Missing-capability tickets.** Text fields are bounded before storage,
  forwarding and notification, and each identity may file
  `CORTEX_TICKET_RATE_PER_HOUR` tickets per hour (default 20).
- **Audit purge.** `CRON_SECRET` is accepted in the `x-cron-secret` header of
  a POST only, compared in constant time. The query-string form and the GET
  handler are gone: a URL lands in logs and link previews, and one fetched
  link would purge the audit trail.

---

## Reporting

Report security issues privately, through a GitHub security advisory on
<https://github.com/wellknownmcp/cortex-gateway/security/advisories> — not a
public issue.
