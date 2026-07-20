/**
 * Tool definition integrity — rug-pull detection.
 *
 * A federated gateway is the one place that sees every tool definition before
 * an agent does. A backend that silently rewrites the `description` or
 * `inputSchema` of an already-approved tool is the classic "rug pull": the
 * name stays stable, the approval sticks, the semantics change under the
 * agent. Name-level change detection does not catch it.
 *
 * This module fingerprints the full security-relevant surface of each tool at
 * first sight, then re-checks it at every catalog refresh:
 *
 *   - `added`    a tool name never seen before
 *   - `removed`  a known tool that disappeared
 *   - `mutated`  a known tool whose definition changed (with the field list)
 *
 * Enforcement is driven by `CORTEX_TOOL_INTEGRITY_MODE`:
 *   - `warn`  (default) — mutations are logged and pushed as a
 *                         `tools/list_changed` notification; the new
 *                         definition is served.
 *   - `block`           — mutated tools are quarantined: withheld from
 *                         `tools/list` and refused at `tools/call` until an
 *                         operator acknowledges them.
 *
 * Scope of the baseline: the process. It is rebuilt at boot from whatever the
 * backends currently declare, so a restart implicitly re-approves the current
 * state. That is a deliberate trade-off — a persistent, signed baseline is the
 * next step (see docs/security.md), not something to fake with a cache.
 */

import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CortexBackendTool, FederatedToolEntry } from '@/contract';

/** Fields whose change alters what the agent is told the tool does. */
const FINGERPRINTED_FIELDS = [
  'scope',
  'description',
  'params',
  'inputSchema',
  'version',
  'deprecated',
] as const;

type FingerprintedField = (typeof FINGERPRINTED_FIELDS)[number];

interface ToolBaseline {
  app: string;
  firstSeenAt: Date;
  /** Canonical JSON per fingerprinted field — lets us name what changed. */
  fields: Record<FingerprintedField, string>;
  digest: string;
}

export interface ToolMutation {
  tool: string;
  app: string;
  changed: FingerprintedField[];
  firstSeenAt: string;
}

export interface ToolIntegrityDiff {
  added: string[];
  removed: string[];
  mutated: ToolMutation[];
  /** Names withheld from the catalog (block mode only). */
  quarantined: string[];
}

export type ToolIntegrityMode = 'warn' | 'block';

let baseline = new Map<string, ToolBaseline>();
/** Mutated tools withheld in block mode, until acknowledged. */
const quarantine = new Map<string, ToolMutation>();

export function integrityMode(): ToolIntegrityMode {
  return process.env.CORTEX_TOOL_INTEGRITY_MODE?.toLowerCase() === 'block' ? 'block' : 'warn';
}

/* ── Persistence ──────────────────────────────────────────────────────────
 *
 * Without a store, the baseline is rebuilt at boot from whatever the backends
 * declare — so a restart re-approves the current state, and restarting is
 * something whoever runs a backend can often induce. That turns the whole
 * control into "detects mutations, unless you wait for a deploy".
 *
 * The store is a JSON file, not the database: this is a security control, and
 * one that silently degrades when Postgres is unreachable is worse than one
 * that plainly does not exist. A file also keeps the control usable in the
 * deployment the gateway is most often run as — a single container with a
 * volume — with no schema to migrate.
 *
 * Scope, stated plainly: one file is one baseline. Replicas sharing a volume
 * share their approvals; replicas with local disks each keep their own.
 *
 * ── Signing ───────────────────────────────────────────────────────────────
 *
 * An unsigned store is forgeable by anyone who can write the file. Signing it
 * with a key the gateway holds fixes less than it looks: whoever can write the
 * volume can usually read the environment too. The gain is real but narrow —
 * a restored backup, a volume mounted elsewhere, a process that can write the
 * path but not read the env.
 *
 * The mode that actually shifts the trust boundary is the one where the
 * gateway holds ONLY the public key. It can then verify approvals but not
 * mint them: a new or changed definition stays quarantined until an operator
 * signs it offline, with a key that never touches the server. Both modes are
 * supported, and the report says which one is in force — because "signed" on
 * its own does not tell an operator whether the signer is the machine that
 * could be compromised.
 *
 * The envelope borrows its shape from LLMFeed's `trust` block (signed_blocks,
 * scope, algorithm, trust_level, public_key_hint): declaring WHAT a signature
 * covers, rather than implying it covers everything, is the useful idea there.
 *
 * One deliberate divergence from llmca.org's mcp-canonical-json/v1, which
 * refuses to sort keys because an LLM reads a feed as text and key order
 * carries meaning: this file is read by the gateway, never by a model, so
 * determinism is the only requirement and sorting removes any dependence on
 * Map iteration order. That argument does NOT transfer to the tool
 * fingerprints themselves — see the note on FINGERPRINTED_FIELDS.
 */

