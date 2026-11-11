/**
 * Projects a downstream native MCP server onto the Cortex backend contract.
 *
 * Upstream (gateway → adapter): the simplified JSON-RPC backend contract.
 * Downstream (adapter → MCP server): real MCP over Streamable HTTP.
 *
 * Scope: tools (list_tools + tool invocation), the MCP Apps views those tools
 * declare (read_resource on `ui://`), and whoami. Prompts and resource
 * templates return empty catalogs — the federator tolerates that.
 * Interactive MCP features (sampling, elicitation) do not cross the bridge.
 */

import type { CortexBackendTool, CortexBackendToolUi, CortexResourceContent } from '@/contract';
import { MCP_APP_MIME_TYPE, UI_SCHEME_PREFIX, publishUiUri } from '@/lib/mcp-apps';
import { isContentBlock } from '@/lib/content-blocks';
import type { McpServerConfig } from './config';
import { mcpListTools, mcpCallTool, mcpReadResource, type McpCallResult, type McpTool } from './mcp-client';

// ─── Tool names colliding with the backend contract ──────────────────────
// The backend contract has one namespace for its own methods and for tool
// names: the adapter route answers `list_tools`, `whoami`, `read_resource`...
// itself. A downstream tool carrying one of those names is federated under
// an alias, so that calling it can never be mistaken for the contract
// method — in particular, `read_resource` must stay a view read gated by the
// gateway, not a tool whose arguments pick the URI.

const CONTRACT_METHODS: ReadonlySet<string> = new Set([
  'list_tools',
  'list_prompts',
  'list_resource_templates',
  'read_resource',
  'whoami',
]);
const ALIAS_PREFIX = 'tool_';

/**
 * True for a contract method name, and for any name that already looks like
 * the alias of one (`tool_read_resource`, `tool_tool_read_resource`...):
 * those get one more prefix too, which keeps the mapping reversible without
 * remembering anything between list_tools and the call.
 */
function needsAlias(name: string): boolean {
  let base = name;
  while (base.startsWith(ALIAS_PREFIX)) base = base.slice(ALIAS_PREFIX.length);
  return CONTRACT_METHODS.has(base);
}

/** Name a downstream tool is federated under. */
export function toContractToolName(downstreamName: string): string {
  return needsAlias(downstreamName) ? `${ALIAS_PREFIX}${downstreamName}` : downstreamName;
}

/** Inverse of toContractToolName: the downstream name behind a contract-side tool name. */
export function toDownstreamToolName(method: string): string {
  const unaliased = method.startsWith(ALIAS_PREFIX) ? method.slice(ALIAS_PREFIX.length) : null;
  return unaliased !== null && needsAlias(unaliased) ? unaliased : method;
}

// ─── MCP Apps view URIs ───────────────────────────────────────────────────
// The backend contract wants a local `ui://<path>` made of plain segments
// (the gateway publishes it as `ui://<backendId>/<path>`). A third-party
// server is free to use any `ui://` URI: one that already has that shape
// passes as is, any other travels base64url-encoded under the reserved first
// segment `b64`. Stateless and reversible: nothing to remember between
// list_tools and read_resource.

const ENCODED_SEGMENT = 'b64';
const ENCODED_PREFIX = `${UI_SCHEME_PREFIX}${ENCODED_SEGMENT}/`;
const MAX_DOWNSTREAM_URI_LENGTH = 512;

/** Downstream view URI → the backend-local URI the adapter declares. Null when not a usable `ui://`. */
export function toLocalUiUri(downstreamUri: unknown): string | null {
  if (typeof downstreamUri !== 'string' || !downstreamUri.startsWith(UI_SCHEME_PREFIX)) return null;
  if (downstreamUri.length > MAX_DOWNSTREAM_URI_LENGTH) return null;
  const firstSegment = downstreamUri.slice(UI_SCHEME_PREFIX.length).split('/')[0];
  // `publishUiUri` is the judge of what the gateway accepts as a path.
  if (firstSegment !== ENCODED_SEGMENT && publishUiUri('x', downstreamUri) !== null) return downstreamUri;
  return `${ENCODED_PREFIX}${Buffer.from(downstreamUri, 'utf8').toString('base64url')}`;
}

/** Inverse of toLocalUiUri. Null for anything it would not have produced. */
export function toDownstreamUiUri(localUri: unknown): string | null {
  if (typeof localUri !== 'string' || !localUri.startsWith(UI_SCHEME_PREFIX)) return null;
  const downstream = localUri.startsWith(ENCODED_PREFIX)
    ? Buffer.from(localUri.slice(ENCODED_PREFIX.length), 'base64url').toString('utf8')
    : localUri;
  return toLocalUiUri(downstream) === localUri ? downstream : null;
}

