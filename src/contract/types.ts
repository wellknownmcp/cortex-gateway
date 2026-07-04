/**
 * Shared types for the Cortex backend contract.
 *
 * This module contains NO business logic. It defines the exchange contract
 * between the gateway (a spec-compliant MCP server) and the backend apps it
 * federates. Backends are plain HTTP services that expose a single POST
 * endpoint speaking a simplified JSON-RPC dialect (see docs/backend-contract.md).
 */

/**
 * A tool declared by a Cortex backend.
 *
 * Shape returned by each backend's `list_tools` method.
 */
export interface CortexBackendTool {
  /**
   * Tool name, unique within the backend (e.g. 'search_documents', 'get_help').
   * The gateway prefixes it with `<backendId>_` on the agent side, so names
   * only need to be unique per backend.
   */
  name: string;
  /**
   * OAuth scope required to call this tool (e.g. 'mcp:quality:read').
   * The gateway filters `tools/list` so callers only see tools their token
   * scopes allow.
   */
  scope: string;
  /**
   * Short description shown in the MCP `tools/list` response.
   * Written for an LLM audience (imperative, concise).
   */
  description: string;
  /**
   * Parameter schema in simplified notation.
   *
   * Format:
   * - `'<type>'`  required parameter
   * - `'<type>?'` optional parameter
   *
   * Supported types: `string`, `number`, `boolean` and their array forms
   * (`string[]`, `number[]`, `boolean[]`).
   *
   * Example: `{ query: 'string', status: 'string?', limit: 'number?' }`
   *
   * For richer schemas (enum, oneOf, per-param descriptions) a backend can
   * provide `inputSchema` (standard JSON Schema) instead.
   */
  params?: Record<string, string>;
  /**
   * Semver of this tool's contract (e.g. '1.0.0', '2.1.0').
   * Major bump = breaking change on params/return shape. Minor = additive.
   * Tools without a version are treated as '1.0.0'.
   */
  version?: string;
  /**
   * Deprecation marker. When present, indicates the ISO 8601 date after which
   * the tool will be removed. The gateway propagates this in `tools/list` so
   * agents can migrate to the replacement.
   *
   * Example: { removedAt: '2027-01-01', replacedBy: 'search_documents_v2', reason: '...' }
   */
  deprecated?: {
    removedAt: string;
    replacedBy?: string;
    reason?: string;
  };
  /**
   * Standard MCP JSON Schema escape hatch. When a backend provides
   * `inputSchema` (instead of, or in addition to, the simplified `params`
   * format), the gateway propagates it VERBATIM to the agent — enabling enum,
   * per-param descriptions, oneOf, etc. that `params` cannot express. The
   * gateway prefers `inputSchema` when present and falls back to converting
   * `params` otherwise. (In `search` tool mode the schema stays minimal
   * either way.)
   */
  inputSchema?: Record<string, unknown>;
}

/** Response of a backend's `list_tools` method. */
export interface CortexBackendCatalog {
  tools: CortexBackendTool[];
}

// ─── Snapshot (cross-backend convention) ─────────────────────────────────

/**
 * One snapshot metric — a scalar rendered generically by a dashboard.
 *
 * Convention: every backend that exposes `get_help` SHOULD also expose
 * `get_snapshot`. A dashboard can federate `*_get_snapshot` calls with zero
 * domain knowledge — it just renders the envelope.
 */
export interface SnapshotMetric {
  /** Stable key (e.g. 'active_users', 'documents_pending_review'). */
  key: string;
  /** Human-readable label. */
  label: string;
  /** Value (number for a KPI, string for a state label). */
  value: number | string;
  /** Optional unit ('%', 'days', '€'...). */
  unit?: string;
  /** Delta vs a reference period (null when not computable / not relevant). */
  delta?: number | null;
  /** Signal health — dashboards color accordingly. */
  status?: 'green' | 'orange' | 'red' | null;
  /** Drill-down link into the backend app (absolute or relative URL). */
  href?: string;
}

/**
 * Standard envelope returned by a backend's `get_snapshot` method.
 * Uniform shape → generic rendering. The backend fills in ITS OWN KPIs.
 *
 * Contract requirement: `get_snapshot` MUST return aggregates only — no
 * per-user or otherwise identifying data (see static-token.ts).
 */
export interface CortexBackendSnapshot {
  /** Backend identifier ('billing', 'docs'...). */
  backend: string;
  /** ISO timestamp of generation. */
  generatedAt: string;
  /** Human title for the dashboard tile. */
  title: string;
  /** Headline KPIs, rendered as cards. */
  headline: SnapshotMetric[];
  /** Optional detail, grouped in sections. */
  sections?: { title: string; metrics: SnapshotMetric[] }[];
  /** Context note / methodological caveat. */
  hint?: string;
}

// ─── Prompts (MCP spec primitive) ─────────────────────────────────────────

/** Prompt template argument — aligned with MCP spec 2025-06-18 §Prompts. */
export interface CortexBackendPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

