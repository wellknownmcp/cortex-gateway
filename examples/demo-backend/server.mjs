/**
 * Minimal Cortex backend — reference implementation of the backend contract
 * (see docs/backend-contract.md). Zero dependencies, single file.
 *
 * Run:   node examples/demo-backend/server.mjs
 * Port:  4820 (override with PORT)
 *
 * It exposes:
 *  - list_tools / list_prompts / list_resource_templates  (catalog, static token OK)
 *  - get_snapshot                                          (aggregates, static token OK)
 *  - get_help, whoami, echo, get_time, list_notes          (data methods, user token required)
 *  - save_note, delete_note                                (write tools — mcp:demo:write scope)
 *
 * DEMO ONLY: it accepts any Bearer token. A real backend must
 *  1. accept the static token (BACKEND_TOKEN) for catalog methods only,
 *  2. verify the user's OAuth JWT (issuer/audience/signature) for data methods,
 *  3. enforce its own ACLs from the X-Cortex-* headers / JWT claims.
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 4820);

const TOOLS = [
  {
    name: 'get_help',
    scope: 'mcp:demo:read',
    description: 'Returns the structured documentation of the demo backend (workflows, conventions, examples).',
    params: { topic: 'string?' },
    version: '1.0.0',
  },
  {
    name: 'echo',
    scope: 'mcp:demo:read',
    description: 'Echoes the message back. Smoke-test tool.',
    params: { message: 'string' },
    version: '1.0.0',
  },
  {
    name: 'get_time',
    scope: 'mcp:demo:read',
    description: 'Returns the current server time (ISO 8601).',
    // Standard JSON Schema escape hatch (propagated verbatim by the gateway)
    inputSchema: {
      type: 'object',
      properties: {
        timezone: { type: 'string', enum: ['utc', 'local'], description: 'Which clock to read.' },
      },
      additionalProperties: false,
    },
    version: '1.0.0',
  },
  {
    name: 'list_notes',
    scope: 'mcp:demo:read',
    description: 'Lists the shared demo notes (in-memory, reset on restart).',
    params: {},
    version: '1.0.0',
  },
  {
    name: 'save_note',
    scope: 'mcp:demo:write',
    description: 'Saves a shared demo note. Requires the write scope — read-only callers do not even see this tool.',
    params: { text: 'string' },
    version: '1.0.0',
  },
  {
    name: 'delete_note',
    scope: 'mcp:demo:write',
    description: 'Deletes a demo note by id. Requires the write scope.',
    params: { id: 'string' },
    version: '1.0.0',
  },
];

// In-memory note store — deliberately ephemeral (public demo).
const MAX_NOTES = 100;
const MAX_NOTE_LENGTH = 500;
const notes = new Map();
let noteSeq = 0;

/**
 * The backend enforces its own ACLs: the gateway already filters tools/list
 * by scope, but a well-behaved backend re-checks on invocation ("the gateway
 * decides nothing"). Demo of the double check.
 */
function requireScope(ctx, scope) {
  if (!ctx.scopes.includes(scope)) {
    const err = new Error(`Scope ${scope} required`);
    err.status = 403;
    throw err;
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const handlers = {
  list_tools: () => ({ tools: TOOLS }),
  list_prompts: () => ({ prompts: [] }),
  list_resource_templates: () => ({ resourceTemplates: [] }),
  get_snapshot: () => ({
    backend: 'demo',
    generatedAt: new Date().toISOString(),
    title: 'Demo backend',
    headline: [
      { key: 'uptime_s', label: 'Uptime', value: Math.round(process.uptime()), unit: 's', status: 'green' },
    ],
  }),
  whoami: (_params, ctx) => ({
    email: ctx.email || null,
    role: ctx.role || null,
    capabilities: ctx.scopes.includes('mcp:demo:write')
      ? ['echo', 'get_time', 'list_notes', 'save_note', 'delete_note']
      : ['echo', 'get_time', 'list_notes'],
  }),
  get_help: (params, ctx) => ({
    topic: params.topic ?? 'overview',
    help: 'Demo backend for cortex-gateway. Read tools: echo(message), get_time(timezone?), list_notes(). Write tools (mcp:demo:write only): save_note(text), delete_note(id). Notes are shared and in-memory: they demonstrate scope tiering, not storage.',
    yourScopes: ctx.scopes,
  }),
  echo: (params) => ({ echoed: params.message ?? '' }),
  get_time: (params) => ({
    time: new Date().toISOString(),
    timezone: params.timezone ?? 'utc',
  }),
  list_notes: () => ({ notes: [...notes.values()] }),
  save_note: (params, ctx) => {
    requireScope(ctx, 'mcp:demo:write');
    const text = String(params.text ?? '').slice(0, MAX_NOTE_LENGTH);
    if (!text) throw new Error('text is required');
    if (notes.size >= MAX_NOTES) {
      // Drop the oldest note — public demo, bounded memory.
      notes.delete(notes.keys().next().value);
    }
    const note = { id: `n${++noteSeq}`, text, at: new Date().toISOString() };
    notes.set(note.id, note);
    return { saved: note };
  },
  delete_note: (params, ctx) => {
    requireScope(ctx, 'mcp:demo:write');
    const id = String(params.id ?? '');
    const existed = notes.delete(id);
    return { deleted: existed, id };
  },
};

createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/api/cortex/backend') {
    return json(res, 404, { error: 'Not found' });
  }
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) {
    return json(res, 401, { error: 'Bearer token required' });
  }

  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    let rpc;
    try {
      rpc = JSON.parse(body);
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    const handler = handlers[rpc.method];
    if (!handler) {
      return json(res, 400, { error: `Unknown method: ${rpc.method}` });
    }
    const ctx = {
      userId: req.headers['x-cortex-user-id'] ?? '',
      email: req.headers['x-cortex-user-email'] ?? '',
      role: req.headers['x-cortex-user-role'] ?? '',
      scopes: (req.headers['x-cortex-scopes'] ?? '').split(' ').filter(Boolean),
    };
    try {
      return json(res, 200, handler(rpc.params ?? {}, ctx));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`demo backend listening on http://127.0.0.1:${PORT}/api/cortex/backend`);
});