/**
 * `_meta.ui` of a downstream tool → `ui` of the backend contract. Reads the
 * nested form and the flat `_meta["ui/resourceUri"]` the spec deprecates but
 * servers still emit.
 */
function bridgeUi(tool: McpTool): CortexBackendToolUi | undefined {
  const meta = tool._meta;
  if (typeof meta !== 'object' || meta === null) return undefined;
  const nested =
    typeof meta.ui === 'object' && meta.ui !== null && !Array.isArray(meta.ui)
      ? (meta.ui as Record<string, unknown>)
      : {};
  const resourceUri = toLocalUiUri(nested.resourceUri ?? meta['ui/resourceUri']);
  const visibility = Array.isArray(nested.visibility)
    ? nested.visibility.filter((v): v is 'model' | 'app' => v === 'model' || v === 'app')
    : [];
  if (!resourceUri && visibility.length === 0) return undefined;
  return {
    ...(resourceUri ? { resourceUri } : {}),
    ...(visibility.length > 0 ? { visibility } : {}),
  };
}

/** list_tools: downstream tools/list mapped onto the backend catalog shape. */
export async function bridgeListTools(
  server: McpServerConfig,
  token: string,
): Promise<{ tools: CortexBackendTool[] }> {
  const downstream = await mcpListTools(server.url, token);
  const tools: CortexBackendTool[] = downstream.map((t) => {
    const ui = bridgeUi(t);
    return {
      name: toContractToolName(t.name),
      description: t.description ?? t.name,
      // Downstream tools declare no Cortex scope: the whole server gets the
      // scope configured for it (per-tool mapping can come later).
      scope: server.scope,
      // Propagated verbatim — the gateway prefers inputSchema when present.
      inputSchema: t.inputSchema ?? { type: 'object' },
      ...(ui ? { ui } : {}),
    };
  });
  return { tools };
}

/**
 * Tool invocation: backend `method` → downstream `tools/call`.
 *
 * The downstream answer is already an MCP CallToolResult. When every block
 * is well formed it is handed back as one — `content` and
 * `structuredContent` together — and the gateway relays it as is: the model
 * reads the text the server wrote, a view reads the structured part, images
 * and embedded resources survive. Otherwise (no block, or one the gateway
 * would not relay) it is flattened as before: the structured part when there
 * is one, else the joined text.
 */
export async function bridgeCallTool(
  server: McpServerConfig,
  token: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const result: McpCallResult = await mcpCallTool(server.url, token, toDownstreamToolName(method), params);

  if (result.isError) {
    const text = extractText(result) || 'Downstream tool reported an error';
    throw new BridgeToolError(text);
  }
  const content = Array.isArray(result.content) ? result.content : [];
  if (content.length > 0 && content.every(isContentBlock)) {
    return {
      content,
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    };
  }
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  const text = extractText(result);
  return text !== '' ? text : result;
}

/**
 * read_resource on a view: backend-local `ui://` URI → downstream
 * `resources/read`. Only `ui://` crosses: the adapter exposes no other
 * resource. The answer comes back under the local URI, the one the gateway
 * asked for.
 */
export async function bridgeReadResource(
  server: McpServerConfig,
  token: string,
  localUri: unknown,
): Promise<{ contents: CortexResourceContent[] }> {
  const downstreamUri = toDownstreamUiUri(localUri);
  if (!downstreamUri) {
    throw new BridgeToolError('Only ui:// resources declared by a tool can be read through the adapter');
  }
  const contents = await mcpReadResource(server.url, token, downstreamUri);
  return {
    contents: contents
      .filter((c) => typeof c === 'object' && c !== null && typeof c.uri === 'string')
      .map((c) => ({
        uri: c.uri === downstreamUri ? (localUri as string) : c.uri,
        mimeType: typeof c.mimeType === 'string' ? c.mimeType : MCP_APP_MIME_TYPE,
        ...(typeof c.text === 'string' ? { text: c.text } : {}),
        ...(typeof c.blob === 'string' ? { blob: c.blob } : {}),
        ...(typeof c._meta === 'object' && c._meta !== null ? { _meta: c._meta } : {}),
      })),
  };
}

export class BridgeToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeToolError';
  }
}

function extractText(result: McpCallResult): string {
  return (result.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n');
}
