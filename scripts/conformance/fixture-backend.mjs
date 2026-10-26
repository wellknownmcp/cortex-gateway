/**
 * Conformance fixture backend, used by scripts/conformance/run.mjs.
 *
 * Served under two backend ids pointing at the same process. Under "test", the
 * gateway prefixes every tool and prompt with "test_" and the default resource
 * scheme is "test": exactly the names the official MCP conformance scenarios
 * expect (test_simple_text, test://static-text...). Under "json", only
 * schema_2020_12_tool survives the per-backend scope check, and is listed as
 * json_schema_2020_12_tool.
 *
 * Each handler returns what the scenario asks a native MCP server to return.
 * What reaches the client is the gateway's doing — that is what is measured.
 */
import { createServer } from 'node:http';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const WAV = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
const S = 'mcp:test:read';

const tools = [
  { name: 'simple_text', scope: S, description: 'Returns simple text.', inputSchema: { type: 'object', properties: {} } },
  { name: 'image_content', scope: S, description: 'Returns an image.', inputSchema: { type: 'object', properties: {} } },
  { name: 'audio_content', scope: S, description: 'Returns audio.', inputSchema: { type: 'object', properties: {} } },
  { name: 'embedded_resource', scope: S, description: 'Returns an embedded resource.', inputSchema: { type: 'object', properties: {} } },
  { name: 'multiple_content_types', scope: S, description: 'Returns mixed content.', inputSchema: { type: 'object', properties: {} } },
  { name: 'error_handling', scope: S, description: 'Always fails.', inputSchema: { type: 'object', properties: {} } },
  { name: 'tool_with_logging', scope: S, description: 'Logs while running.', inputSchema: { type: 'object', properties: {} } },
  { name: 'tool_with_progress', scope: S, description: 'Reports progress.', inputSchema: { type: 'object', properties: {} } },
  { name: 'sampling', scope: S, description: 'Requests sampling.', inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } },
  { name: 'elicitation', scope: S, description: 'Requests elicitation.', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } },
  // Served under backend id "json" → json_schema_2020_12_tool. The "test"
  // backend drops it: mcp:json:read is outside its scope prefix.
  {
    name: 'schema_2020_12_tool',
    scope: 'mcp:json:read',
    description: 'Tool with JSON Schema 2020-12 features',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      $defs: { address: { type: 'object', properties: { street: { type: 'string' }, city: { type: 'string' } } } },
      properties: { name: { type: 'string' }, address: { $ref: '#/$defs/address' } },
      additionalProperties: false,
    },
  },
];

const content = {
  simple_text: [{ type: 'text', text: 'This is a simple text response for testing.' }],
  image_content: [{ type: 'image', data: PNG, mimeType: 'image/png' }],
  audio_content: [{ type: 'audio', data: WAV, mimeType: 'audio/wav' }],
  embedded_resource: [{ type: 'resource', resource: { uri: 'test://embedded-resource', mimeType: 'text/plain', text: 'This is an embedded resource content.' } }],
  multiple_content_types: [
    { type: 'text', text: 'Multiple content types test:' },
    { type: 'image', data: PNG, mimeType: 'image/png' },
    { type: 'resource', resource: { uri: 'test://mixed-content-resource', mimeType: 'application/json', text: '{"test":"data","value":123}' } },
  ],
  tool_with_logging: [{ type: 'text', text: 'Tool with logging executed successfully' }],
  tool_with_progress: [{ type: 'text', text: 'done' }],
};

const handlers = {
  list_tools: () => ({ tools }),
  list_prompts: () => ({
    prompts: [
      { name: 'simple_prompt', scope: S, description: 'Simple prompt.' },
      { name: 'prompt_with_arguments', scope: S, description: 'Prompt with args.', arguments: [{ name: 'arg1', required: true }, { name: 'arg2', required: true }] },
      { name: 'prompt_with_embedded_resource', scope: S, description: 'Prompt with resource.', arguments: [{ name: 'resourceUri', required: true }] },
      { name: 'prompt_with_image', scope: S, description: 'Prompt with image.' },
    ],
  }),
  get_prompt: ({ name, arguments: a = {} }) => {
    const user = (c) => ({ messages: [{ role: 'user', content: c }] });
    if (name === 'simple_prompt') return user({ type: 'text', text: 'This is a simple prompt for testing.' });
    if (name === 'prompt_with_arguments') return user({ type: 'text', text: `Prompt with arguments: arg1='${a.arg1}', arg2='${a.arg2}'` });
    if (name === 'prompt_with_embedded_resource') {
      return { messages: [
        { role: 'user', content: { type: 'resource', resource: { uri: a.resourceUri, mimeType: 'text/plain', text: 'Embedded resource content for testing.' } } },
        { role: 'user', content: { type: 'text', text: 'Please process the embedded resource above.' } },
      ] };
    }
    if (name === 'prompt_with_image') {
      return { messages: [
        { role: 'user', content: { type: 'image', data: PNG, mimeType: 'image/png' } },
        { role: 'user', content: { type: 'text', text: 'Please analyze the image above.' } },
      ] };
    }
    throw Object.assign(new Error('unknown prompt'), { status: 400 });
  },
  list_resource_templates: () => ({
    resourceTemplates: [
      { uriTemplate: 'test://static-text', name: 'Static text', description: 'Static text.', mimeType: 'text/plain', scope: S },
      { uriTemplate: 'test://static-binary', name: 'Static binary', description: 'Static binary.', mimeType: 'image/png', scope: S },
      { uriTemplate: 'test://template/{id}/data', name: 'Template', description: 'Template.', mimeType: 'application/json', scope: S },
      { uriTemplate: 'test://watched-resource', name: 'Watched', description: 'Watched.', mimeType: 'text/plain', scope: S },
    ],
  }),
  read_resource: ({ uri }) => {
    if (uri === 'test://static-text') return { contents: [{ uri, mimeType: 'text/plain', text: 'This is the content of the static text resource.' }] };
    if (uri === 'test://static-binary') return { contents: [{ uri, mimeType: 'image/png', blob: PNG }] };
    if (uri === 'test://watched-resource') return { contents: [{ uri, mimeType: 'text/plain', text: 'Watched resource content.' }] };
    const m = uri.match(/^test:\/\/template\/([^/]+)\/data$/);
    if (m) return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ id: m[1], templateTest: true, data: `Data for ID: ${m[1]}` }) }] };
    throw Object.assign(new Error('unknown resource'), { status: 400 });
  },
  whoami: () => ({ role: 'tester' }),
};

for (const t of tools) {
  handlers[t.name] = () => {
    if (t.name === 'error_handling') throw Object.assign(new Error('This tool intentionally returns an error for testing'), { status: 400 });
    // What a native server returns for tools/call: a CallToolResult.
    return { content: content[t.name] ?? [{ type: 'text', text: 'ok' }] };
  };
}

/** Starts the fixture on 127.0.0.1:<port>; resolves with the server. */
export function startFixtureBackend(port) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
      let rpc;
      try { rpc = JSON.parse(body); } catch { return send(400, { error: 'Invalid JSON' }); }
      const h = handlers[rpc.method];
      if (!h) return send(400, { error: `Unknown method: ${rpc.method}` });
      try { return send(200, h(rpc.params ?? {})); } catch (e) { return send(e.status ?? 500, { error: e.message }); }
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
