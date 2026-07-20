/**
 * The offline signer and the gateway must agree byte-for-byte on what gets
 * signed. They are separate implementations of the same canonicalization —
 * one in a script that runs on an operator's machine, one in the module that
 * verifies at boot — so a divergence produces signatures that never validate,
 * and it would only show up in production.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewCatalog, integrityReport, resetIntegrityState, isQuarantined } from '../tool-integrity';
import type { CortexBackendTool, FederatedToolEntry } from '@/contract';

const SCRIPT = join(process.cwd(), 'scripts', 'sign-baseline.mjs');
const APP = { id: 'docs', baseUrl: 'https://docs.example', backendPath: '/api/cortex/backend' };

function catalog(...tools: Array<Partial<CortexBackendTool> & { name: string }>) {
  const map = new Map<string, FederatedToolEntry>();
  for (const t of tools) {
    const tool = { scope: 'mcp:docs:read', description: 'Search.', ...t } as CortexBackendTool;
    map.set(tool.name, { app: APP, tool } as FederatedToolEntry);
  }
  return map;
}

describe('offline signer ↔ gateway interop', () => {
  let dir: string;
  let file: string;
  let priv: string;
  let pub: string;

  beforeEach(() => {
    resetIntegrityState();
    dir = mkdtempSync(join(tmpdir(), 'cortex-sign-'));
    file = join(dir, 'baseline.json');
    process.env.CORTEX_TOOL_BASELINE_FILE = file;

    const kp = generateKeyPairSync('ed25519');
    priv = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    pub = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CORTEX_TOOL_BASELINE_FILE;
    delete process.env.CORTEX_BASELINE_PRIVATE_KEY;
    delete process.env.CORTEX_BASELINE_PUBLIC_KEY;
    delete process.env.CORTEX_TOOL_INTEGRITY_MODE;
    rmSync(dir, { recursive: true, force: true });
  });

  function signOffline() {
    execFileSync(process.execPath, [SCRIPT, 'sign', file], {
      env: { ...process.env, CORTEX_BASELINE_PRIVATE_KEY: priv },
    });
  }

  it('the gateway accepts a baseline signed by the script', () => {
    // Establish an unsigned baseline, then sign it the way an operator would.
    reviewCatalog(catalog({ name: 'docs_search', description: 'original' }), ['docs']);
    signOffline();

    // Restart, verify-only: the gateway holds the public key alone.
    resetIntegrityState();
    process.env.CORTEX_BASELINE_PUBLIC_KEY = pub;
    process.env.CORTEX_TOOL_INTEGRITY_MODE = 'block';

    const diff = reviewCatalog(catalog({ name: 'docs_search', description: 'rewritten' }), ['docs']);
    expect(integrityReport().degraded).toBeNull();
    expect(integrityReport().signing).toBe('operator');
    // The approval held: this is a mutation, not a new tool.
    expect(diff.mutated).toHaveLength(1);
    expect(diff.quarantined).toEqual(['docs_search']);
  });

  it('the script rejects a baseline tampered with after signing', () => {
    reviewCatalog(catalog({ name: 'docs_search' }), ['docs']);
    signOffline();

    const stored = JSON.parse(readFileSync(file, 'utf8'));
    stored.tools.docs_search.digest = 'forged';
    writeFileSync(file, JSON.stringify(stored, null, 2));

    expect(() =>
      execFileSync(process.execPath, [SCRIPT, 'verify', file], { stdio: 'pipe' }),
    ).toThrow();
  });

  it('the script validates what it just signed', () => {
    reviewCatalog(catalog({ name: 'docs_search' }), ['docs']);
    signOffline();

    const out = execFileSync(process.execPath, [SCRIPT, 'verify', file], {
      encoding: 'utf8',
    });
    expect(out).toMatch(/signature valid/);
    expect(out).toMatch(/trust level operator/);
  });

  it('a tool added while the gateway is verify-only stays out of the store', () => {
    reviewCatalog(catalog({ name: 'docs_search' }), ['docs']);
    signOffline();
    const before = readFileSync(file, 'utf8');

    resetIntegrityState();
    process.env.CORTEX_BASELINE_PUBLIC_KEY = pub;
    process.env.CORTEX_TOOL_INTEGRITY_MODE = 'block';
    reviewCatalog(catalog({ name: 'docs_search' }, { name: 'docs_exfiltrate' }), ['docs']);

    // Unchanged on disk: the gateway cannot approve without the private key.
    expect(readFileSync(file, 'utf8')).toBe(before);

    // Not quarantined, deliberately: a name never seen before does not carry a
    // stale client approval — the client prompts for it like any new tool.
    // What verify-only refuses is to record it as approved behind the
    // operator's back, so the on-disk state keeps saying what was reviewed.
    expect(isQuarantined('docs_exfiltrate')).toBe(false);
  });
});
