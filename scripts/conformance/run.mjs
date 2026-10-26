#!/usr/bin/env node
/**
 * Runs the official MCP conformance suite (@modelcontextprotocol/conformance)
 * against this gateway, federating the fixture backend.
 *
 *  1. Starts the fixture backend (scripts/conformance/fixture-backend.mjs).
 *  2. Starts an ephemeral authorization server (JWKS only), like the stdio
 *     bridge, and boots the gateway against it: the REAL OAuth verification
 *     path is exercised, no dev bypass.
 *  3. Puts a small proxy in front that adds a Bearer token — the suite's server
 *     scenarios connect without OAuth.
 *  4. Runs every server scenario, with the known gaps listed in baseline.yml:
 *     a new failure, or a listed one that starts passing, fails the run.
 *
 * Usage:
 *   npm run build && node scripts/conformance/run.mjs     (production server, as in CI)
 *   CONFORMANCE_NEXT=dev node scripts/conformance/run.mjs  (next dev, no build needed)
 */

import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import { startFixtureBackend } from './fixture-backend.mjs';

const SUITE_VERSION = '0.1.16';
const HERE = dirname(fileURLToPath(import.meta.url));
const GATEWAY_PORT = 3213;
const FIXTURE_PORT = 4830;
const CANONICAL_URI = `http://localhost:${GATEWAY_PORT}/mcp`;
const log = (...args) => console.error('[conformance]', ...args);

// ─── 1. Fixture backend ───────────────────────────────────────────────────

const fixture = await startFixtureBackend(FIXTURE_PORT);

// ─── 2. Ephemeral authorization server + gateway ──────────────────────────

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), use: 'sig', alg: 'RS256', kid: 'conformance' };
const jwks = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ keys: [jwk] }));
});
await new Promise((resolve) => jwks.listen(0, '127.0.0.1', resolve));
const issuer = `http://127.0.0.1:${jwks.address().port}`;

const now = Math.floor(Date.now() / 1000);
const token = await new SignJWT({ scope: 'mcp:test:read mcp:json:read', client_id: 'conformance' })
  .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
  .setIssuer(issuer)
  .setAudience(CANONICAL_URI)
  .setSubject('conformance')
  .setJti(randomUUID())
  .setIssuedAt(now)
  .setExpirationTime(now + 3600)
  .sign(privateKey);

// ─── Proxy adding the Bearer token ────────────────────────────────────────
// Started before the gateway: its origin is the one the gateway must allow.

const proxy = createServer((req, res) => {
  const headers = { ...req.headers, authorization: `Bearer ${token}` };
  const up = request({ host: '127.0.0.1', port: GATEWAY_PORT, path: req.url, method: req.method, headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', (e) => {
    res.writeHead(502);
    res.end(String(e));
  });
  req.pipe(up);
});
await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${proxy.address().port}/mcp`;

const require = createRequire(import.meta.url);
const nextBin = join(dirname(require.resolve('next/package.json')), 'dist/bin/next');
const mode = process.env.CONFORMANCE_NEXT === 'dev' ? 'dev' : 'start';
const gateway = spawn(process.execPath, [nextBin, mode, '-p', String(GATEWAY_PORT), '-H', '127.0.0.1'], {
  cwd: join(HERE, '..', '..'),
  env: {
    ...process.env,
    CORTEX_BACKENDS: 'test,json',
    CORTEX_BACKEND_TEST_URL: `http://127.0.0.1:${FIXTURE_PORT}`,
    CORTEX_BACKEND_JSON_URL: `http://127.0.0.1:${FIXTURE_PORT}`,
    CORTEX_TECHNICAL_TOKEN: randomUUID(),
    OAUTH_ISSUER: issuer,
    OAUTH_JWKS_URL: `${issuer}/.well-known/jwks.json`,
    OAUTH_AUDIENCE: CANONICAL_URI,
    CORTEX_CANONICAL_URI: CANONICAL_URI,
    CORTEX_DEV_BYPASS_TOKEN: '',
    CORTEX_DATABASE_URL: '',
    // A localhost server declares its own origin; production allows no
    // localhost origin by default (lib/origins.ts). The DNS-rebinding scenario
    // checks both sides: this origin accepted, a foreign one refused.
    CORTEX_ALLOWED_ORIGINS: new URL(url).origin,
    NEXT_TELEMETRY_DISABLED: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
gateway.stdout.pipe(process.stderr);
gateway.stderr.pipe(process.stderr);



let exitCode = 1;
try {
  // The catalog is discovered in the background once /mcp is first loaded:
  // wait until the fixture's tools are federated, not merely for the port.
  const deadline = Date.now() + 300_000;
  for (;;) {
    const listed = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      signal: AbortSignal.timeout(30_000),
    })
      .then((r) => r.text())
      .catch(() => '');
    if (listed.includes('test_simple_text') && listed.includes('json_schema_2020_12_tool')) break;
    if (Date.now() > deadline) throw new Error('fixture tools never appeared in tools/list');
    await new Promise((r) => setTimeout(r, 1000));
  }
  log(`gateway federating the fixture, running the suite against ${url}`);

  // ─── 4. The suite ────────────────────────────────────────────────────────
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  exitCode = await new Promise((resolve) => {
    const suite = spawn(
      npx,
      [
        '-y',
        `@modelcontextprotocol/conformance@${SUITE_VERSION}`,
        'server',
        '--url', url,
        '--suite', 'all',
        '--expected-failures', join(HERE, 'baseline.yml'),
      ],
      { stdio: 'inherit', shell: process.platform === 'win32' },
    );
    suite.on('exit', (code) => resolve(code ?? 1));
  });
} catch (err) {
  log(err instanceof Error ? err.message : err);
} finally {
  gateway.kill();
  proxy.close();
  jwks.close();
  fixture.close();
}
process.exit(exitCode);
