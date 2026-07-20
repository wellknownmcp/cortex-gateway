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

**Limits, stated plainly.** The baseline lives in the process and is rebuilt at
boot from whatever the backends currently declare — so a restart implicitly
re-approves the current state, and in a multi-instance deployment each replica
keeps its own. That is honest for what it is: mutation detection during a
process's lifetime, not attestation. A persistent, operator-signed baseline
(and the corresponding approval workflow) is the next step, and it is a real
one — do not read the current control as more than it is.

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

## Reporting

Report security issues privately, through a GitHub security advisory on
<https://github.com/wellknownmcp/cortex-gateway/security/advisories> — not a
public issue.
