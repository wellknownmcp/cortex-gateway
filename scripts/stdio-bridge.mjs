#!/usr/bin/env node
/**
 * stdio ↔ Streamable HTTP bridge.
 *
 * Lets stdio-only MCP clients (and directory sandboxes such as Glama's
 * Docker inspection, which wrap the CMD in `mcp-proxy`) talk to this
 * gateway, which only speaks Streamable HTTP with OAuth 2.1.
 *
 * What it does:
 *  1. Generates an ephemeral RSA keypair and serves its JWKS on a local
 *     HTTP port — a throwaway authorization server for this process only.
 *  2. Boots the production gateway (`next start`) pointed at that issuer,
 *     so the REAL OAuth verification path is exercised (no bypass).
 *  3. Mints itself a short-lived Bearer JWT and relays newline-delimited
 *     JSON-RPC between stdin/stdout and POST /mcp, tracking the
 *     Mcp-Session-Id and MCP-Protocol-Version headers.
 *
 * The child's stdout/stderr are redirected to stderr: stdout carries
 * nothing but JSON-RPC, as the stdio transport requires.
 *
 * Environment:
 *  - BRIDGE_GATEWAY_PORT  port for the gateway (default 3213)
 *  - BRIDGE_SCOPES        space/comma-separated scopes to self-grant
 *                         (default none — gateway builtins need none)
 *  - everything else is passed through to the gateway, except
 *    OAUTH_ISSUER / OAUTH_JWKS_URL / OAUTH_AUDIENCE / CORTEX_CANONICAL_URI
 *    and OAUTH_INTROSPECT_*, which the bridge owns.
 *
 * Usage: node scripts/stdio-bridge.mjs   (or `pnpm run start:stdio`)
 */

import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { SignJWT } from 'jose';

const log = (...args) => console.error('[stdio-bridge]', ...args);

const GATEWAY_PORT = Number.parseInt(process.env.BRIDGE_GATEWAY_PORT ?? '3213', 10);
const CANONICAL_URI = `http://localhost:${GATEWAY_PORT}/mcp`;
const MCP_URL = `http://127.0.0.1:${GATEWAY_PORT}/mcp`;
const READY_TIMEOUT_MS = 45_000;
const TOKEN_TTL_S = 3600;
const TOKEN_REFRESH_MARGIN_S = 600;

// ─── 1. Ephemeral authorization server (JWKS only) ────────────────────────

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), use: 'sig', alg: 'RS256', kid: 'stdio-bridge' };

const jwksServer = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ keys: [jwk] }));
});
await new Promise((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
const issuer = `http://127.0.0.1:${jwksServer.address().port}`;
log(`ephemeral issuer on ${issuer}`);

const scopes = (process.env.BRIDGE_SCOPES ?? '').split(/[,\s]+/).filter(Boolean).join(' ');

let cachedToken = null;
let cachedTokenExp = 0;
async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < cachedTokenExp - TOKEN_REFRESH_MARGIN_S) return cachedToken;
  cachedTokenExp = now + TOKEN_TTL_S;
  cachedToken = await new SignJWT({ scope: scopes, client_id: 'stdio-bridge' })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .setIssuer(issuer)
    .setAudience(CANONICAL_URI)
    .setSubject('stdio-bridge')
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(cachedTokenExp)
    .sign(privateKey);
  return cachedToken;
}

// ─── 2. Boot the gateway against the ephemeral issuer ─────────────────────

const require = createRequire(import.meta.url);
const nextBin = join(dirname(require.resolve('next/package.json')), 'dist/bin/next');

const child = spawn(
  process.execPath,
  [nextBin, 'start', '-p', String(GATEWAY_PORT)],
  {
    env: {
      ...process.env,
      OAUTH_ISSUER: issuer,
      OAUTH_JWKS_URL: `${issuer}/.well-known/jwks.json`,
      OAUTH_AUDIENCE: CANONICAL_URI,
      CORTEX_CANONICAL_URI: CANONICAL_URI,
      OAUTH_INTROSPECT_URL: '',
      OAUTH_INTROSPECT_CLIENT_ID: '',
      OAUTH_INTROSPECT_CLIENT_SECRET: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
// stdout is reserved for JSON-RPC: everything the gateway prints goes to stderr
child.stdout.pipe(process.stderr);
child.stderr.pipe(process.stderr);

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  jwksServer.close();
  child.kill();
  process.exit(code);
}
child.on('exit', (code) => {
  if (!shuttingDown) {
    log(`gateway exited with code ${code}`);
    shutdown(code ?? 1);
  }
});
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const deadline = Date.now() + READY_TIMEOUT_MS;
for (;;) {
  try {
    await fetch(`http://127.0.0.1:${GATEWAY_PORT}/`, { signal: AbortSignal.timeout(2000) });
    break;
  } catch {
    if (Date.now() > deadline) {
      log('gateway did not become ready in time');
      shutdown(1);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}
log(`gateway ready on ${MCP_URL}`);

// ─── 3. Relay newline-delimited JSON-RPC ──────────────────────────────────

let sessionId = null;
let protocolVersion = null;

async function forward(message) {
  const id = typeof message === 'object' && message !== null && 'id' in message ? message.id : undefined;
  try {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${await getToken()}`,
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    // The MCP-Protocol-Version header carries the NEGOTIATED version, so it
    // is only sent after initialize. During initialize the negotiation lives
    // in the body — the client may request a version the gateway does not
    // support, and the gateway answers with its preferred one.
    if (protocolVersion && message?.method !== 'initialize') {
      headers['mcp-protocol-version'] = protocolVersion;
    }

    const res = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(message) });

    const newSession = res.headers.get('mcp-session-id');
    if (newSession) sessionId = newSession;

    // Notifications are acknowledged with an empty 202 — nothing to relay
    if (res.status === 202 || res.status === 204) return;

    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // fall through to the synthesized error below
    }

    // Only valid JSON-RPC goes to stdout. Transport-level error bodies
    // (401/403/429 `{error: ...}` shapes) are converted to JSON-RPC errors.
    if (!body || body.jsonrpc !== '2.0') {
      if (id === undefined || id === null) return;
      const detail = body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: `bridge: gateway returned ${detail}` } }) +
          '\n',
      );
      return;
    }

    if (message?.method === 'initialize' && typeof body?.result?.protocolVersion === 'string') {
      protocolVersion = body.result.protocolVersion;
    }
    process.stdout.write(JSON.stringify(body) + '\n');
  } catch (err) {
    if (id === undefined || id === null) return; // notification: nothing to answer
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: `bridge: ${err instanceof Error ? err.message : 'relay failed'}` },
      }) + '\n',
    );
  }
}

// Sequential queue: preserves ordering (initialize must settle before the
// session id is reused by subsequent requests)
let queue = Promise.resolve();

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n',
    );
    return;
  }
  queue = queue.then(() => forward(message));
});
rl.on('close', () => {
  queue.then(() => shutdown(0));
});
