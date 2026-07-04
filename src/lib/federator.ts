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
import { loadBackends } from './registry';
import { broadcast } from './event-bus';

const REFRESH_INTERVAL_MS = 60_000;

export interface FederatedPromptEntry {
  app: BackendApp;
  prompt: CortexBackendPrompt;
}

export interface FederatedResourceTemplateEntry {
  app: BackendApp;
  template: CortexBackendResourceTemplate;
  /** Scheme extracted from uriTemplate (e.g. 'docs' for 'docs://document/{id}'). */
  scheme: string;
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
        for (const prompt of r.value.promptsRes.prompts ?? []) {
          if (newPrompts.has(prompt.name)) {
            // eslint-disable-next-line no-console
            console.warn('[cortex/federator] prompt name collision', {
              prompt: prompt.name,
              apps: [newPrompts.get(prompt.name)!.app.id, app.id],
            });
            continue;
          }
          newPrompts.set(prompt.name, { app, prompt });
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
          newTemplates.push({ app, template, scheme });
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

    // Change detection for SSE push (tools/list_changed)
    const previousNames = new Set(catalog.tools.keys());
    const currentNames = new Set(newTools.keys());
    const toolsChanged =
      previousNames.size !== currentNames.size ||
      Array.from(currentNames).some((n) => !previousNames.has(n));

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
  try {
    const m = uri.match(/^([a-z][a-z0-9+.-]*):\/\//i);
    if (!m) return null;
    const scheme = m[1].toLowerCase();
    const entry = resourceTemplatesCatalog.find((e) => e.scheme === scheme);
    return entry?.app ?? null;
  } catch {
    return null;
  }
}
