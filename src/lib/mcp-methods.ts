/**
 * Handlers for the MCP spec 2025-06-18 methods.
 *
 * Implemented:
 * - initialize                 (lifecycle)
 * - notifications/initialized  (lifecycle, 202 no-body at the route level)
 * - tools/list, tools/call     (Tools primitive)
 * - resources/*, prompts/*     (Resources + Prompts primitives)
 * - ping
 *
 * Not implemented (return method_not_found):
 * - sampling/*              (inverse flow)
 * - completion/complete     (auto-complete)
 * - logging/setLevel
 */

import { createHash } from 'node:crypto';
import {
  callBackend,
  CortexBackendError,
  CortexBackendInsufficientScope,
  CortexBackendAclDenied,
  CortexBackendTimeout,
  CortexBackendUnauthorized,
} from '@/contract';
import type { CortexUserContext, CortexBackendResourceRead } from '@/contract';
import {
  getCatalog,
  getOriginalToolName,
  lookupTool,
  listPrompts,
  lookupPrompt,
  listResourceTemplates,
  findBackendForUri,
} from './federator';
import { loadBackends } from './registry';
import { isQuarantined } from './tool-integrity';
import { getPrismaCortex, isDatabaseConfigured } from './prisma';
import { notifyAdminOnBlocking } from './notify';
import { canonicalUri } from './oauth-validator';
import type { ValidatedRequest } from './oauth-validator';

/**
 * Backends that natively implement report_missing_capability + list_tickets
 * (backend-owned tickets pattern). Configured through the
 * `CORTEX_TICKET_BACKENDS` env var (comma-separated backend ids).
 *
 * To migrate a backend: (1) add the model + handlers on the backend side,
 * (2) add its id to CORTEX_TICKET_BACKENDS, (3) restart the gateway.
 */