const STORE_VERSION = 1;
const SIGNATURE_ALGORITHM = 'Ed25519';

interface StoreTrust {
  /** Top-level keys the signature covers. Anything else is not attested. */
  signed_blocks: string[];
  scope: 'partial';
  algorithm: typeof SIGNATURE_ALGORITHM;
  /** `self-signed` = the gateway holds the private key; `operator` = it does not. */
  trust_level: 'self-signed' | 'operator';
  public_key_hint?: string;
}

interface StoreSignature {
  value: string;
  created_at: string;
  public_key: string;
}

interface StoredBaseline {
  version: number;
  savedAt: string;
  tools: Record<string, { app: string; firstSeenAt: string; fields: Record<string, string>; digest: string }>;
  quarantine: Record<string, ToolMutation>;
  trust?: StoreTrust;
  signature?: StoreSignature;
}

const SIGNED_BLOCKS = ['version', 'savedAt', 'tools', 'quarantine'] as const;

/** `\n` arrives literal through most .env plumbing; restore it before parsing. */
function normalizePem(pem: string): string {
  return pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem;
}

function privateKeyPem(): string | null {
  const raw = process.env.CORTEX_BASELINE_PRIVATE_KEY;
  return raw ? normalizePem(raw) : null;
}

function publicKeyPem(): string | null {
  const raw = process.env.CORTEX_BASELINE_PUBLIC_KEY;
  return raw ? normalizePem(raw) : null;
}

/** True when signatures are expected — an unsigned store must then be refused. */
function signingConfigured(): boolean {
  return Boolean(privateKeyPem() || publicKeyPem());
}

/** The exact bytes a signature covers: the signed blocks, canonically ordered. */
function signedPayload(data: StoredBaseline): string {
  const subset: Record<string, unknown> = {};
  for (const key of SIGNED_BLOCKS) subset[key] = data[key];
  return canonical(subset);
}

/** Set once the store has been read (or found absent) — load is idempotent. */
let storeLoaded = false;
/** True when a store is configured but unusable; surfaced in the report. */
let storeDegraded: string | null = null;

function storePath(): string | null {
  return process.env.CORTEX_TOOL_BASELINE_FILE || null;
}

/**
 * Returns the reason a store's signature is unacceptable, or null when it is
 * fine (including "no signing configured, none expected").
 */
function verifyStore(data: StoredBaseline): string | null {
  const expected = signingConfigured();

  if (!data.signature) {
    // A store that arrives unsigned while signing is configured is the strip
    // attack: delete two keys and the file is trusted again. Refuse it.
    return expected ? 'unsigned store while signing is configured' : null;
  }
  if (!expected) {
    // Signed store, no key to check it against. Ignoring the signature would
    // make it decoration; refusing outright would break an operator who just
    // removed the key. Say what is wrong and let the report carry it.
    return 'store is signed but no CORTEX_BASELINE_PUBLIC_KEY/PRIVATE_KEY is configured';
  }

  let verifyKey: string;
  try {
    const configuredPublic = publicKeyPem();
    if (configuredPublic) {
      verifyKey = configuredPublic;
      // The embedded key is a convenience for offline tooling, never the
      // authority: trusting it would let a forger ship their own key pair.
      const embedded = createPublicKey(data.signature.public_key)
        .export({ type: 'spki', format: 'pem' })
        .toString();
      const configured = createPublicKey(configuredPublic)
        .export({ type: 'spki', format: 'pem' })
        .toString();
      if (embedded !== configured) return 'signed by a key other than the configured public key';
    } else {
      // Private key only: derive the public half rather than trust the file's.
      verifyKey = createPublicKey(privateKeyPem()!)
        .export({ type: 'spki', format: 'pem' })
        .toString();
    }
  } catch (err) {
    return `key error (${err instanceof Error ? err.message : 'invalid key'})`;
  }

  const ok = verify(
    null,
    Buffer.from(signedPayload(data), 'utf8'),
    verifyKey,
    Buffer.from(data.signature.value, 'base64'),
  );
  return ok ? null : 'signature does not match the stored baseline';
}

