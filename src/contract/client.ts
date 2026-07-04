/**
 * JSON-RPC client used by the gateway to call a Cortex backend.
 *
 * Typed errors:
 *   - 401 → {@link CortexBackendUnauthorized}
 *   - 403 with body.required → {@link CortexBackendInsufficientScope} (missing OAuth scope)
 *   - 403 without body.required → {@link CortexBackendAclDenied} (application ACL: the caller
 *     has the scope but lacks the required role/membership)
 *   - anything else → {@link CortexBackendError}
 */

import { CORTEX_HEADERS } from './types';
import type { CortexUserContext, CortexRpcRequest } from './types';

// ─── Typed errors ─────────────────────────────────────────────────────────

export class CortexBackendError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'CortexBackendError';
  }
}

export class CortexBackendUnauthorized extends CortexBackendError {
  constructor(body: unknown) {
    super('Backend rejected authentication (401)', 401, body);
    this.name = 'CortexBackendUnauthorized';
  }
}

export class CortexBackendInsufficientScope extends CortexBackendError {
  constructor(
    public readonly requiredScope: string | undefined,
    public readonly method: string | undefined,
    body: unknown,
  ) {
    super(
      `Insufficient scope for ${method ?? 'unknown method'} (required: ${requiredScope ?? 'n/a'})`,
      403,
      body,
    );
    this.name = 'CortexBackendInsufficientScope';
  }
}

/**
 * 403 returned by a backend for an application-level ACL reason (missing
 * workspace membership, insufficient role, resource not visible to the
 * caller) — NOT a missing OAuth scope. Discriminated on the absence of the
 * `required` field in the 403 response body.
 *
 * Without this discrimination every backend 403 surfaces to the agent as
 * "insufficient scope", which is misleading when the caller has the scope
 * but a domain handler refused for role/membership reasons.
 */
export class CortexBackendAclDenied extends CortexBackendError {
  constructor(
    public readonly reason: string | undefined,
    body: unknown,
  ) {
    super(
      reason ? `ACL denied: ${reason}` : 'ACL denied (403 without `required`)',
      403,
      body,
    );
    this.name = 'CortexBackendAclDenied';
  }
}

export class CortexBackendTimeout extends CortexBackendError {
  constructor(url: string, timeoutMs: number) {
    super(`Backend timed out after ${timeoutMs}ms (${url})`, 0, null);
    this.name = 'CortexBackendTimeout';
  }
}

// ─── Options + main function ──────────────────────────────────────────────

export interface CallBackendOptions {
  /** Base URL of the backend app (e.g. `http://127.0.0.1:3212`). */
  baseUrl: string;
  /** Path of the backend endpoint (e.g. `/api/cortex/backend`). */
  backendPath: string;
  /** Method name (e.g. `list_tools`, `search_documents`). */
  method: string;
  /** Method parameters. */
  params?: Record<string, unknown>;
  /**
   * Bearer token sent to the backend.
   *
   * For user calls: the end user's OAuth JWT, which the backend re-validates
   * with its own resource verifier.
   *
   * For catalog discovery: the static technical token (see static-token.ts).
   */
  bearerToken: string;
  /**
   * User context propagated as `X-Cortex-*` headers. Lets the backend apply
   * fine-grained authorization (e.g. app roles) without re-parsing the JWT.
   */
  userContext?: CortexUserContext;
  /** Network timeout in ms. Default: 10000. */
  timeoutMs?: number;
}

/**
 * Calls a Cortex backend using the simplified JSON-RPC contract.
 *
 * @throws {CortexBackendUnauthorized} when the backend returns 401
 * @throws {CortexBackendInsufficientScope} when the backend returns 403 with `required`
 * @throws {CortexBackendAclDenied} when the backend returns 403 without `required`
 * @throws {CortexBackendTimeout} when the timeout is reached
 * @throws {CortexBackendError} for any other HTTP error (400, 500, ...)
 */
export async function callBackend<T = unknown>(opts: CallBackendOptions): Promise<T> {
  const {
    baseUrl,
    backendPath,
    method,
    params = {},
    bearerToken,
    userContext,
    timeoutMs = 10_000,
  } = opts;

  const body: CortexRpcRequest = { method, params };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${bearerToken}`,
  };

  if (userContext) {
    headers[CORTEX_HEADERS.userId] = userContext.userId;
    headers[CORTEX_HEADERS.email] = userContext.email;
    headers[CORTEX_HEADERS.role] = userContext.role;
    headers[CORTEX_HEADERS.pool] = userContext.pool;
    headers[CORTEX_HEADERS.scopes] = userContext.scopes.join(' ');
  }

  const url = `${baseUrl}${backendPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new CortexBackendTimeout(url, timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const contentType = res.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json')
    ? await res.json().catch(() => null)
    : null;

  if (res.status === 401) {
    throw new CortexBackendUnauthorized(payload);
  }
  if (res.status === 403) {
    const body403 = (payload ?? {}) as { required?: string; method?: string; error?: string };
    // Discriminates a missing OAuth scope (body.required present, set by the
    // backend's auth layer) from an application 403 (ACL role/membership,
    // set by a domain handler).
    if (body403.required) {
      throw new CortexBackendInsufficientScope(body403.required, body403.method, payload);
    }
    throw new CortexBackendAclDenied(body403.error, payload);
  }
  if (!res.ok) {
    throw new CortexBackendError(`Backend ${res.status}`, res.status, payload);
  }

  return payload as T;
}