/**
 * A prompt template declared by a Cortex backend.
 *
 * Prompts are reusable templates that agents can list (`prompts/list`) then
 * instantiate (`prompts/get` with arguments), receiving a pre-formatted
 * conversation to inject.
 */
export interface CortexBackendPrompt {
  /** Identifier, unique within this backend (e.g. 'draft_procedure'). */
  name: string;
  /** Concise description for the agent. */
  description: string;
  /** Arguments expected at instantiation. */
  arguments?: CortexBackendPromptArgument[];
  /** OAuth scope required. */
  scope: string;
}

/** Response of a backend's `list_prompts` method. */
export interface CortexBackendPromptCatalog {
  prompts: CortexBackendPrompt[];
}

/** One message of a materialized prompt. */
export interface CortexPromptMessage {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string };
}

/** Response of a backend's `get_prompt` method. */
export interface CortexBackendPromptInstance {
  description?: string;
  messages: CortexPromptMessage[];
}

// ─── Resources (MCP spec primitive) ───────────────────────────────────────

/**
 * Resource URI template (MCP spec `resources/templates/list`).
 *
 * Lets a backend declare a pattern (`docs://document/{id}`) rather than an
 * exhaustive list — useful when the resource space is too large to enumerate.
 */
export interface CortexBackendResourceTemplate {
  /** RFC 6570 URI template (e.g. 'docs://document/{id}'). */
  uriTemplate: string;
  /** Human-readable name. */
  name: string;
  /** Description. */
  description?: string;
  /** MIME type of contents reachable through this template. */
  mimeType?: string;
  /** OAuth scope required to read through this template. */
  scope: string;
}

/** Response of `list_resource_templates`. */
export interface CortexBackendResourceTemplatesCatalog {
  resourceTemplates: CortexBackendResourceTemplate[];
}

/** URI schemes owned by a backend (e.g. 'docs' for 'docs://'). */
export interface CortexBackendUriSchemes {
  /** URI schemes this backend can resolve through `read_resource`. */
  uriSchemes: string[];
}

/** Resource content returned by `read_resource`. */
export interface CortexResourceContent {
  uri: string;
  mimeType: string;
  /** Raw text when the mime type is textual. */
  text?: string;
  /** Base64 otherwise. */
  blob?: string;
}

/** Response of `read_resource`. */
export interface CortexBackendResourceRead {
  contents: CortexResourceContent[];
}

/** Simplified JSON-RPC request sent to a Cortex backend. */
export interface CortexRpcRequest {
  method: string;
  params?: Record<string, unknown>;
}

/**
 * User context propagated by the gateway to backends as HTTP headers.
 *
 * Backends use it for fine-grained authorization (e.g. app-level roles)
 * after validating the OAuth JWT themselves. The pattern: OAuth scope is the
 * front door, application role filters the content.
 */
export interface CortexUserContext {
  /** User identifier at the identity provider (JWT `sub`). */
  userId: string;
  email: string;
  /** Application role claim, if your IdP issues one. Empty string otherwise. */
  role: string;
  /** Token pool/realm claim, if your IdP segments audiences. Empty otherwise. */
  pool: string;
  /** Scopes granted by the token — useful for backend-side logging. */
  scopes: string[];
}

/**
 * HTTP header names used to propagate the user context.
 *
 * The gateway sets them; each backend reads them after verifying the
 * Authorization Bearer.
 */
export const CORTEX_HEADERS = {
  userId: 'X-Cortex-User-Id',
  email: 'X-Cortex-User-Email',
  role: 'X-Cortex-User-Role',
  pool: 'X-Cortex-User-Pool',
  scopes: 'X-Cortex-Scopes',
} as const;

// ─── Federation registry types ─────────────────────────────────────────────

/** Configuration of one federated backend app. */
export interface BackendApp {
  /** Short unique identifier (e.g. 'docs', 'billing'). Used as tool prefix. */
  id: string;
  /**
   * Base URL of the backend server (e.g. `http://127.0.0.1:3212`).
   * In production, prefer loopback/private-network URLs behind your proxy.
   */
  baseUrl: string;
  /**
   * Path of the backend endpoint (default `/api/cortex/backend`).
   * POST JSON-RPC, accepts `Authorization: Bearer` + `X-Cortex-*` headers.
   */
  backendPath: string;
  /** Timeout in ms for JSON-RPC calls to this backend. Default: 10000. */
  timeoutMs?: number;
}

/** Federated catalog entry: a tool and the app that owns it. */
export interface FederatedToolEntry {
  app: BackendApp;
  tool: CortexBackendTool;
}

/**
 * Snapshot of the federated catalog maintained by the gateway. Refreshed
 * periodically (60s by default) by calling `list_tools` on each backend.
 */
export interface FederatedCatalog {
  /** Federated tools, indexed by (prefixed) name. */
  tools: Map<string, FederatedToolEntry>;
  /** Timestamp of the last successful refresh. */
  lastRefreshedAt: Date;
  /** Apps reachable at the last refresh. */
  healthyApps: readonly string[];
  /** Apps unreachable — their tools are absent from the catalog until the next successful refresh. */
  unreachableApps: readonly string[];
}
