/**
 * Two generations of the MCP protocol served on the same `/mcp` endpoint.
 *
 * - **Legacy** (2025-11-25, 2025-06-18, 2025-03-26): `initialize` handshake,
 *   `Mcp-Session-Id` session. What most deployed clients speak; this path is
 *   unchanged.
 * - **Modern** (2026-07-28): stateless. Every request carries its version in
 *   the `MCP-Protocol-Version` header AND in `params._meta`, plus `Mcp-Method`
 *   / `Mcp-Name` headers mirroring the body. No `initialize`, no session,
 *   `server/discover` is mandatory, every result carries `resultType` and
 *   `serverInfo` in its `_meta`, list results carry `ttlMs` / `cacheScope`.
 *
 * Spec: https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
 * ("dual-era server") and .../basic/transports/streamable-http (Server Validation).
 *
 * Pure module (no I/O): the route calls it, mcp-methods uses it to wrap
 * modern results.
 */

import { REFRESH_INTERVAL_MS } from './federator';

export const MODERN_VERSION = '2026-07-28';
/** Versions served by the historical `initialize` path, preferred first. */
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
export const SUPPORTED_VERSIONS: readonly string[] = [MODERN_VERSION, ...LEGACY_VERSIONS];
/**
 * A request without a `MCP-Protocol-Version` header is treated as 2025-03-26,
 * the revision that predates the header (spec 2026-07-28 §Protocol Version
 * Header: "MAY").
 */
export const DEFAULT_LEGACY_VERSION = '2025-03-26';

/** Codes reserved to the MCP spec (-32020 to -32099), see basic/index §Error Codes. */
export const CODE_HEADER_MISMATCH = -32020;
export const CODE_UNSUPPORTED_PROTOCOL_VERSION = -32022;
const CODE_INVALID_PARAMS = -32602;

export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
export const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
export const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

export type Generation = 'legacy' | 'modern';

/** Protocol-level refusal: always HTTP 400 with a JSON-RPC error. */
export interface ProtocolRefusal {
  status: 400;
  code: number;
  message: string;
  data?: unknown;
}

export type Detection =
  | { ok: true; generation: Generation; version: string }
  | { ok: false; refusal: ProtocolRefusal };

/** A header value echoed in an error message is bounded. */
function bound(value: string): string {
  return value.length > 100 ? `${value.slice(0, 100)}…` : value;
}

function unsupportedVersion(requested: string): ProtocolRefusal {
  return {
    status: 400,
    code: CODE_UNSUPPORTED_PROTOCOL_VERSION,
    message: 'Unsupported protocol version',
    data: { supported: SUPPORTED_VERSIONS, requested: bound(requested) },
  };
}

function headerMismatch(message: string): ProtocolRefusal {
  return { status: 400, code: CODE_HEADER_MISMATCH, message: `Header mismatch: ${message}` };
}

/**
 * Header-only check, done BEFORE authentication like the historical check: an
 * unknown version is refused without reading the body. The refusal is a
 * JSON-RPC -32022 (previously `{ error: 'unsupported_protocol_version' }`),
 * which modern clients recognize and retry with a version from `supported`.
 */
export function checkVersionHeader(header: string | null): ProtocolRefusal | null {
  if (header === null) return null;
  return SUPPORTED_VERSIONS.includes(header) ? null : unsupportedVersion(header);
}

function metaOf(params: unknown): Record<string, unknown> | null {
  if (typeof params !== 'object' || params === null) return null;
  const meta = (params as { _meta?: unknown })._meta;
  return typeof meta === 'object' && meta !== null ? (meta as Record<string, unknown>) : null;
}

/**
 * Determines the generation of a request (body read, auth done).
 *
 * Modern = header `MCP-Protocol-Version: 2026-07-28` and/or a version in
 * `params._meta`. Everything else (legacy or absent header, no `_meta`
 * version) follows the historical path, with no additional check.
 */
export function detectGeneration(headers: Headers, params: unknown): Detection {
  const header = headers.get('mcp-protocol-version');
  const meta = metaOf(params);
  const metaVersion = meta?.[META_PROTOCOL_VERSION];

  if (header !== MODERN_VERSION && metaVersion === undefined) {
    return { ok: true, generation: 'legacy', version: header ?? DEFAULT_LEGACY_VERSION };
  }

  // `_meta` fields mandatory on every modern request (basic/index §_meta):
  // missing = malformed request, -32602 with HTTP 400.
  if (typeof metaVersion !== 'string') {
    return {
      ok: false,
      refusal: { status: 400, code: CODE_INVALID_PARAMS, message: `Invalid params: _meta["${META_PROTOCOL_VERSION}"] required` },
    };
  }
  if (header === null) {
    return { ok: false, refusal: headerMismatch('MCP-Protocol-Version header missing') };
  }
  if (header !== metaVersion) {
    return {
      ok: false,
      refusal: headerMismatch(`MCP-Protocol-Version '${bound(header)}' does not match _meta '${bound(metaVersion)}'`),
    };
  }
  // Header and `_meta` agree on a legacy version: the client added a `_meta`
  // the older revision ignores — serve it as before.
  if ((LEGACY_VERSIONS as readonly string[]).includes(metaVersion)) {
    return { ok: true, generation: 'legacy', version: metaVersion };
  }
  // Here `metaVersion` is necessarily 2026-07-28: the header, equal to
  // `_meta`, passed checkVersionHeader before auth (route, step 2), and legacy
  // versions are handled just above.
  const capabilities = meta?.[META_CLIENT_CAPABILITIES];
  if (typeof capabilities !== 'object' || capabilities === null) {
    return {
      ok: false,
      refusal: { status: 400, code: CODE_INVALID_PARAMS, message: `Invalid params: _meta["${META_CLIENT_CAPABILITIES}"] required` },
    };
  }
  return { ok: true, generation: 'modern', version: MODERN_VERSION };
}

