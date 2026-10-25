/**
 * Federated tool catalog — periodic refresh by calling `list_tools` on every
 * registered backend.
 *
 * The cache lives in the process, shared across requests. If the process
 * restarts, the catalog is rebuilt at the first refresh.
 */

import { callBackend, CortexBackendError } from '@/contract';
import type {
  BackendApp,
  CortexBackendCatalog,
  CortexBackendPrompt,
  CortexBackendPromptCatalog,
  CortexBackendResourceTemplate,
  CortexBackendResourceTemplatesCatalog,
  FederatedCatalog,
  FederatedToolEntry,
} from '@/contract';
import { isScopeAllowedFor, loadBackends, RESERVED_URI_SCHEMES, uriSchemesOf } from './registry';
import { broadcast } from './event-bus';
import { reviewCatalog } from './tool-integrity';

/**
 * Catalog refresh period. Exported: it is also the freshness (`ttlMs`)
 * announced to MCP 2026-07-28 clients on list results (lib/mcp-generation.ts).
 */
export const REFRESH_INTERVAL_MS = 60_000;

export interface FederatedPromptEntry {
  app: BackendApp;
  /** The prompt as served to agents: `name` is prefixed (`<app>_<name>`). */
  prompt: CortexBackendPrompt;
  /** Name the backend knows the prompt by, sent back on `get_prompt`. */
  originalName: string;
}

export interface FederatedResourceTemplateEntry {
  app: BackendApp;
  template: CortexBackendResourceTemplate;
  /** Scheme extracted from uriTemplate (e.g. 'docs' for 'docs://document/{id}'). */
  scheme: string;
  /** Anchored matcher compiled from uriTemplate (see compileUriTemplate). */
  matcher: RegExp;
}

function rejectDeclaration(app: BackendApp, kind: string, name: string, scope: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[cortex/federator] ${kind} rejected: scope outside the backend's prefixes`, {
    app: app.id,
    name,
    scope,
  });
}

let catalog: FederatedCatalog = {
  tools: new Map(),
  lastRefreshedAt: new Date(0),
  healthyApps: [],
  unreachableApps: [],
};

let promptCatalog = new Map<string, FederatedPromptEntry>();
let resourceTemplatesCatalog: FederatedResourceTemplateEntry[] = [];

/**
 * Map from prefixed aliases to original tool names.
 * The federator exposes every federated tool as `<app>_<name>` on the agent
 * side (e.g. `docs_get_help`); the backend dispatch needs the original name
 * (`get_help`) — that is this map's job.
 */
let aliasToOriginal = new Map<string, string>();

let refreshTimer: NodeJS.Timeout | null = null;
let refreshing = false;

