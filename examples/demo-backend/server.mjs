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
 *  - get_help, whoami, echo, get_time                      (data methods, user token required)
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
];

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
    capabilities: ['echo', 'get_time'],
  }),
  get_help: (params) => ({
    topic: params.topic ?? 'overview',
    help: 'Demo backend for cortex-gateway. Tools: echo(message), get_time(timezone?). All read-only.',
  }),
  echo: (params) => ({ echoed: params.message ?? '' }),
  get_time: (params) => ({
    time: new Date().toISOString(),
    timezone: params.timezone ?? 'utc',
  }),
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
      return json(res, 500, { error: String(err?.message ?? err) });
    }
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`demo backend listening on http://127.0.0.1:${PORT}/api/cortex/backend`);
});