/** Methods whose `Mcp-Name` mirrors a body field (transport §Standard Request Headers). */
const MCP_NAME_SOURCE: Record<string, 'name' | 'uri'> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
};

const BASE64_SENTINEL = /^=\?base64\?(.*)\?=$/;
const BASE64_ALPHABET = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decodes the `=?base64?…?=` form of a header value (transport §Value
 * Encoding). Returns null when the encoding is invalid: `Buffer.from(…,
 * 'base64')` silently skips characters outside the alphabet (`c21x!!aV9…`
 * would decode like `c21xaV9…`), so the strict alphabet is required, then
 * re-encoding the decoded text must give back the received value (invalid
 * UTF-8, non-zero padding bits…). Trailing `=` is optional.
 */
export function decodeHeaderValue(value: string): string | null {
  const m = value.match(BASE64_SENTINEL);
  if (!m) return value;
  const payload = m[1];
  if (!BASE64_ALPHABET.test(payload)) return null;
  const text = Buffer.from(payload, 'base64').toString('utf8');
  const unpadded = (b64: string) => b64.replace(/=+$/, '');
  return unpadded(Buffer.from(text, 'utf8').toString('base64')) === unpadded(payload) ? text : null;
}

/**
 * Validates `Mcp-Method` and `Mcp-Name` against the body of a modern request.
 * A mismatch is refused (-32020): an intermediary routing or rate-limiting on
 * the header must not see something other than what the gateway executes.
 */
export function checkStandardHeaders(headers: Headers, method: string, params: unknown): ProtocolRefusal | null {
  const methodHeader = headers.get('mcp-method');
  if (methodHeader === null) return headerMismatch('Mcp-Method header required');
  if (methodHeader !== method) {
    return headerMismatch(`Mcp-Method '${bound(methodHeader)}' does not match the body method '${bound(method)}'`);
  }

  const field = MCP_NAME_SOURCE[method];
  if (!field) return null;
  const bodyValue = typeof params === 'object' && params !== null ? (params as Record<string, unknown>)[field] : undefined;
  const nameHeader = headers.get('mcp-name');
  // Body without the field: the handler answers "Invalid params".
  if (typeof bodyValue !== 'string') {
    return nameHeader === null ? null : headerMismatch(`Mcp-Name present without params.${field} in the body`);
  }
  if (nameHeader === null) return headerMismatch(`Mcp-Name header required for ${method}`);
  const name = decodeHeaderValue(nameHeader);
  if (name === null) return headerMismatch('Mcp-Name: invalid base64 encoding');
  if (name !== bodyValue) {
    return headerMismatch(`Mcp-Name '${bound(name)}' does not match params.${field} '${bound(bodyValue)}'`);
  }
  return null;
}

/**
 * Cache hints (server/utilities/caching) for the results that carry them.
 *
 * - `private` whenever the result depends on the caller: `tools/list`,
 *   `prompts/list` and `resources/templates/list` are filtered by the token's
 *   OAuth scopes, and `tools/list` also by `X-Cortex-Backends` and the
 *   `search` mode. A cache shared across tokens would show one caller the
 *   tools of another.
 * - `public` for what is identical for everyone:
 *   `resources/list` (the static architecture URI). `server/discover` is
 *   private: its instructions name the backends the caller holds a scope on.
 * - `resources/read`: `ttlMs: 0`, the content is computed on every read (the
 *   architecture document names the caller and the backends' state).
 *
 * List freshness = the federated catalog refresh interval: a modern client
 * does not receive `list_changed` (no `subscriptions/listen`), so the TTL is
 * its only signal.
 */
const CACHE_HINTS: Record<string, { ttlMs: number; cacheScope: 'public' | 'private' }> = {
  'server/discover': { ttlMs: REFRESH_INTERVAL_MS, cacheScope: 'private' },
  'tools/list': { ttlMs: REFRESH_INTERVAL_MS, cacheScope: 'private' },
  'prompts/list': { ttlMs: REFRESH_INTERVAL_MS, cacheScope: 'private' },
  'resources/templates/list': { ttlMs: REFRESH_INTERVAL_MS, cacheScope: 'private' },
  'resources/list': { ttlMs: REFRESH_INTERVAL_MS, cacheScope: 'public' },
  'resources/read': { ttlMs: 0, cacheScope: 'private' },
};

/**
 * Wraps a result for a 2026-07-28 client: `resultType: "complete"`, server
 * identity in `_meta` (merged with an existing `_meta`) and, for the relevant
 * methods, `ttlMs` + `cacheScope`.
 */
export function wrapModernResult(
  method: string,
  result: unknown,
  serverInfo: { name: string; version: string },
): Record<string, unknown> {
  const base = typeof result === 'object' && result !== null && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : {};
  const existingMeta = typeof base._meta === 'object' && base._meta !== null
    ? (base._meta as Record<string, unknown>)
    : {};
  return {
    ...base,
    resultType: 'complete',
    ...(CACHE_HINTS[method] ?? {}),
    _meta: { ...existingMeta, [META_SERVER_INFO]: serverInfo },
  };
}
