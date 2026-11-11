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
 *  4. Checks the MCP Apps relay end to end (the suite has no scenario for
 *     the extension): published `_meta.ui`, view read, structuredContent.
 *  5. Runs every server scenario, with the known gaps listed in baseline.yml:
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



/** One legacy JSON-RPC call through the proxy; returns the parsed response. */
async function rpc(target, method, params = {}) {
  const res = await fetch(target, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  // The gateway may frame a response as SSE: take the data line.
  const payload = text.trimStart().startsWith('{') ? text : (text.split('\n').find((l) => l.startsWith('data:')) ?? '').slice(5);
  return JSON.parse(payload);
}

/**
 * The fixture declares `ui_panel` with `ui: { resourceUri: 'ui://panel' }`.
 * Through the production build and the real OAuth path, a client must see the
 * view under the backend id, read it, and get the result in structured form.
 */
async function checkMcpAppsRelay(target) {
  const expect = (cond, what) => {
    if (!cond) throw new Error(`MCP Apps relay: ${what}`);
  };
  const init = await rpc(target, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'relay-check', version: '0' } });
  expect(init.result?.capabilities?.extensions?.['io.modelcontextprotocol/ui'], 'extension not announced by initialize');

  const listed = await rpc(target, 'tools/list');
  const panel = listed.result?.tools?.find((t) => t.name === 'test_ui_panel');
  expect(panel?._meta?.ui?.resourceUri === 'ui://test/panel', `_meta.ui.resourceUri is ${JSON.stringify(panel?._meta?.ui)}`);

  const view = await rpc(target, 'resources/read', { uri: 'ui://test/panel' });
  const content = view.result?.contents?.[0];
  expect(content?.uri === 'ui://test/panel', 'view not served under its published URI');
  expect(content?.mimeType === 'text/html;profile=mcp-app' && content?.text?.includes('Fixture view'), 'view content not relayed');
  expect(content?._meta?.ui?.prefersBorder === true, 'view _meta not relayed');

  const undeclared = await rpc(target, 'resources/read', { uri: 'ui://test/other' });
  expect(undeclared.error, 'an undeclared view was served');
  const foreign = await rpc(target, 'resources/read', { uri: 'ui://json/panel' });
  expect(foreign.error, 'a view was served under a backend that does not declare it');

  const called = await rpc(target, 'tools/call', { name: 'test_ui_panel', arguments: {} });
  expect(called.result?.structuredContent?.items === 3, 'structuredContent missing from the view tool result');
  expect(called.result?.content?.[0]?.text === '{"status":"ok","items":3}', 'text content of the view tool changed');
}

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
  log(`gateway federating the fixture at ${url}`);

  // ─── 4. MCP Apps relay ───────────────────────────────────────────────────
  await checkMcpAppsRelay(url);
  log('MCP Apps relay: ok, running the suite');

  // ─── 5. The suite ────────────────────────────────────────────────────────
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
