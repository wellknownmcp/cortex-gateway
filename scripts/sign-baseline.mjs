#!/usr/bin/env node
/**
 * Offline signer for the tool-integrity baseline.
 *
 * This exists so the private key never has to sit on the gateway host. The
 * gateway is given only CORTEX_BASELINE_PUBLIC_KEY: it verifies approvals but
 * cannot mint them, so a host compromise cannot forge one. Approving a new or
 * changed tool becomes a deliberate act performed here, wherever the key lives.
 *
 *   node scripts/sign-baseline.mjs keygen
 *   node scripts/sign-baseline.mjs verify <baseline.json>
 *   node scripts/sign-baseline.mjs sign   <baseline.json>
 *
 * `sign` reads the private key from CORTEX_BASELINE_PRIVATE_KEY, or from
 * --key <file.pem>. It rewrites the file in place, atomically.
 *
 * Typical loop with the gateway in verify-only mode: a backend ships a new
 * tool, the gateway quarantines it and logs it; you fetch the baseline, add
 * the tool by hand or copy the definition the gateway reported, re-sign here,
 * put the file back, restart.
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

const SIGNED_BLOCKS = ['version', 'savedAt', 'tools', 'quarantine'];

/**
 * Deterministic serialization of the signed subset. MUST stay byte-identical
 * to canonical() in src/lib/tool-integrity.ts — the gateway verifies what this
 * produces, so any divergence is a signature that never validates.
 */
function canonical(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

function payload(data) {
  const subset = {};
  for (const key of SIGNED_BLOCKS) subset[key] = data[key];
  return Buffer.from(canonical(subset), 'utf8');
}

function normalizePem(pem) {
  return pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem;
}

function loadPrivateKey(args) {
  const fromFile = args.indexOf('--key');
  if (fromFile !== -1 && args[fromFile + 1]) {
    return readFileSync(args[fromFile + 1], 'utf8');
  }
  const env = process.env.CORTEX_BASELINE_PRIVATE_KEY;
  if (env) return normalizePem(env);
  fail('No private key. Set CORTEX_BASELINE_PRIVATE_KEY or pass --key <file.pem>.');
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

const [command, target, ...rest] = process.argv.slice(2);
const args = [target, ...rest];

if (command === 'keygen') {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  console.log('# Private key — keep OFF the gateway host. Store it where you');
  console.log('# keep deploy keys; anyone holding it can approve a tool definition.');
  console.log(priv);
  console.log('# Public key — this is what the gateway gets:');
  console.log('# CORTEX_BASELINE_PUBLIC_KEY="' + pub.trimEnd().replace(/\n/g, '\\n') + '"');
  console.log(pub);
  process.exit(0);
}

if (!target) {
  console.error('usage: sign-baseline.mjs <keygen|sign|verify> [baseline.json] [--key file.pem]');
  process.exit(2);
}

const data = JSON.parse(readFileSync(target, 'utf8'));

if (command === 'verify') {
  if (!data.signature) fail('the baseline carries no signature');
  const pub = createPublicKey(data.signature.public_key);
  const ok = verify(null, payload(data), pub, Buffer.from(data.signature.value, 'base64'));
  if (!ok) fail('SIGNATURE INVALID — the file was modified after signing');
  console.log('signature valid');
  console.log(`  signed at   ${data.signature.created_at}`);
  console.log(`  trust level ${data.trust?.trust_level ?? 'unknown'}`);
  console.log(`  covers      ${(data.trust?.signed_blocks ?? []).join(', ')}`);
  console.log(`  tools       ${Object.keys(data.tools ?? {}).length}`);
  console.log(`  quarantined ${Object.keys(data.quarantine ?? {}).length}`);
  console.log('\nNote: this checks the key embedded in the file. The gateway checks');
  console.log('against its configured CORTEX_BASELINE_PUBLIC_KEY, which is the authority.');
  process.exit(0);
}

if (command === 'sign') {
  const priv = loadPrivateKey(args);
  const pub = createPublicKey(priv).export({ type: 'spki', format: 'pem' }).toString();

  data.trust = {
    signed_blocks: SIGNED_BLOCKS,
    scope: 'partial',
    algorithm: 'Ed25519',
    // Signed off-host: the gateway holds no private key, which is the whole
    // point of using this script rather than letting the gateway self-sign.
    trust_level: 'operator',
    public_key_hint: process.env.CORTEX_BASELINE_PUBLIC_KEY_HINT || undefined,
  };
  data.signature = {
    value: sign(null, payload(data), priv).toString('base64'),
    created_at: new Date().toISOString(),
    public_key: pub,
  };

  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, target);
  console.log(`signed ${target}`);
  console.log(`  tools       ${Object.keys(data.tools ?? {}).length}`);
  console.log(`  quarantined ${Object.keys(data.quarantine ?? {}).length}`);
  process.exit(0);
}

fail(`unknown command "${command}"`);