function loadStore(): void {
  if (storeLoaded) return;
  storeLoaded = true;

  const path = storePath();
  if (!path) {
    if (integrityMode() === 'block') {
      // eslint-disable-next-line no-console
      console.warn(
        '[cortex/tool-integrity] block mode without CORTEX_TOOL_BASELINE_FILE — ' +
          'the baseline is in-memory, so a restart re-approves every current definition.',
      );
    }
    return;
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // First boot with a store configured. The current catalog becomes the
      // approved state — unavoidable, and the one moment it is legitimate.
      // eslint-disable-next-line no-console
      console.warn('[cortex/tool-integrity] no baseline file yet — establishing one from this refresh', {
        path,
      });
      return;
    }
    storeDegraded = `unreadable (${code ?? 'error'})`;
    // eslint-disable-next-line no-console
    console.error('[cortex/tool-integrity] baseline file unreadable — running in-memory', { path, code });
    return;
  }

  try {
    const data = JSON.parse(raw) as StoredBaseline;
    if (data.version !== STORE_VERSION) {
      throw new Error(`unsupported store version ${data.version}`);
    }

    const signatureProblem = verifyStore(data);
    if (signatureProblem) {
      // Same failure class as a corrupt file, and handled the same way: a
      // store we cannot vouch for must not become the approved state.
      storeDegraded = signatureProblem;
      // eslint-disable-next-line no-console
      console.error(
        '[cortex/tool-integrity] baseline signature rejected — every federated tool will be withheld',
        { path, reason: signatureProblem },
      );
      return;
    }
    for (const [name, t] of Object.entries(data.tools ?? {})) {
      baseline.set(name, {
        app: t.app,
        firstSeenAt: new Date(t.firstSeenAt),
        fields: t.fields as Record<FingerprintedField, string>,
        digest: t.digest,
      });
    }
    for (const [name, m] of Object.entries(data.quarantine ?? {})) {
      quarantine.set(name, m);
    }
    // eslint-disable-next-line no-console
    console.warn('[cortex/tool-integrity] baseline restored', {
      path,
      tools: baseline.size,
      quarantined: quarantine.size,
      savedAt: data.savedAt,
    });
  } catch (err) {
    // A corrupt file is NOT treated as "no baseline": that would let deleting
    // or truncating the file launder a rewritten definition into a fresh
    // approval — the same hole as an induced restart, one `echo >` away.
    // Refuse to serve any federated tool until an operator intervenes.
    storeDegraded = `corrupt (${err instanceof Error ? err.message : 'parse error'})`;
    // eslint-disable-next-line no-console
    console.error(
      '[cortex/tool-integrity] baseline file is corrupt — every federated tool will be withheld ' +
        'until it is repaired or removed deliberately',
      { path },
    );
  }
}

/** Warned once per process, not once per refresh. */
let warnedVerifyOnly = false;

