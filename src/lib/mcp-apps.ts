/**
 * MCP Apps relay — extension `io.modelcontextprotocol/ui`, spec 2026-01-26
 * (https://github.com/modelcontextprotocol/ext-apps).
 *
 * The gateway builds no interface. It lets through the ones its backends
 * declare, in three places, all kept here as pure functions:
 *
 * 1. `tools/list`: a federated tool declaring `ui` carries
 *    `_meta.ui = { resourceUri: 'ui://<backendId>/<path>', visibility? }`.
 *    The backend's own URI (`ui://<path>`) is prefixed with its id, the way
 *    its tool names are (`docs_search`): two backends can keep the same path,
 *    and routing never has to guess who owns `ui://`.
 * 2. `tools/call`: for those tools only, a plain object result is also served
 *    as `structuredContent` (what the view reads). The text `content` is
 *    unchanged: it is what the model and view-less clients read.
 * 3. `resources/read` on `ui://<backendId>/<path>`: forwarded to the backend's
 *    `read_resource` with its local URI, relayed with the published one.
 *
 * No new path to the backends: a call made from a view is an ordinary
 * `tools/call`, with the caller's token and the same scope checks.
 */
import type { CortexBackendTool, CortexResourceContent } from '@/contract';

export const UI_EXTENSION = 'io.modelcontextprotocol/ui';
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

/** `capabilities.extensions`, for `initialize` (legacy) and `server/discover` (2026-07-28). */
export const UI_EXTENSION_CAPABILITY = {
  [UI_EXTENSION]: { mimeTypes: [MCP_APP_MIME_TYPE] },
} as const;

export const UI_SCHEME_PREFIX = 'ui://';
/** One path segment: starts alphanumeric, so neither `.` nor `..` can appear. */
const SEGMENT = '[a-z0-9][a-z0-9._~-]*';
const SAFE_PATH = new RegExp(`^${SEGMENT}(/${SEGMENT})*$`, 'i');
const BACKEND_ID = new RegExp(`^${SEGMENT}$`);
const MAX_URI_LENGTH = 1024;

export type UiVisibility = 'model' | 'app';
export interface PublishedUiMeta {
  resourceUri?: string;
  visibility?: UiVisibility[];
}

/**
 * `ui://preview` declared by `docs` → `ui://docs/preview`. Null when the URI
 * is not a `ui://` the gateway can route back unambiguously.
 */
export function publishUiUri(backendId: string, backendUri: string): string | null {
  if (typeof backendUri !== 'string' || backendUri.length > MAX_URI_LENGTH) return null;
  if (!BACKEND_ID.test(backendId) || !backendUri.startsWith(UI_SCHEME_PREFIX)) return null;
  const path = backendUri.slice(UI_SCHEME_PREFIX.length);
  if (!SAFE_PATH.test(path)) return null;
  return `${UI_SCHEME_PREFIX}${backendId}/${path}`;
}

/** Inverse of publishUiUri: `ui://docs/preview` → `{ backendId: 'docs', backendUri: 'ui://preview' }`. */
export function parsePublishedUiUri(uri: string): { backendId: string; backendUri: string } | null {
  if (typeof uri !== 'string' || !uri.startsWith(UI_SCHEME_PREFIX)) return null;
  const rest = uri.slice(UI_SCHEME_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const backendId = rest.slice(0, slash);
  const backendUri = `${UI_SCHEME_PREFIX}${rest.slice(slash + 1)}`;
  // Exact round trip: anything publishUiUri would not have produced is refused.
  return publishUiUri(backendId, backendUri) === uri ? { backendId, backendUri } : null;
}

function declaredUi(tool: Pick<CortexBackendTool, 'ui'>): Record<string, unknown> | null {
  const ui = tool.ui as unknown;
  return typeof ui === 'object' && ui !== null && !Array.isArray(ui) ? (ui as Record<string, unknown>) : null;
}

/**
 * The `_meta.ui` block to publish for a tool, or undefined (no interface
 * declared, or nothing valid in the declaration). An invalid `resourceUri`
 * drops the URI only: the tool stays listed, and a declared `visibility` is
 * kept — losing it would show the model a tool its backend reserved to a view.
 */
export function publishedUiMeta(backendId: string, tool: Pick<CortexBackendTool, 'ui'>): PublishedUiMeta | undefined {
  const ui = declaredUi(tool);
  if (!ui) return undefined;
  const resourceUri = typeof ui.resourceUri === 'string' ? publishUiUri(backendId, ui.resourceUri) : null;
  const visibility = Array.isArray(ui.visibility)
    ? ui.visibility.filter((v): v is UiVisibility => v === 'model' || v === 'app')
    : [];
  if (!resourceUri && visibility.length === 0) return undefined;
  return {
    ...(resourceUri ? { resourceUri } : {}),
    ...(visibility.length > 0 ? { visibility } : {}),
  };
}

/** False for a tool reserved to views (`visibility` without `model`). Default visibility is both. */
export function isModelVisible(backendId: string, tool: Pick<CortexBackendTool, 'ui'>): boolean {
  const visibility = publishedUiMeta(backendId, tool)?.visibility;
  return !visibility || visibility.includes('model');
}

/** `structuredContent` to add to the result of a tool declaring `ui`: a plain JSON object only. */
export function uiStructuredContent(
  tool: Pick<CortexBackendTool, 'ui'>,
  result: unknown,
): Record<string, unknown> | undefined {
  if (!declaredUi(tool)) return undefined;
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return undefined;
  return result as Record<string, unknown>;
}

/**
 * Contents of a backend `read_resource` answer for one view, under its
 * published URI. Only the entries for the URI that was asked are relayed —
 * the scope check covered that view and no other — and only the fields the
 * spec defines. `mimeType` and `_meta` (CSP, permissions, rendering hints)
 * are the backend's and pass untouched; a missing `mimeType` reads as the
 * only one the extension defines.
 */
export function republishContents(
  contents: readonly CortexResourceContent[] | undefined,
  backendUri: string,
  publishedUri: string,
): CortexResourceContent[] {
  if (!Array.isArray(contents)) return [];
  return contents
    .filter((c) => typeof c === 'object' && c !== null && c.uri === backendUri)
    .map((c) => ({
      uri: publishedUri,
      mimeType: typeof c.mimeType === 'string' ? c.mimeType : MCP_APP_MIME_TYPE,
      ...(typeof c.text === 'string' ? { text: c.text } : {}),
      ...(typeof c.blob === 'string' ? { blob: c.blob } : {}),
      ...(typeof c._meta === 'object' && c._meta !== null && !Array.isArray(c._meta) ? { _meta: c._meta } : {}),
    }));
}