function backendOwnedTickets(): Set<string> {
  return new Set(
    (process.env.CORTEX_TICKET_BACKENDS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'] as const;
export const SERVER_PROTOCOL_VERSION = '2025-06-18';

export function serverName(): string {
  return process.env.CORTEX_SERVER_NAME ?? 'cortex-gateway';
}

export const SERVER_VERSION = '0.2.0';

const CAPABILITIES = {
  tools: { listChanged: true },
  resources: { subscribe: false, listChanged: true },
  prompts: { listChanged: true },
} as const;

// ─── JSON-RPC types ───────────────────────────────────────────────────────

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

function rpcError(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcError {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function rpcSuccess(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

/**
 * Propagates the backend's business error detail up to the MCP client.
 *
 * Federated backends return rich JSON on 400/500 (e.g. { error:
 * "audienceRoles must be a non-empty array...", received: "string" }).
 * Without this helper the gateway would only surface "Backend 400" and the
 * MCP client would never see the actual cause — an opaque 400 with no way to
 * know what went wrong.
 *
 * The helper composes an explicit message (backend message when present) and
 * attaches the full payload under `data.backendError` for clients that want
 * to inspect it.
 */
function rpcErrorFromBackendError(
  id: string | number | null,
  err: CortexBackendError,
): JsonRpcError {
  const body = (err.body ?? null) as { error?: unknown } | null;
  const backendMsg = typeof body?.error === 'string' ? body.error : null;
  const message = backendMsg ? `${err.message}: ${backendMsg}` : err.message;
  return rpcError(id, -32603, message, {
    status: err.status,
    backendError: err.body ?? null,
  });
}

// ─── Dispatch ─────────────────────────────────────────────────────────────

export type ToolListMode = 'normal' | 'search';

export interface DispatchParams {
  method: string;
  params: unknown;
  id: string | number | null;
  userCtx: ValidatedRequest;
  /**
   * Backends the agent wants to limit `tools/list` to (see the
   * `X-Cortex-Backends` HTTP header). Undefined = no filter = all healthy
   * backends reachable through the caller's scopes. Empty set = explicit
   * filter excluding every federated backend (only gateway builtins listed).
   */
  backendsFilter?: ReadonlySet<string>;
  /**
   * `tools/list` mode (see the `X-Cortex-Tool-Mode` HTTP header):
   * - 'normal' (default): full schemas (compatible with clients that load
   *   the whole tool palette up front)
   * - 'search': ultra-short descriptions + a `find_tools` builtin returning
   *   the full schema on demand. Tool Search Tool pattern adapted to the MCP
   *   protocol. See docs/tool-search-mode.md.
   */
  toolMode?: ToolListMode;
}

export async function handleMethod(args: DispatchParams): Promise<JsonRpcResponse> {
  const { method, params, id, userCtx, backendsFilter, toolMode = 'normal' } = args;

  switch (method) {
    case 'initialize':
      return handleInitialize(id, params);
    case 'tools/list':
      return handleToolsList(id, userCtx, backendsFilter, toolMode);
    case 'tools/call':
      return handleToolsCall(id, params, userCtx);
    case 'resources/list':
      return handleResourcesList(id);
    case 'resources/templates/list':
      return handleResourceTemplatesList(id, userCtx);
    case 'resources/read':
      return handleResourcesRead(id, params, userCtx);
    case 'prompts/list':
      return handlePromptsList(id, userCtx);
    case 'prompts/get':
      return handlePromptsGet(id, params, userCtx);
    case 'ping':
      return rpcSuccess(id, {});
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ─── initialize ───────────────────────────────────────────────────────────

interface InitializeParams {
  protocolVersion?: string;
  clientInfo?: { name?: string; version?: string };
  capabilities?: Record<string, unknown>;
}

function handleInitialize(id: string | number | null, raw: unknown): JsonRpcResponse {
  const params = (raw ?? {}) as InitializeParams;
  const clientVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;

  // Negotiation: echo the client's version when we support it, otherwise our
  // preferred version.
  const negotiated = clientVersion && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(clientVersion)
    ? clientVersion
    : SERVER_PROTOCOL_VERSION;

  // List of healthy federated backends, to orient the agent. Taken from the
  // current catalog; falls back to the configured backend ids on a cold boot
  // (before the first refresh completes).
  const catalog = getCatalog();
  const healthyBackends = catalog.healthyApps.length > 0
    ? catalog.healthyApps
    : loadBackends().map((b) => b.id);

  return rpcSuccess(id, {
    protocolVersion: negotiated,
    capabilities: CAPABILITIES,
    serverInfo: buildServerInfo(),
    instructions: buildServerInstructions(healthyBackends),
  });
}

/**
 * serverInfo with the `icons` + `websiteUrl` fields introduced in the
 * 2025-11-25 spec revision. Clients on older negotiated versions ignore the
 * unknown fields, so they are sent unconditionally. The spec requires icon
 * URIs to be same-origin with the server (clients reject cross-origin), so
 * they are derived from the canonical URI; the PNGs ship in `public/` —
 * replace those files to brand your own deployment.
 */
function buildServerInfo() {
  const origin = new URL(canonicalUri()).origin;
  return {
    name: serverName(),
    version: SERVER_VERSION,
    websiteUrl: process.env.CORTEX_WEBSITE_URL ?? origin,
    icons: [
      { src: `${origin}/icon-light.png`, mimeType: 'image/png', sizes: ['256x256'], theme: 'light' },
      { src: `${origin}/icon-dark.png`, mimeType: 'image/png', sizes: ['256x256'], theme: 'dark' },
    ],
  };
}

/**
 * Enriched system prompt served in the `initialize` response. Four goals:
 *
 * 1. Explain the federation mechanics (`<app>_<tool>` prefix) so the agent
 *    understands why tools are named `docs_*`.
 * 2. List the currently healthy backends to frame attention.
 * 3. Document the `X-Cortex-Backends` header that narrows `tools/list` when
 *    the agent works on a subset.
 * 4. Explicitly recommend "focus on the tools the user asked for" — improves
 *    LLM attention quality at zero token cost.
 */
function buildServerInstructions(healthyBackends: readonly string[]): string {
  const name = serverName();
  return [
    `${name} — an MCP gateway that federates the tools of several backend applications.`,
    '',
    `Backends currently available: ${healthyBackends.join(', ') || 'none yet'}.`,
    '',
    'Naming convention: every federated tool is prefixed with the id of the backend that exposes it (`docs_list_files`, `billing_get_invoice`, ...). Tools without a prefix are gateway builtins (`whoami`, `list_cortex_resources`, `read_cortex_resource`, `report_missing_capability`, `list_cortex_tickets`).',
    '',
    'Backend filtering (recommended): if you mostly work with 1-2 backends this session, add the HTTP header `X-Cortex-Backends: <app1>,<app2>` to your JSON-RPC requests. The gateway then only returns the tools of the listed backends (gateway builtins stay visible). Benefit: 50-80% fewer tools in context, better selection accuracy. This is a context-size optimization, not an access control: it narrows what `tools/list` shows, and does not restrict what a token is allowed to call. Authorization is per-tool OAuth scope.',
    '',
    '`search` mode (programmatic agents): add the header `X-Cortex-Tool-Mode: search` to receive a compact tools/list (names + 1-line descriptions) plus a `find_tools(names? | query?)` builtin that returns full schemas on demand. ~80% smaller tools/list payload. Combine with X-Cortex-Backends when possible.',
    '',
    'Discoverability: each backend exposes a `<app>_get_help(topic?)` tool returning its structured documentation (workflows, conventions, examples). Prefer that source over guessing.',
    '',
    'Focus on the tools the user asked about. Do not invoke tools from other backends without an explicit reason — federation does not mean everything must be cross-pollinated. Tools return structured data; phrasing it for the user is your job.',
  ].join('\n');
}

// ─── Built-in gateway tools (not federated) ──────────────────────────────
// Tools exposed by the gateway directly, not by a federated backend.
// `whoami` returns the caller's OAuth identity + an aggregate of each healthy
// backend's whoami. No scope required: any authenticated session may inspect
// its own context.

const CORTEX_BUILTIN_TOOLS = [
  {
    name: 'whoami',
    description:
      "Returns the caller's OAuth identity (email, sub, pool, scopes, client, audience, jti) and aggregates the whoami of every healthy federated backend (effective role in that backend, derived capabilities). Useful to know who you are and what you may do before invoking a write tool.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } as Record<string, unknown>,
  },
  {
    name: 'list_cortex_resources',
    description:
      "Lists the MCP resources exposed by the gateway (self-describing architecture document, dynamic backend resources through URI templates). Wrapper tool over the resources/list channel, needed because some MCP clients do not surface the resources primitive in their visible tool palette.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } as Record<string, unknown>,
  },
  {
    name: 'read_cortex_resource',
    description:
      "Reads an MCP resource by URI (e.g. cortex://architecture, docs://document/42). Wrapper tool over the resources/read channel. Returns Markdown or JSON depending on the resource. Use after list_cortex_resources to discover available URIs.",
    inputSchema: {
      type: 'object',
      properties: {
        uri: { type: 'string', description: "Resource URI (e.g. 'cortex://architecture')." },
      },
      required: ['uri'],
      additionalProperties: false,
    } as Record<string, unknown>,
  },
  {
    name: 'report_missing_capability',
    description:
      [
        "Reports a missing capability or an insufficient tool to the platform team. Use it when you cannot fulfil a user request because no MCP tool offers what is needed, OR when an existing tool limits you (incomplete return, missing parameter, unhelpful error, ...).",
        '',
        "Typical example: the user asks for a link to a file; you search the returns of list_files / read_file, there is no webUrl field; you report the missing capability. The platform team prioritizes and ships the field in a next release.",
        '',
        "Principle: your ticket is a SIGNAL, not an implementation order. Several converging tickets = a priority. Do not hesitate to report even when unsure — noise is filtered at triage. Do NOT report an obvious bug (the API returns 500) — let the error surface naturally instead.",
        '',
        "Auto-dedup: an identical ticket (same description + same tool + same agent) within 24h just refreshes the timestamp instead of creating a duplicate.",
        '',
        "Before reporting, consider calling `list_cortex_tickets` to check you have not already filed a similar ticket — avoids re-filing in a loop.",
        '',
        'Returns: { ticketId, deduplicated, ackMessage }.',
      ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        whatIWanted: {
          type: 'string',
          description: "The missing capability, in natural language. E.g. 'Give the user a clickable link to a file'.",
        },
        userIntent: {
          type: 'string',
          description: "Why the user needed this capability. Helps understand the business value.",
        },
        contextTool: {
          type: 'string',
          description: "Name of the MCP tool you tried / wanted to use (e.g. 'list_files'). Optional.",
        },
        contextApp: {
          type: 'string',
          description: "Backend concerned (a backend id, or 'cortex' for the gateway itself). Optional but very useful for triage.",
        },
        suggestedShape: {
          type: 'string',
          description: "If you have an idea of the tool signature or returned field, suggest it. E.g. 'Add `webUrl: string` to the list_files return'. Optional.",
        },
        severity: {
          type: 'string',
          enum: ['blocking', 'inconvenient', 'nice_to_have'],
          description: "blocking = you cannot answer the user. inconvenient = workaround exists but with friction. nice_to_have = ergonomic improvement.",
        },
      },
      required: ['whatIWanted', 'userIntent', 'severity'],
      additionalProperties: false,
    } as Record<string, unknown>,
  },
  {
    name: 'list_cortex_tickets',
    description:
      [
        "Lists your own previously filed `report_missing_capability` tickets (auto-filtered by OAuth identity — you do not see other agents' tickets). Useful before re-filing a ticket, or to follow a ticket's status after triage by the platform team.",
        '',
        "Possible statuses: open (just filed), triaged (the team looked at it), planned (work scheduled), resolved (capability shipped, resolvedPrUrl points at the PR), wont_fix (deliberately not implemented, triageNote explains why), duplicate (merged with another).",
        '',
        'Returns: { tickets: [{ id, status, severity, contextTool, contextApp, whatIWanted, suggestedShape, triageNote, resolvedPrUrl, createdAt, updatedAt }] }, sorted by createdAt desc, max 100.',
      ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['open', 'triaged', 'planned', 'resolved', 'wont_fix', 'duplicate'],
          description: 'Filter by status. Optional.',
        },
        severity: {
          type: 'string',
          enum: ['blocking', 'inconvenient', 'nice_to_have'],
          description: 'Filter by severity as declared at filing time. Optional.',
        },
        contextApp: {
          type: 'string',
          description: "Filter by backend (a backend id, or 'cortex'). Optional.",
        },
        limit: {
          type: 'number',
          description: 'Max number of tickets returned. Default 20, max 100.',
        },
      },
      additionalProperties: false,
    } as Record<string, unknown>,
  },
] as const;

export const BUILTIN_TOOL_NAMES: Set<string> = new Set([
  ...CORTEX_BUILTIN_TOOLS.map((t) => t.name),
  'find_tools', // search-mode builtin, dispatched in handleToolsCall even when absent from normal-mode tools/list
]);

// ─── tools/list ──────────────────────────────────────────────────────────

/**
 * Reduces a multi-line description to a single short sentence (~120 chars),
 * for the `search` mode of tools/list (see docs/tool-search-mode.md).
 */
function compactDescription(desc: string): string {
  // Take the first non-empty line, cut at the first sentence or 120 chars
  const firstLine = desc.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const firstSentence = firstLine.split(/(?<=[.?!])\s/)[0] ?? firstLine;
  return firstSentence.length > 120 ? firstSentence.slice(0, 117) + '...' : firstSentence;
}

function handleToolsList(
  id: string | number | null,
  userCtx: ValidatedRequest,
  backendsFilter?: ReadonlySet<string>,
  toolMode: ToolListMode = 'normal',
): JsonRpcResponse {
  const catalog = getCatalog();
  const scopes = new Set(userCtx.scopes);

  // Backend filtering via the `X-Cortex-Backends` header. Gateway builtins
  // (whoami, list_cortex_resources, read_cortex_resource,
  // report_missing_capability, list_cortex_tickets) are ALWAYS listed since
  // they are not attached to a federated backend.
  const federated = Array.from(catalog.tools.values())
    // Tools whose *original* (pre-prefix) name collides with a gateway
    // builtin are masked. E.g. `whoami`, which every backend exposes by
    // contract. The gateway builtin takes priority at dispatch (see
    // handleToolsCall), so the duplicate in tools/list has no use.
    // tool.name is prefixed here (`docs_whoami`); extract the original.
    .filter(({ tool }) => !BUILTIN_TOOL_NAMES.has(getOriginalToolName(tool.name)))
    .filter(({ tool }) => scopes.has(tool.scope))
    .filter(({ app }) => backendsFilter ? backendsFilter.has(app.id) : true)
    .map(({ app, tool }) => {
      const baseDesc = tool.deprecated
        ? `[DEPRECATED — removal ${tool.deprecated.removedAt}${tool.deprecated.replacedBy ? `, use ${tool.deprecated.replacedBy}` : ''}] ${tool.description}`
        : tool.description;
      const fullDesc = `[${app.id}] ${baseDesc}`;
      // In 'search' mode: compact description + minimal inputSchema.
      // The agent calls find_tools(names: [...]) to get the full schema.
      const description = toolMode === 'search' ? `[${app.id}] ${compactDescription(baseDesc)}` : fullDesc;
      const inputSchema = toolMode === 'search'
        ? { type: 'object' }
        : toolInputSchema(tool);
      return {
        name: tool.name,
        description,
        inputSchema,
        _meta: {
          version: tool.version ?? '1.0.0',
          app: app.id,
          ...(tool.deprecated ? { deprecated: tool.deprecated } : {}),
        },
      };
    });

  // Builtins always listed, no scope filter
  const builtins = toolMode === 'search'
    ? [...CORTEX_BUILTIN_TOOLS, FIND_TOOLS_BUILTIN]
    : CORTEX_BUILTIN_TOOLS;
  const tools = [...builtins, ...federated];
  return rpcSuccess(id, { tools });
}

/**
 * Builtin available in `search` mode only. The agent calls it to retrieve
 * the full schema of one or more tools it has only seen as name + one-line
 * description in the compact tools/list.
 */
const FIND_TOOLS_BUILTIN = {
  name: 'find_tools',
  description: [
    'Returns the full schema (detailed description + inputSchema) of one or more federated tools.',
    '',
    'Only useful in `search` mode (header X-Cortex-Tool-Mode: search), where tools/list returns names and 1-line descriptions only to save LLM context.',
    '',
    'Two usages:',
    '- `names: [...]`: fetch the exact schemas of these tools (most efficient when you know what you want).',
    '- `query: "..."`: fuzzy search by name/description (case-insensitive substring). Limited to 10 results.',
    '',
    'When both are provided, `names` wins.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      names: {
        type: 'array',
        items: { type: 'string' },
        description: "Tool names (with backend prefix, e.g. 'docs_list_files').",
      },
      query: {
        type: 'string',
        description: 'Text search in name + description (case-insensitive substring).',
      },
    },
    additionalProperties: false,
  } as Record<string, unknown>,
};

/**
 * Converts the simplified params format ({ query: 'string', limit: 'number?',
 * tags: 'string[]?' }) into the standard JSON Schema expected by the MCP spec.
 *
 * History note: an earlier converter emitted `{ type: 'string[]' }` directly,
 * which is NOT a valid JSON Schema type. Strict MCP clients silently reject
 * it, and some clients fall back to serializing a singleton as a string
 * instead of a one-element array — producing `filter is not a function`
 * TypeErrors on the backend side. Hence the explicit array conversion.
 *
 * Supported forms:
 * - 'string' | 'number' | 'boolean'            → scalar type
 * - 'string[]' | 'number[]' | 'boolean[]'      → typed array
 * - '?' suffix marks the parameter optional
 */
function typeSpecToSchema(spec: string): Record<string, unknown> {
  if (spec.endsWith('[]')) {
    const itemType = spec.slice(0, -2);
    return { type: 'array', items: { type: itemType } };
  }
  return { type: spec };
}

// Schema exposed to the agent for a federated tool. A backend that provides a
// standard JSON Schema `inputSchema` (MCP) sees it propagated VERBATIM (enum,
// per-param descriptions, oneOf... that the simplified `params` format cannot
// express). Otherwise, the simplified format is converted.
function toolInputSchema(tool: { inputSchema?: Record<string, unknown>; params?: Record<string, string> }): Record<string, unknown> {
  if (tool.inputSchema && typeof tool.inputSchema === 'object') return tool.inputSchema;
  return simplifiedParamsToJsonSchema(tool.params);
}

function simplifiedParamsToJsonSchema(params?: Record<string, string>): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];

  for (const [key, spec] of Object.entries(params ?? {})) {
    const optional = spec.endsWith('?');
    const baseSpec = optional ? spec.slice(0, -1) : spec;
    properties[key] = typeSpecToSchema(baseSpec);
    if (!optional) required.push(key);
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

// ─── tools/call ───────────────────────────────────────────────────────────

interface ToolsCallParams {
  name?: string;
  arguments?: Record<string, unknown>;
}

async function handleToolsCall(id: string | number | null, raw: unknown, userCtx: ValidatedRequest): Promise<JsonRpcResponse> {
  const params = (raw ?? {}) as ToolsCallParams;
  const name = params.name;
  if (!name) {
    return rpcError(id, -32602, 'Invalid params: name required');
  }

  // Gateway builtin tools (not federated)
  if (BUILTIN_TOOL_NAMES.has(name)) {
    if (name === 'whoami') {
      return handleWhoami(id, userCtx);
    }
    if (name === 'list_cortex_resources') {
      // Wrapper over resources/list: returns the catalog as content.text JSON
      const listRes = handleResourcesList(id);
      if ('result' in listRes) {
        return rpcSuccess(id, {
          content: [{ type: 'text', text: JSON.stringify(listRes.result, null, 2) }],
        });
      }
      return listRes;
    }
    if (name === 'read_cortex_resource') {
      // Wrapper over resources/read
      const args = (params.arguments ?? {}) as { uri?: string };
      const uri = args.uri;
      if (!uri) {
        return rpcError(id, -32602, "Argument 'uri' required");
      }
      const readRes = await handleResourcesRead(id, { uri }, userCtx);
      if ('result' in readRes) {
        // Reformat the contents as a tool_result structure
        const rr = readRes.result as { contents?: Array<{ uri: string; mimeType: string; text?: string }> };
        const text = rr.contents?.map((c) => c.text ?? '').join('\n\n') ?? '';
        return rpcSuccess(id, {
          content: [{ type: 'text', text }],
        });
      }
      return readRes;
    }
    if (name === 'report_missing_capability') {
      return handleReportMissingCapability(id, params.arguments ?? {}, userCtx);
    }
    if (name === 'list_cortex_tickets') {
      return handleListCortexTickets(id, params.arguments ?? {}, userCtx);
    }
    if (name === 'find_tools') {
      return handleFindTools(id, params.arguments ?? {}, userCtx);
    }
  }

  // Withheld for an unreviewed definition change (block mode). Reported
  // distinctly from "unknown tool": the caller is not wrong, the tool is
  // pending re-approval.
  if (isQuarantined(name)) {
    return rpcError(id, -32603, 'Tool quarantined: definition changed since approval', {
      tool: name,
      remediation: 'An operator must review and acknowledge the new definition.',
    });
  }

  const entry = lookupTool(name);
  if (!entry) {
    return rpcError(id, -32601, `Unknown tool: ${name}`);
  }

  const scopes = new Set(userCtx.scopes);
  if (!scopes.has(entry.tool.scope)) {
    return rpcError(id, -32603, 'Insufficient scope', {
      required: entry.tool.scope,
      granted: Array.from(scopes),
    });
  }

  const ctx: CortexUserContext = {
    userId: userCtx.sub,
    email: userCtx.email,
    role: userCtx.role,
    pool: userCtx.pool,
    scopes: Array.from(userCtx.scopes),
  };

  // When the tool was prefixed (`docs_get_help`), the backend expects the
  // original name (`get_help`). getOriginalToolName is a no-op for
  // non-prefixed names.
  const backendMethod = getOriginalToolName(name);

  try {
    const result = await callBackend({
      baseUrl: entry.app.baseUrl,
      backendPath: entry.app.backendPath,
      method: backendMethod,
      params: params.arguments ?? {},
      bearerToken: userCtx.bearerToken,
      userContext: ctx,
      timeoutMs: entry.app.timeoutMs ?? 10_000,
    });

    return rpcSuccess(id, {
      // MCP spec: tools/call result = { content: [...], isError?: boolean }
      content: [
        {
          type: 'text',
          text: typeof result === 'string' ? result : JSON.stringify(result),
        },
      ],
    });
  } catch (err) {
    if (err instanceof CortexBackendInsufficientScope) {
      return rpcError(id, -32603, 'Backend refused scope', {
        required: err.requiredScope,
        method: err.method,
      });
    }
    if (err instanceof CortexBackendAclDenied) {
      return rpcError(id, -32603, 'Backend ACL denied', {
        reason: err.reason,
      });
    }
    if (err instanceof CortexBackendUnauthorized) {
      return rpcError(id, -32603, 'Backend auth failed — token may have expired');
    }
    if (err instanceof CortexBackendTimeout) {
      return rpcError(id, -32603, err.message);
    }
    if (err instanceof CortexBackendError) {
      return rpcErrorFromBackendError(id, err);
    }
    return rpcError(id, -32603, err instanceof Error ? err.message : 'Internal error');
  }
}

// ─── builtin: find_tools ─────────────────────────────────────────────────
// Tool Search Tool pattern adapted to the MCP protocol. Available in
// `search` mode only (header X-Cortex-Tool-Mode: search). Returns full
// schemas on demand, avoiding tens of thousands of schema tokens at boot.

interface FindToolsArgs {
  names?: string[];
  query?: string;
}

function handleFindTools(
  id: string | number | null,
  rawArgs: Record<string, unknown>,
  userCtx: ValidatedRequest,
): JsonRpcResponse {
  const args = rawArgs as FindToolsArgs;
  const catalog = getCatalog();
  const scopes = new Set(userCtx.scopes);

  // Catalog filtered by scope + builtin-duplicate masking (see handleToolsList)
  const eligible = Array.from(catalog.tools.values())
    .filter(({ tool }) => !BUILTIN_TOOL_NAMES.has(getOriginalToolName(tool.name)))
    .filter(({ tool }) => scopes.has(tool.scope));

  let matched: typeof eligible;
  if (Array.isArray(args.names) && args.names.length > 0) {
    const wanted = new Set(args.names);
    matched = eligible.filter(({ tool }) => wanted.has(tool.name));
  } else if (typeof args.query === 'string' && args.query.trim().length > 0) {
    const q = args.query.trim().toLowerCase();
    matched = eligible
      .filter(({ tool }) => tool.name.toLowerCase().includes(q) || tool.description.toLowerCase().includes(q))
      .slice(0, 10);
  } else {
    return rpcError(id, -32602, "Argument 'names' (array) or 'query' (string) required");
  }

  const tools = matched.map(({ app, tool }) => {
    const baseDesc = tool.deprecated
      ? `[DEPRECATED — removal ${tool.deprecated.removedAt}${tool.deprecated.replacedBy ? `, use ${tool.deprecated.replacedBy}` : ''}] ${tool.description}`
      : tool.description;
    return {
      name: tool.name,
      description: `[${app.id}] ${baseDesc}`,
      inputSchema: toolInputSchema(tool),
      _meta: {
        version: tool.version ?? '1.0.0',
        app: app.id,
        ...(tool.deprecated ? { deprecated: tool.deprecated } : {}),
      },
    };
  });

  return rpcSuccess(id, {
    content: [{ type: 'text', text: JSON.stringify({ tools }, null, 2) }],
  });
}

// ─── builtin: whoami ─────────────────────────────────────────────────────
// Aggregates OAuth identity (gateway) + each healthy backend's whoami.
// A failing backend is listed with `healthy: false` and the error — it never
// blocks the global response.

async function handleWhoami(
  id: string | number | null,
  userCtx: ValidatedRequest,
): Promise<JsonRpcResponse> {
  const catalog = getCatalog();
  const healthyApps = catalog.healthyApps
    .map((appId) => {
      // Recover the full app definition through any registered tool
      for (const entry of catalog.tools.values()) {
        if (entry.app.id === appId) return entry.app;
      }
      return null;
    })
    .filter((a): a is NonNullable<typeof a> => a !== null)
    // Dedupe when several tools point at the same app
    .filter((app, idx, arr) => arr.findIndex((a) => a.id === app.id) === idx);

  const ctx: CortexUserContext = {
    userId: userCtx.sub,
    email: userCtx.email,
    role: userCtx.role,
    pool: userCtx.pool,
    scopes: Array.from(userCtx.scopes),
  };

  const backendResults = await Promise.allSettled(
    healthyApps.map(async (app) => {
      const res = await callBackend({
        baseUrl: app.baseUrl,
        backendPath: app.backendPath,
        method: 'whoami',
        bearerToken: userCtx.bearerToken,
        userContext: ctx,
        timeoutMs: 5_000,
      });
      return { appId: app.id, whoami: res };
    }),
  );

  const backends = backendResults.map((r, i) => {
    const appId = healthyApps[i].id;
    if (r.status === 'fulfilled') {
      return { app_id: appId, healthy: true, ...(r.value.whoami as Record<string, unknown>) };
    }
    const reason =
      r.reason instanceof CortexBackendError
        ? `${r.reason.name}(${r.reason.status})`
        : r.reason instanceof Error
          ? r.reason.message
          : 'unknown';
    return { app_id: appId, healthy: false, error: reason };
  });

  const payload = {
    identity: {
      sub: userCtx.sub,
      email: userCtx.email,
      pool: userCtx.pool,
      role: userCtx.role,
    },
    session: {
      client_id: userCtx.clientId,
      audience: process.env.OAUTH_AUDIENCE ?? canonicalUri(),
      issuer: process.env.OAUTH_ISSUER ?? null,
      jti: userCtx.jti,
      is_dev_bypass: userCtx.isDevBypass,
    },
    scopes_granted: Array.from(userCtx.scopes),
    backends,
    discovered_at: catalog.lastRefreshedAt.toISOString(),
  };

  return rpcSuccess(id, {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  });
}

// ─── resources/list + read ──────────────────────────────────────────────
// One static resource: `cortex://architecture` — a self-describing Markdown
// document about the gateway, generated live from the current federated
// catalog. Agents can read it to understand the layout before invoking tools.

const STATIC_RESOURCES = [
  {
    uri: 'cortex://architecture',
    name: 'Gateway architecture',
    description:
      'Self-generated description of the gateway: OAuth chain, federation model, live-discovered backends, principles.',
    mimeType: 'text/markdown',
  },
] as const;

function handleResourcesList(id: string | number | null): JsonRpcResponse {
  return rpcSuccess(id, { resources: [...STATIC_RESOURCES] });
}

interface ResourcesReadParams {
  uri?: string;
}

async function handleResourcesRead(
  id: string | number | null,
  raw: unknown,
  userCtx: ValidatedRequest,
): Promise<JsonRpcResponse> {
  const params = (raw ?? {}) as ResourcesReadParams;
  const uri = params.uri;
  if (!uri) {
    return rpcError(id, -32602, 'Invalid params: uri required');
  }

  // Gateway builtin
  if (uri === 'cortex://architecture') {
    const text = renderArchitectureMarkdown(userCtx);
    return rpcSuccess(id, {
      contents: [{ uri, mimeType: 'text/markdown', text }],
    });
  }

  // Dispatch to the federated backend owning the scheme
  const backend = findBackendForUri(uri);
  if (!backend) {
    return rpcError(id, -32601, `Unknown resource or scheme: ${uri}`);
  }

  const ctx: CortexUserContext = {
    userId: userCtx.sub,
    email: userCtx.email,
    role: userCtx.role,
    pool: userCtx.pool,
    scopes: Array.from(userCtx.scopes),
  };

  try {
    const res = await callBackend<CortexBackendResourceRead>({
      baseUrl: backend.baseUrl,
      backendPath: backend.backendPath,
      method: 'read_resource',
      params: { uri },
      bearerToken: userCtx.bearerToken,
      userContext: ctx,
      timeoutMs: backend.timeoutMs ?? 10_000,
    });
    return rpcSuccess(id, res);
  } catch (err) {
    if (err instanceof CortexBackendUnauthorized) {
      return rpcError(id, -32603, 'Backend auth failed');
    }
    if (err instanceof CortexBackendInsufficientScope) {
      return rpcError(id, -32603, 'Backend refused scope', { required: err.requiredScope });
    }
    if (err instanceof CortexBackendAclDenied) {
      return rpcError(id, -32603, 'Backend ACL denied', { reason: err.reason });
    }
    if (err instanceof CortexBackendError) {
      return rpcErrorFromBackendError(id, err);
    }
    return rpcError(id, -32603, err instanceof Error ? err.message : 'Internal error');
  }
}

// ─── resources/templates/list ──────────────────────────────────────────

function handleResourceTemplatesList(
  id: string | number | null,
  userCtx: ValidatedRequest,
): JsonRpcResponse {
  const scopes = new Set(userCtx.scopes);
  const federated = listResourceTemplates()
    .filter((e) => scopes.has(e.template.scope))
    .map((e) => ({
      uriTemplate: e.template.uriTemplate,
      name: e.template.name,
      description: `[${e.app.id}] ${e.template.description}`,
      mimeType: e.template.mimeType,
    }));
  return rpcSuccess(id, { resourceTemplates: federated });
}

// ─── prompts/list + prompts/get ────────────────────────────────────────

function handlePromptsList(
  id: string | number | null,
  userCtx: ValidatedRequest,
): JsonRpcResponse {
  const scopes = new Set(userCtx.scopes);
  const prompts = listPrompts()
    .filter((e) => scopes.has(e.prompt.scope))
    .map((e) => ({
      name: e.prompt.name,
      description: `[${e.app.id}] ${e.prompt.description}`,
      arguments: e.prompt.arguments,
    }));
  return rpcSuccess(id, { prompts });
}

interface PromptsGetParams {
  name?: string;
  arguments?: Record<string, string>;
}

async function handlePromptsGet(
  id: string | number | null,
  raw: unknown,
  userCtx: ValidatedRequest,
): Promise<JsonRpcResponse> {
  const params = (raw ?? {}) as PromptsGetParams;
  const name = params.name;
  if (!name) {
    return rpcError(id, -32602, 'Invalid params: name required');
  }

  const entry = lookupPrompt(name);
  if (!entry) {
    return rpcError(id, -32601, `Unknown prompt: ${name}`);
  }

  const scopes = new Set(userCtx.scopes);
  if (!scopes.has(entry.prompt.scope)) {
    return rpcError(id, -32603, 'Insufficient scope', { required: entry.prompt.scope });
  }

  const ctx: CortexUserContext = {
    userId: userCtx.sub,
    email: userCtx.email,
    role: userCtx.role,
    pool: userCtx.pool,
    scopes: Array.from(userCtx.scopes),
  };

  try {
    const res = await callBackend({
      baseUrl: entry.app.baseUrl,
      backendPath: entry.app.backendPath,
      method: 'get_prompt',
      params: { name, arguments: params.arguments ?? {} },
      bearerToken: userCtx.bearerToken,
      userContext: ctx,
      timeoutMs: entry.app.timeoutMs ?? 10_000,
    });
    return rpcSuccess(id, res);
  } catch (err) {
    if (err instanceof CortexBackendUnauthorized) {
      return rpcError(id, -32603, 'Backend auth failed');
    }
    if (err instanceof CortexBackendError) {
      return rpcErrorFromBackendError(id, err);
    }
    return rpcError(id, -32603, err instanceof Error ? err.message : 'Internal error');
  }
}

function renderArchitectureMarkdown(userCtx: ValidatedRequest): string {
  const catalog = getCatalog();
  const issuer = process.env.OAUTH_ISSUER ?? '(OAUTH_ISSUER not set)';
  const canonical = canonicalUri();
  const audience = process.env.OAUTH_AUDIENCE ?? canonical;

  const apps = new Map<string, { id: string; baseUrl: string; backendPath: string; toolCount: number }>();
  for (const entry of catalog.tools.values()) {
    const existing = apps.get(entry.app.id);
    if (existing) {
      existing.toolCount += 1;
    } else {
      apps.set(entry.app.id, {
        id: entry.app.id,
        baseUrl: entry.app.baseUrl,
        backendPath: entry.app.backendPath,
        toolCount: 1,
      });
    }
  }

  const backendRows = Array.from(apps.values())
    .map((a) => `| \`${a.id}\` | ${a.toolCount} | ${a.baseUrl}${a.backendPath} |`)
    .join('\n');

  const unreachable = catalog.unreachableApps.length > 0
    ? catalog.unreachableApps.map((a) => `\`${a}\``).join(', ')
    : '_none_';

  return `# ${serverName()} — self-description

> An MCP gateway federating the tools of several backend applications.
> Document generated live (${new Date().toISOString()}) from the discovered
> backend catalog.

## Principle

This is an **MCP gateway** conforming to spec 2025-06-18 (Streamable HTTP). It
hosts no business logic: it routes \`tools/call\` invocations to the backend
that owns each tool. Backends are plain HTTP apps exposing a single
\`POST ${'{backendPath}'}\` endpoint (simplified JSON-RPC contract).

Three tiers:

\`\`\`
[MCP agent: Claude Desktop / claude.ai Custom Connector / ...]
         │  HTTPS + OAuth 2.1 JWT (Bearer)
         ▼
[cortex-gateway]  ←— thin gateway, no business logic
         │  HTTPS + same JWT propagated (RFC 8707)
         ▼
[backends: your apps]  ←— domain owners
         │  their own storage
         ▼
[databases owned per app]
\`\`\`

## OAuth 2.1 authentication chain

1. **Issuer**: \`${issuer}\` (your OAuth 2.1 authorization server).
2. **Resource**: \`${canonical}\` (this gateway, canonical URI per RFC 9728).
3. **JWT audience**: \`${audience}\` — tokens issued for an MCP agent carry
   \`aud\` = the gateway's canonical URI (RFC 8707 audience-per-resource).
4. **The gateway** validates signature + \`aud\` + \`exp\` through JWKS.
5. **The gateway** propagates the same Bearer to the federated backend.
6. **Each backend** re-validates the JWT with its own audience configuration.

**Consequence**: a single access_token covers the whole federated session.
Revocation at the authorization server cuts access everywhere simultaneously
(up to the introspection cache TTL, 60s by default).

## Federation model

- **Discovery**: the gateway calls \`list_tools\` on every backend every 60s
  (in-process cache, rebuilt on restart).
- **Scope cascading**: each tool declares its minimum scope
  (\`mcp:docs:read\`, \`mcp:billing:write\`, ...). The gateway filters
  \`tools/list\` by the token's scopes (agents only see what they can invoke).
- **Failure isolation**: an unreachable backend disappears from \`tools/list\`
  without breaking the others.
- **User context propagated** through \`X-Cortex-*\` headers (user id, email,
  role, pool, scopes) for backend-side authorization without re-parsing the JWT.

## Permissions: decentralized

The gateway **decides nothing** about business permissions. Each backend
interprets the caller identity (JWT claims + its own role tables) and applies
its own model. An agent can call \`whoami\` (gateway builtin) to get an
aggregate of its effective roles in each healthy backend before invoking a
write tool.

## Current state

- **Protocol version**: ${SERVER_PROTOCOL_VERSION}
- **Current caller**: \`${userCtx.email || userCtx.sub}\` (pool \`${userCtx.pool || '—'}\`, role \`${userCtx.role || '—'}\`)
- **Granted scopes**: ${Array.from(userCtx.scopes).map((s) => `\`${s}\``).join(', ') || '_none_'}
- **Healthy backends**: ${catalog.healthyApps.length > 0 ? catalog.healthyApps.map((a) => `\`${a}\``).join(', ') : '_none_'}
- **Unreachable backends**: ${unreachable}
- **Total federated tools**: ${catalog.tools.size}
- **Last discovery**: ${catalog.lastRefreshedAt.toISOString()}

### Federated backends

| App | Tools | Endpoint |
|---|---|---|
${backendRows || '_none_'}

## Why this architecture

1. **Separation of responsibilities.** Identity (authorization server),
   routing (gateway), business domain (backends) — one job per tier.
2. **Zero MCP lock-in inside backends.** A backend exposes a standard HTTP
   endpoint, not stdio nor an MCP library. Remove the gateway and you can
   still talk to backends directly (tests, batch jobs, direct integrations).
3. **One JWT, N backends.** No token chain to manage on the agent side.
4. **Centralized revocation.** The OAuth server is the single point of truth.
5. **Dynamic discovery.** Adding a backend = one registry entry + the app
   exposes its backend endpoint. Agents see the new tools within 60s without
   redeploying the gateway.

## Going further

- MCP spec: <https://spec.modelcontextprotocol.io/>
- Backend contract: docs/backend-contract.md in the repository
`;
}

// ─── report_missing_capability ───────────────────────────────────────────

interface ReportArgs {
  whatIWanted?: string;
  userIntent?: string;
  contextTool?: string;
  contextApp?: string;
  suggestedShape?: string;
  severity?: 'blocking' | 'inconvenient' | 'nice_to_have';
}

async function handleReportMissingCapability(
  id: string | number | null,
  args: Record<string, unknown>,
  userCtx: ValidatedRequest,
): Promise<JsonRpcResponse> {
  const payload = args as ReportArgs;

  if (!payload.whatIWanted || !payload.userIntent || !payload.severity) {
    return rpcError(id, -32602, 'whatIWanted, userIntent and severity are required');
  }

  // Backend-owned tickets pattern: each business backend owns its tickets.
  // The gateway owns the tickets that concern the gateway itself (federation,
  // cross-backend navigation, ...). When contextApp points at a migrated
  // backend: forward through the backend endpoint. Otherwise ('cortex' or
  // unspecified): store locally in the gateway DB.
  if (payload.contextApp && backendOwnedTickets().has(payload.contextApp)) {
    return reportMissingCapabilityToBackend(id, payload, userCtx);
  }
  return reportMissingCapabilityToCortexLocal(id, payload, userCtx);
}

async function reportMissingCapabilityToBackend(
  id: string | number | null,
  payload: ReportArgs,
  userCtx: ValidatedRequest,
): Promise<JsonRpcResponse> {
  const backend = loadBackends().find((b) => b.id === payload.contextApp);
  if (!backend) {
    return rpcError(
      id,
      -32603,
      `Backend ${payload.contextApp} is not federated (check CORTEX_BACKEND_${(payload.contextApp ?? '').toUpperCase()}_URL)`,
    );
  }
  try {
    const data = await callBackend<{
      ticketId: string;
      deduplicated: boolean;
      existingStatus?: string;
      ackMessage?: string;
    }>({
      baseUrl: backend.baseUrl,
      backendPath: backend.backendPath,
      method: 'report_missing_capability',
      bearerToken: userCtx.bearerToken,
      params: {
        whatIWanted: payload.whatIWanted,
        userIntent: payload.userIntent,
        severity: payload.severity,
        contextTool: payload.contextTool ?? undefined,
        suggestedShape: payload.suggestedShape ?? undefined,
      },
      timeoutMs: backend.timeoutMs ?? 10_000,
    });
    // Blocking notification → platform team. Only when the ticket is new
    // (not a dedup), to avoid re-notifying on every retry of the agent.
    let adminNotified = false;
    if (payload.severity === 'blocking' && !data.deduplicated) {
      adminNotified = await notifyAdminOnBlocking({
        ticketId: data.ticketId,
        backend: backend.id,
        source: 'backend-owned',
        whatIWanted: payload.whatIWanted!,
        userIntent: payload.userIntent!,
        contextTool: payload.contextTool ?? null,
        contextApp: payload.contextApp ?? null,
        suggestedShape: payload.suggestedShape ?? null,
        agentEmail: userCtx.email ?? null,
        agentSub: userCtx.sub ?? null,
      });
    }

    return rpcSuccess(id, {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ticketId: data.ticketId,
              deduplicated: data.deduplicated,
              backend: backend.id,
              source: 'backend-owned',
              ...(payload.severity === 'blocking' && !data.deduplicated
                ? { adminNotified }
                : {}),
              ackMessage:
                payload.severity === 'blocking' && !data.deduplicated
                  ? `BLOCKING ticket recorded in ${backend.id}. ${adminNotified ? 'Platform team notified — no need to double up on an external channel.' : 'Platform notification failed (check gateway logs) — consider relaying manually if urgent.'}`
                  : data.ackMessage ??
                    (data.deduplicated
                      ? 'An identical ticket was already open within the last 24h — acknowledged, no duplicate created.'
                      : `Ticket recorded in backend ${backend.id}. The platform team will triage.`),
            },
            null,
            2,
          ),
        },
      ],
    });
  } catch (err) {
    if (err instanceof CortexBackendUnauthorized) {
      return rpcError(id, -32603, `Invalid token for backend ${backend.id}`);
    }
    if (err instanceof CortexBackendInsufficientScope) {
      return rpcError(
        id,
        -32603,
        `Insufficient scope to report on ${backend.id} (required: ${err.requiredScope ?? 'n/a'})`,
      );
    }
    if (err instanceof CortexBackendAclDenied) {
      return rpcError(
        id,
        -32603,
        `ACL refused by ${backend.id}: ${err.reason ?? 'insufficient role'}`,
      );
    }
    if (err instanceof CortexBackendTimeout) {
      return rpcError(id, -32603, `Backend ${backend.id} timed out`);
    }
    if (err instanceof CortexBackendError) {
      return rpcError(
        id,
        -32603,
        `Backend ${backend.id} refused the ticket (${err.status})`,
        { body: err.body },
      );
    }
    return rpcError(
      id,
      -32603,
      `Backend ${backend.id} error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Stores the ticket in the gateway's own DB (missing_capabilities table).
 * Used when contextApp is 'cortex' or unspecified: the gateway owns its own
 * tickets (federation, cross-backend navigation...) exactly like a business
 * backend — it dogfoods the pattern it spreads.
 *
 * 24h dedup: sha256(whatIWanted + contextTool) + agentSub OR agentEmail.
 */
async function reportMissingCapabilityToCortexLocal(
  id: string | number | null,
  payload: ReportArgs,
  userCtx: ValidatedRequest,
): Promise<JsonRpcResponse> {
  if (!isDatabaseConfigured()) {
    return rpcError(
      id,
      -32603,
      'Gateway ticket storage is not configured (CORTEX_DATABASE_URL missing). Set contextApp to a backend that owns its tickets, or configure the gateway database.',
    );
  }

  const fingerprintSha = createHash('sha256')
    .update(`${payload.whatIWanted ?? ''}|${payload.contextTool ?? ''}`)
    .digest('hex');

  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const agentMatch = userCtx.sub
    ? { agentSub: userCtx.sub }
    : userCtx.email
      ? { agentEmail: userCtx.email }
      : null;

  try {
    if (agentMatch) {
      const existing = await getPrismaCortex().missingCapability.findFirst({
        where: {
          fingerprintSha,
          createdAt: { gte: since },
          ...agentMatch,
        },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) {
        await getPrismaCortex().missingCapability.update({
          where: { id: existing.id },
          data: { updatedAt: new Date() },
        });
        return rpcSuccess(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  ticketId: existing.id,
                  deduplicated: true,
                  backend: 'cortex',
                  source: 'cortex-local',
                  ackMessage:
                    'An identical ticket was already open within the last 24h — acknowledged, no duplicate created.',
                },
                null,
                2,
              ),
            },
          ],
        });
      }
    }

    const created = await getPrismaCortex().missingCapability.create({
      data: {
        whatIWanted: payload.whatIWanted!,
        userIntent: payload.userIntent!,
        severity: payload.severity!,
        contextTool: payload.contextTool ?? null,
        suggestedShape: payload.suggestedShape ?? null,
        agentSub: userCtx.sub ?? null,
        agentEmail: userCtx.email ?? null,
        fingerprintSha,
      },
    });

    // Blocking notification → platform team. Best-effort, never blocks the response.
    let adminNotified = false;
    if (payload.severity === 'blocking') {
      adminNotified = await notifyAdminOnBlocking({
        ticketId: created.id,
        backend: 'cortex',
        source: 'cortex-local',
        whatIWanted: payload.whatIWanted!,
        userIntent: payload.userIntent!,
        contextTool: payload.contextTool ?? null,
        contextApp: payload.contextApp ?? null,
        suggestedShape: payload.suggestedShape ?? null,
        agentEmail: userCtx.email ?? null,
        agentSub: userCtx.sub ?? null,
      });
    }

    return rpcSuccess(id, {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ticketId: created.id,
              deduplicated: false,
              ...(payload.severity === 'blocking' ? { adminNotified } : {}),
              backend: 'cortex',
              source: 'cortex-local',
              ackMessage:
                payload.severity === 'blocking'
                  ? `BLOCKING ticket recorded. ${adminNotified ? 'Platform team notified — no need to double up on an external channel.' : 'Platform notification failed (check gateway logs) — consider relaying manually if urgent.'}`
                  : 'Ticket recorded in the gateway DB. The platform team will triage. Reminder: one isolated ticket does not trigger work — a recurring pattern does.',
            },
            null,
            2,
          ),
        },
      ],
    });
  } catch (err) {
    return rpcError(
      id,
      -32603,
      `Could not write to the gateway DB: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── list_cortex_tickets ────────────────────────────────────────────────
// Read-only listing of the calling agent's tickets.
// Filtering enforced by agentSub OR agentEmail taken from the JWT.

interface ListTicketsArgs {
  status?: 'open' | 'triaged' | 'planned' | 'resolved' | 'wont_fix' | 'duplicate';
  severity?: 'blocking' | 'inconvenient' | 'nice_to_have';
  contextApp?: string;
  limit?: number;
}

interface AggregatedTicket {
  id: string;
  status: string;
  severity: string;
  contextTool: string | null;
  contextApp: string | null;
  whatIWanted: string;
  userIntent?: string | null;
  suggestedShape: string | null;
  triageNote: string | null;
  resolutionNote?: string | null;
  resolvedPrUrl?: string | null;
  workspaceSlug?: string | null;
  createdAt: string;
  updatedAt: string;
  source: string;
}

interface SourceResult {
  ok: boolean;
  count?: number;
  error?: string;
}

async function handleListCortexTickets(
  id: string | number | null,
  args: Record<string, unknown>,
  userCtx: ValidatedRequest,
): Promise<JsonRpcResponse> {
  const payload = args as ListTicketsArgs;

  if (!userCtx.sub && !userCtx.email) {
    return rpcError(id, -32603, 'Missing OAuth identity (empty sub and email) — cannot filter tickets');
  }

  const limit = typeof payload.limit === 'number' ? Math.min(Math.max(payload.limit, 1), 100) : 20;

  // Which sources to query:
  // - contextApp filter points at a ticket-owning backend → that backend only
  // - contextApp = 'cortex' → gateway local DB only
  // - no filter → aggregate ticket-owning backends + gateway local DB
  const owned = backendOwnedTickets();
  const targetApp = payload.contextApp;
  const fetchBackends = !targetApp || owned.has(targetApp);
  const fetchCortexLocal = !targetApp || targetApp === 'cortex';

  const sources: Record<string, SourceResult> = {};
  const allTickets: AggregatedTicket[] = [];

  if (fetchBackends) {
    const targetBackends = targetApp ? [targetApp] : Array.from(owned);
    const backendsConfig = loadBackends();
    await Promise.all(
      targetBackends.map(async (backendId) => {
        const backend = backendsConfig.find((b) => b.id === backendId);
        if (!backend) {
          sources[backendId] = { ok: false, error: 'not federated (env var missing)' };
          return;
        }
        try {
          const data = await callBackend<{
            tickets: Array<{
              id: string;
              whatIWanted: string;
              userIntent: string;
              contextTool: string | null;
              suggestedShape: string | null;
              severity: string;
              status: string;
              workspaceSlug: string | null;
              triageNote: string | null;
              resolutionNote: string | null;
              createdAt: string;
              updatedAt: string;
            }>;
          }>({
            baseUrl: backend.baseUrl,
            backendPath: backend.backendPath,
            method: 'list_tickets',
            bearerToken: userCtx.bearerToken,
            params: {
              status: payload.status,
              severity: payload.severity,
              limit,
            },
            timeoutMs: backend.timeoutMs ?? 10_000,
          });
          sources[backendId] = { ok: true, count: data.tickets.length };
          for (const t of data.tickets) {
            allTickets.push({
              id: t.id,
              status: t.status,
              severity: t.severity,
              contextTool: t.contextTool,
              contextApp: backendId,
              whatIWanted: t.whatIWanted,
              userIntent: t.userIntent,
              suggestedShape: t.suggestedShape,
              triageNote: t.triageNote,
              resolutionNote: t.resolutionNote,
              workspaceSlug: t.workspaceSlug,
              createdAt: t.createdAt,
              updatedAt: t.updatedAt,
              source: `backend:${backendId}`,
            });
          }
        } catch (err) {
          if (err instanceof CortexBackendInsufficientScope) {
            sources[backendId] = {
              ok: false,
              error: `insufficient scope (${err.requiredScope ?? 'n/a'} required)`,
            };
          } else if (err instanceof CortexBackendAclDenied) {
            sources[backendId] = {
              ok: false,
              error: `ACL denied: ${err.reason ?? 'insufficient role'}`,
            };
          } else if (err instanceof CortexBackendUnauthorized) {
            sources[backendId] = { ok: false, error: 'invalid token' };
          } else if (err instanceof CortexBackendTimeout) {
            sources[backendId] = { ok: false, error: 'timeout' };
          } else {
            sources[backendId] = {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }
      }),
    );
  }

  // Fetch the gateway's local DB (tickets about the gateway itself).
  if (fetchCortexLocal) {
    if (!isDatabaseConfigured()) {
      sources.cortex_local = { ok: false, error: 'gateway DB not configured (CORTEX_DATABASE_URL missing)' };
    } else {
      try {
        const where: Record<string, unknown> = {};
        if (userCtx.sub) where.agentSub = userCtx.sub;
        else if (userCtx.email) where.agentEmail = userCtx.email;
        if (payload.status) where.status = payload.status;
        if (payload.severity) where.severity = payload.severity;

        const rows = await getPrismaCortex().missingCapability.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: limit,
        });
        sources.cortex_local = { ok: true, count: rows.length };
        for (const t of rows) {
          allTickets.push({
            id: t.id,
            status: t.status,
            severity: t.severity,
            contextTool: t.contextTool,
            contextApp: 'cortex',
            whatIWanted: t.whatIWanted,
            userIntent: t.userIntent,
            suggestedShape: t.suggestedShape,
            triageNote: t.triageNote,
            resolutionNote: t.resolutionNote,
            resolvedPrUrl: t.resolvedPrUrl,
            createdAt: t.createdAt.toISOString(),
            updatedAt: t.updatedAt.toISOString(),
            source: 'cortex-local',
          });
        }
      } catch (err) {
        sources.cortex_local = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  // Global sort by createdAt desc + slice at the global limit.
  allTickets.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const sliced = allTickets.slice(0, limit);

  return rpcSuccess(id, {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            count: sliced.length,
            totalFetched: allTickets.length,
            limit,
            filteredBy: userCtx.sub ? { agentSub: userCtx.sub } : { agentEmail: userCtx.email },
            sources,
            tickets: sliced,
          },
          null,
          2,
        ),
      },
    ],
  });
}