function persistStore(): void {
  const path = storePath();
  if (!path || storeDegraded) return;

  // Verify-only: the gateway can check approvals but not create them. This is
  // the point of the mode, not a limitation to work around — writing an
  // unsigned store here would silently drop the guarantee at the first new
  // tool. The catalog change stays in memory and, in block mode, quarantined
  // until an operator signs the new state offline.
  if (!privateKeyPem() && publicKeyPem()) {
    if (!warnedVerifyOnly) {
      warnedVerifyOnly = true;
      // eslint-disable-next-line no-console
      console.warn(
        '[cortex/tool-integrity] verify-only (public key without private key): the catalog changed ' +
          'but the baseline was NOT updated. Sign the new state offline — scripts/sign-baseline.mjs.',
      );
    }
    return;
  }

  const data: StoredBaseline = {
    version: STORE_VERSION,
    savedAt: new Date().toISOString(),
    tools: Object.fromEntries(
      Array.from(baseline, ([name, b]) => [
        name,
        { app: b.app, firstSeenAt: b.firstSeenAt.toISOString(), fields: b.fields, digest: b.digest },
      ]),
    ),
    quarantine: Object.fromEntries(quarantine),
  };

  try {
    const priv = privateKeyPem();
    if (priv) {
      const pub = createPublicKey(priv).export({ type: 'spki', format: 'pem' }).toString();
      data.trust = {
        signed_blocks: [...SIGNED_BLOCKS],
        scope: 'partial',
        algorithm: SIGNATURE_ALGORITHM,
        trust_level: 'self-signed',
        public_key_hint: process.env.CORTEX_BASELINE_PUBLIC_KEY_HINT || undefined,
      };
      data.signature = {
        value: sign(null, Buffer.from(signedPayload(data), 'utf8'), priv).toString('base64'),
        created_at: new Date().toISOString(),
        public_key: pub,
      };
    }

    mkdirSync(dirname(path), { recursive: true });
    // Write-then-rename: a crash mid-write leaves the previous baseline intact
    // rather than a truncated file, which would be read as corrupt on boot.
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[cortex/tool-integrity] could not persist the baseline', {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Canonical JSON: object keys sorted recursively, so that a backend
 * reserializing the same schema in a different key order is not reported as a
 * mutation. Only key order is normalized — values are compared as-is.
 *
 * Known gap, worth stating rather than discovering later. llmca.org's
 * mcp-canonical-json/v1 profile refuses to sort keys, on the grounds that a
 * model reads a document as text and key order carries meaning — so sorting
 * would let someone reorder after signing and change model behaviour without
 * breaking the signature. That argument applies here too: a backend that only
 * reorders the properties of an `inputSchema`, or the members of an `enum`,
 * produces an identical digest and no mutation, while what the model reads has
 * changed.
 *
 * Sorting is still right for THIS use. The fingerprint's job is to separate a
 * semantic change from serialization noise, and backends re-serialize their
 * schemas constantly — through ORMs, JSON codecs, proxies. An order-sensitive
 * digest would fire on every one of those, and a control that cries wolf on
 * every deploy is a control that gets turned off.
 *
 * The real answer is two digests: this one for "what it says changed", and an
 * order-sensitive one for "how it is presented changed", reported distinctly
 * so an operator can weigh them differently. Not built yet.
 */
function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

function fieldsOf(tool: CortexBackendTool): Record<FingerprintedField, string> {
  const out = {} as Record<FingerprintedField, string>;
  for (const field of FINGERPRINTED_FIELDS) {
    out[field] = canonical((tool as unknown as Record<string, unknown>)[field]);
  }
  return out;
}

function digestOf(fields: Record<FingerprintedField, string>): string {
  return createHash('sha256')
    .update(FINGERPRINTED_FIELDS.map((f) => `${f}=${fields[f]}`).join(' '))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Compares a freshly built catalog against the baseline, updates the baseline,
 * and — in block mode — returns the set of tools to withhold.
 *
 * Called once per refresh, before the catalog is published. `entries` is keyed
 * by the federated (prefixed) tool name.
 */
export function reviewCatalog(
  entries: Map<string, FederatedToolEntry>,
  healthyApps: readonly string[],
): ToolIntegrityDiff {
  loadStore();

  const mode = integrityMode();
  const diff: ToolIntegrityDiff = { added: [], removed: [], mutated: [], quarantined: [] };

  // A configured store that could not be read leaves us with no approved
  // state to compare against. Serving the catalog anyway would mean treating
  // every definition as approved on the word of whoever just made the file
  // unreadable. In block mode, withhold everything and say so.
  if (storeDegraded && mode === 'block') {
    diff.quarantined = Array.from(entries.keys());
    for (const name of diff.quarantined) {
      quarantine.set(name, {
        tool: name,
        app: entries.get(name)!.app.id,
        changed: [],
        firstSeenAt: new Date(0).toISOString(),
      });
    }
    // eslint-disable-next-line no-console
    console.error('[cortex/tool-integrity] no usable baseline — withholding every federated tool', {
      reason: storeDegraded,
      withheld: diff.quarantined.length,
    });
    return diff;
  }

  const next = new Map<string, ToolBaseline>();

  for (const [name, entry] of entries) {
    const fields = fieldsOf(entry.tool);
    const digest = digestOf(fields);
    const known = baseline.get(name);

    if (!known) {
      diff.added.push(name);
      next.set(name, { app: entry.app.id, firstSeenAt: new Date(), fields, digest });
      continue;
    }

    if (known.digest === digest) {
      // Unchanged: keep the original firstSeenAt, it is the approval anchor.
      next.set(name, known);
      continue;
    }

    const mutation: ToolMutation = {
      tool: name,
      app: entry.app.id,
      changed: FINGERPRINTED_FIELDS.filter((f) => known.fields[f] !== fields[f]),
      firstSeenAt: known.firstSeenAt.toISOString(),
    };
    diff.mutated.push(mutation);

    if (mode === 'block') {
      // Quarantine: the tool is withheld and the baseline keeps the ORIGINAL
      // definition, so the mutation stays reported until acknowledged.
      quarantine.set(name, mutation);
      diff.quarantined.push(name);
      next.set(name, known);
    } else {
      next.set(name, { app: entry.app.id, firstSeenAt: known.firstSeenAt, fields, digest });
    }
  }

  // Absent from this refresh — but "gone" and "its backend did not answer" are
  // not the same thing, and conflating them is exploitable: a backend that
  // goes unreachable for one cycle would drop its own baseline, and come back
  // with rewritten descriptions treated as brand-new tools. Transient
  // unavailability is trivially inducible by whoever runs the backend, so a
  // tool only leaves the baseline when its backend answered and no longer
  // lists it.
  const healthy = new Set(healthyApps);
  for (const [name, known] of baseline) {
    if (entries.has(name)) continue;
    if (!healthy.has(known.app)) {
      next.set(name, known); // backend down: hold the approved definition
      continue;
    }
    diff.removed.push(name);
    quarantine.delete(name);
  }

  // A quarantined tool that a backend reverted to its approved definition
  // clears itself: the digest matched above, so it never re-entered `mutated`.
  let quarantineChanged = false;
  for (const name of Array.from(quarantine.keys())) {
    if (!diff.quarantined.includes(name) && entries.has(name)) {
      const known = next.get(name);
      const current = entries.get(name);
      if (known && current && known.digest === digestOf(fieldsOf(current.tool))) {
        quarantine.delete(name);
        quarantineChanged = true;
      }
    }
  }

  baseline = next;

  if (diff.mutated.length > 0) {
    // eslint-disable-next-line no-console
    console.warn('[cortex/tool-integrity] tool definition changed after approval', {
      mode,
      mutations: diff.mutated.map((m) => `${m.tool}(${m.changed.join('+')})`),
      action: mode === 'block' ? 'quarantined' : 'served',
    });
  }

  // Persist only when something moved. A steady catalog rewrites nothing,
  // which keeps `savedAt` meaningful: it is the last time the approved state
  // actually changed, not the last refresh tick.
  if (diff.added.length || diff.removed.length || diff.mutated.length || quarantineChanged) {
    persistStore();
  }

  return diff;
}

/** True when the tool is currently withheld for an unreviewed mutation. */
export function isQuarantined(name: string): boolean {
  return quarantine.has(name);
}

export function quarantinedTools(): ToolMutation[] {
  return Array.from(quarantine.values());
}

/**
 * Acknowledges a mutation: the tool leaves quarantine and its current
 * definition becomes the new baseline at the next refresh.
 */
export function acknowledgeTool(name: string): boolean {
  const had = quarantine.delete(name);
  if (had) {
    baseline.delete(name);
    // Persist immediately: an acknowledgement that a restart could undo would
    // silently re-quarantine a tool the operator already cleared.
    persistStore();
  }
  return had;
}

/** Snapshot for diagnostics / the security endpoint. */
export function integrityReport(): {
  mode: ToolIntegrityMode;
  trackedTools: number;
  quarantined: ToolMutation[];
  /** Where approvals survive a restart — null means in-memory only. */
  baselineFile: string | null;
  /** Set when a configured store is unusable; the operator must intervene. */
  degraded: string | null;
  /**
   * Who can mint an approval:
   *  - `none`        unsigned store; anyone who can write the file
   *  - `self-signed` the gateway holds the private key, so a host compromise
   *                  can still forge — narrower than it sounds
   *  - `operator`    the gateway only verifies; approvals are signed offline
   */
  signing: 'none' | 'self-signed' | 'operator';
} {
  const priv = Boolean(privateKeyPem());
  const pub = Boolean(publicKeyPem());
  return {
    mode: integrityMode(),
    trackedTools: baseline.size,
    quarantined: quarantinedTools(),
    baselineFile: storePath(),
    degraded: storeDegraded,
    signing: priv ? 'self-signed' : pub ? 'operator' : 'none',
  };
}

/** Test helper — drops the baseline, the quarantine and the store state. */
export function resetIntegrityState(): void {
  baseline = new Map();
  quarantine.clear();
  storeLoaded = false;
  storeDegraded = null;
  warnedVerifyOnly = false;
}