function schemeOf(uriTemplate: string): string | null {
  const m = uriTemplate.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  return m ? m[1].toLowerCase() : null;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compiles an RFC 6570 URI template into an anchored matcher. Only the shapes
 * a resource template uses are distinguished: `{var}` is one path segment,
 * `{+var}` spans segments, `{?…}` / `{&…}` a query string, `{#…}` a fragment,
 * `{/…}` and `{.…}` repeated segments. Matching is for authorization — which
 * template, hence which scope, a URI falls under — not for extraction.
 */
export function compileUriTemplate(uriTemplate: string): RegExp {
  let pattern = '';
  let last = 0;
  for (const m of uriTemplate.matchAll(/\{([+#./;?&]?)[^}]*\}/g)) {
    pattern += escapeRegExp(uriTemplate.slice(last, m.index));
    switch (m[1]) {
      case '+': pattern += '.+'; break;
      case '#': pattern += '(?:#.*)?'; break;
      case '?':
      case '&': pattern += '(?:[?&][^#]*)?'; break;
      case '/': pattern += '(?:/[^/?#]+)*'; break;
      case '.': pattern += '(?:\\.[^/?#.]+)*'; break;
      case ';': pattern += '(?:;[^/?#]*)*'; break;
      default: pattern += '[^/?#]+';
    }
    last = (m.index ?? 0) + m[0].length;
  }
  pattern += escapeRegExp(uriTemplate.slice(last));
  // Case-sensitive: backends usually are, and a case-insensitive match would
  // let `docs://ADMIN/1` fall under a template the backend never meant. Only
  // the scheme is normalized (lowercased on both sides, RFC 3986 §3.1).
  return new RegExp(`^${pattern.replace(/^[a-z][a-z0-9+.-]*/i, (s) => s.toLowerCase())}$`);
}

/**
 * URIs refused before any template matching: dot segments and percent-encoded
 * `/`, `.` or `%` can be resolved by the backend into a path the template
 * matcher never saw (`docs://doc/..%2Fadmin/1`).
 */
const AMBIGUOUS_URI = /(?:^|\/)\.\.?(?:\/|$)|%(?:2f|2e|5c|25)/i;

/**
 * Returns the current snapshot of the federated catalog.
 * Triggers a background refresh when stale (>60s) or never refreshed.
 */
export function getCatalog(): FederatedCatalog {
  const ageMs = Date.now() - catalog.lastRefreshedAt.getTime();
  if (ageMs > REFRESH_INTERVAL_MS && !refreshing) {
    void refreshCatalog();
  }
  return catalog;
}

/**
 * Forces a full refresh, querying every backend in parallel.
 * A backend that is down loses its tools in the catalog (failure isolation)
 * without affecting the others.
 */
export async function refreshCatalog(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const backends = loadBackends();
    const results = await Promise.allSettled(
      backends.map(async (app) => {
        // Catalog discovery uses the static technical token: backends accept
        // it exclusively for the read-only catalog methods (see
        // contract/static-token.ts). A dedicated machine identity
        // (client_credentials flow) can replace it later.
        const technicalToken = process.env.CORTEX_TECHNICAL_TOKEN ?? '';
        if (!technicalToken) {
          throw new Error('CORTEX_TECHNICAL_TOKEN missing — required for cross-backend list_tools');
        }
        // list_tools (mandatory) + list_prompts + list_resource_templates
        // (optional: tolerate 400 "unknown method" from backends that do not
        // expose prompts/resources yet).
        const toolsRes = await callBackend<CortexBackendCatalog>({
          baseUrl: app.baseUrl,
          backendPath: app.backendPath,
          method: 'list_tools',
          bearerToken: technicalToken,
          timeoutMs: app.timeoutMs ?? 10_000,
        });
        const promptsRes = await callBackend<CortexBackendPromptCatalog>({
          baseUrl: app.baseUrl,
          backendPath: app.backendPath,
          method: 'list_prompts',
          bearerToken: technicalToken,
          timeoutMs: app.timeoutMs ?? 10_000,
        }).catch(() => ({ prompts: [] }) as CortexBackendPromptCatalog);
        const templatesRes = await callBackend<CortexBackendResourceTemplatesCatalog>({
          baseUrl: app.baseUrl,
          backendPath: app.backendPath,
          method: 'list_resource_templates',
          bearerToken: technicalToken,
          timeoutMs: app.timeoutMs ?? 10_000,
        }).catch(() => ({ resourceTemplates: [] }) as CortexBackendResourceTemplatesCatalog);
        return { app, toolsRes, promptsRes, templatesRes };
      }),
    );

    const newTools = new Map<string, FederatedToolEntry>();
    const newAliasToOriginal = new Map<string, string>();
    const newPrompts = new Map<string, FederatedPromptEntry>();
    const newTemplates: FederatedResourceTemplateEntry[] = [];
    const healthy: string[] = [];
    const unreachable: string[] = [];
    // Scheme → backend id, first claim wins (registry order). Operator config
    // can still give two backends the same scheme; the second is refused.
    const claimedSchemes = new Map<string, string>();

    // Naming convention: every federated tool is prefixed with its backend id
    // (`<app>_<originalName>`, e.g. `docs_list_files`). A uniform convention
    // is predictable and rules out collisions whatever happens (new backend,
    // accidental homonym tool...). The alias is preserved in aliasToOriginal
    // for the backend dispatch (handleToolsCall translates back through
    // getOriginalToolName).
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const app = backends[i];
      if (r.status === 'fulfilled') {
        healthy.push(app.id);
        for (const tool of r.value.toolsRes.tools ?? []) {
          // A backend may only gate its tools behind its own scopes. Without
          // this, a backend could declare `mcp:billing:write` (borrowing the
          // trust of another backend's grant) or the gateway floor scope
          // (making its tool visible to every token).
          if (!isScopeAllowedFor(app, tool.scope)) {
            rejectDeclaration(app, 'tool', tool.name, tool.scope);
            continue;
          }
          const finalName = `${app.id}_${tool.name}`;
          if (newTools.has(finalName)) {
            // Pathological case: the same app exposes the same tool twice.
            // eslint-disable-next-line no-console
            console.warn('[cortex/federator] duplicate within one app', {
              finalName,
              app: app.id,
            });
            continue;
          }
          newAliasToOriginal.set(finalName, tool.name);
          newTools.set(finalName, { app, tool: { ...tool, name: finalName } });
        }
        // Prompts follow the tool convention (`<app>_<name>`). Unprefixed, a
        // second backend declaring the same name was silently dropped, and
        // which one won depended on registry order.
        for (const prompt of r.value.promptsRes.prompts ?? []) {
          if (!isScopeAllowedFor(app, prompt.scope)) {
            rejectDeclaration(app, 'prompt', prompt.name, prompt.scope);
            continue;
          }
          const finalName = `${app.id}_${prompt.name}`;
          if (newPrompts.has(finalName)) {
            // eslint-disable-next-line no-console
            console.warn('[cortex/federator] duplicate prompt within one app', { finalName, app: app.id });
            continue;
          }
          newPrompts.set(finalName, { app, prompt: { ...prompt, name: finalName }, originalName: prompt.name });
        }
        for (const template of r.value.templatesRes.resourceTemplates ?? []) {
          const scheme = schemeOf(template.uriTemplate);
          if (!scheme) {
            // eslint-disable-next-line no-console
            console.warn('[cortex/federator] template without a valid scheme', {
              uriTemplate: template.uriTemplate,
              app: app.id,
            });
            continue;
          }
          // Reads are routed by scheme and carry the caller's token: a backend
          // claiming a scheme it does not own would receive tokens meant for
          // another backend's resources.
          const owner = claimedSchemes.get(scheme);
          if (
            RESERVED_URI_SCHEMES.has(scheme) ||
            !uriSchemesOf(app).includes(scheme) ||
            (owner !== undefined && owner !== app.id)
          ) {
            // eslint-disable-next-line no-console
            console.error('[cortex/federator] resource template rejected: scheme not owned by this backend', {
              app: app.id,
              scheme,
              allowed: uriSchemesOf(app),
              ...(owner !== undefined && owner !== app.id ? { claimedBy: owner } : {}),
            });
            continue;
          }
          if (!isScopeAllowedFor(app, template.scope)) {
            rejectDeclaration(app, 'resource template', template.uriTemplate, template.scope);
            continue;
          }
          claimedSchemes.set(scheme, app.id);
          newTemplates.push({ app, template, scheme, matcher: compileUriTemplate(template.uriTemplate) });
        }
      } else {
        unreachable.push(app.id);
        const reason = r.reason instanceof CortexBackendError
          ? `${r.reason.name}(${r.reason.status})`
          : r.reason instanceof Error
            ? r.reason.message
            : 'unknown';
        // eslint-disable-next-line no-console
        console.warn('[cortex/federator] backend unreachable', { app: app.id, reason });
      }
    }

    // Tool definition integrity — rug-pull detection.
    //
    // Runs BEFORE the catalog is published, so that in block mode a tool whose
    // description or schema changed after approval never reaches an agent.
    // Comparing names alone would miss exactly the attack this guards against:
    // same name, rewritten semantics.
    //
    // `healthy` matters: a backend that failed this cycle contributes no tools,
    // and must not have that read as "these tools were withdrawn" — otherwise
    // going briefly unreachable would launder a definition change into a fresh
    // approval.
    const integrity = reviewCatalog(newTools, healthy);
    for (const name of integrity.quarantined) {
      newTools.delete(name);
      newAliasToOriginal.delete(name);
    }

    // Change detection for SSE push (tools/list_changed). Driven by the
    // integrity diff, so a pure description/schema mutation also notifies —
    // clients that cache tool definitions must re-read them.
    const previousNames = new Set(catalog.tools.keys());
    const toolsChanged =
      integrity.added.length > 0 ||
      integrity.removed.length > 0 ||
      integrity.mutated.length > 0;

    // Change detection for prompts + templates
    const previousPromptNames = new Set(promptCatalog.keys());
    const currentPromptNames = new Set(newPrompts.keys());
    const promptsChanged =
      previousPromptNames.size !== currentPromptNames.size ||
      Array.from(currentPromptNames).some((n) => !previousPromptNames.has(n));

    const previousTemplates = resourceTemplatesCatalog.map((e) => e.template.uriTemplate).sort().join('|');
    const currentTemplates = newTemplates.map((e) => e.template.uriTemplate).sort().join('|');
    const templatesChanged = previousTemplates !== currentTemplates;

    catalog = {
      tools: newTools,
      lastRefreshedAt: new Date(),
      healthyApps: healthy,
      unreachableApps: unreachable,
    };
    promptCatalog = newPrompts;
    resourceTemplatesCatalog = newTemplates;
    aliasToOriginal = newAliasToOriginal;

    // eslint-disable-next-line no-console
    console.log('[cortex/federator] refreshed', {
      tools: newTools.size,
      prompts: newPrompts.size,
      templates: newTemplates.length,
      healthy: healthy.join(','),
      unreachable: unreachable.join(',') || 'none',
      changed: { tools: toolsChanged, prompts: promptsChanged, templates: templatesChanged },
      integrity: {
        added: integrity.added.length,
        removed: integrity.removed.length,
        mutated: integrity.mutated.length,
        quarantined: integrity.quarantined.length,
      },
    });

    if (toolsChanged && previousNames.size > 0) {
      broadcast({ method: 'notifications/tools/list_changed' });
    }
    if (promptsChanged && previousPromptNames.size > 0) {
      broadcast({ method: 'notifications/prompts/list_changed' });
    }
    if (templatesChanged && previousTemplates !== '') {
      broadcast({ method: 'notifications/resources/list_changed' });
    }
  } finally {
    refreshing = false;
  }
}

/** Starts the periodic background refresh (called at process boot). */
export function startPeriodicRefresh(): void {
  if (refreshTimer) return;
  // First refresh in the background, without blocking boot
  void refreshCatalog();
  refreshTimer = setInterval(() => {
    void refreshCatalog();
  }, REFRESH_INTERVAL_MS);
}

/** Returns the federated entry for a given tool name, or null. */
export function lookupTool(name: string): FederatedToolEntry | null {
  const current = getCatalog();
  return current.tools.get(name) ?? null;
}

/**
 * Returns the tool name to use as `method` on the backend side.
 * When the agent called a prefixed alias (`docs_get_help`), the backend
 * expects the original name (`get_help`). No-op for non-prefixed names.
 */
export function getOriginalToolName(aliasOrName: string): string {
  return aliasToOriginal.get(aliasOrName) ?? aliasOrName;
}

/** Lists the federated prompts currently cached. */
export function listPrompts(): FederatedPromptEntry[] {
  // Trigger a background refresh when stale — same pattern as getCatalog
  getCatalog();
  return Array.from(promptCatalog.values());
}

/** Finds the backend that exposes a given prompt. */
export function lookupPrompt(name: string): FederatedPromptEntry | null {
  return promptCatalog.get(name) ?? null;
}

/** Lists the federated resource templates. */
export function listResourceTemplates(): FederatedResourceTemplateEntry[] {
  getCatalog();
  return resourceTemplatesCatalog;
}

/** Finds the backend that owns a URI scheme (e.g. 'docs' → docs app). */
export function findBackendForUri(uri: string): BackendApp | null {
  const scheme = schemeOf(uri);
  if (!scheme) return null;
  const entry = resourceTemplatesCatalog.find((e) => e.scheme === scheme);
  return entry?.app ?? null;
}

/**
 * Resource templates a URI falls under, all owned by the backend of its
 * scheme. Empty when the scheme is unknown or no template matches: such a URI
 * is not readable, since the scope that gates it cannot be determined.
 */
export function matchResourceTemplates(uri: string): FederatedResourceTemplateEntry[] {
  const scheme = schemeOf(uri);
  if (!scheme || AMBIGUOUS_URI.test(uri.slice(scheme.length + 3))) return [];
  getCatalog();
  const normalized = scheme + uri.slice(scheme.length);
  return resourceTemplatesCatalog.filter((e) => e.scheme === scheme && e.matcher.test(normalized));
}

/**
 * Healthy backends on which the caller holds at least one declared scope
 * (tool, prompt or resource template). Fan-out builtins (`whoami`, ticket
 * listing) only reach these: forwarding the caller's token to a backend it
 * has no business with hands that backend a credential for nothing.
 */
export function backendsReachableBy(scopes: ReadonlySet<string>): BackendApp[] {
  const current = getCatalog();
  const healthy = new Set(current.healthyApps);
  const reachable = new Map<string, BackendApp>();
  const consider = (app: BackendApp, scope: string) => {
    if (healthy.has(app.id) && scopes.has(scope) && !reachable.has(app.id)) reachable.set(app.id, app);
  };
  for (const { app, tool } of current.tools.values()) consider(app, tool.scope);
  for (const { app, prompt } of promptCatalog.values()) consider(app, prompt.scope);
  for (const { app, template } of resourceTemplatesCatalog) consider(app, template.scope);
  return Array.from(reachable.values());
}
