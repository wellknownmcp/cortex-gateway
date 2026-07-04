/**
 * Scope of the static backend Bearer token.
 *
 * Each federated backend accepts a static Bearer token (`<APP>_BACKEND_TOKEN`
 * on the backend side, `CORTEX_TECHNICAL_TOKEN` on the gateway side) whose
 * ONLY legitimate use is the gateway's catalog refresh (federator.ts):
 * `list_tools` / `list_prompts` / `list_resource_templates`.
 *
 * This token is not an identity: it carries no email and no role, so no
 * business ACL can apply to it. Every data method MUST be refused with 403
 * when auth comes from the static token — data access goes exclusively
 * through a user OAuth JWT whose claims carry the rights.
 *
 * Full removal of static tokens is planned for when the authorization server
 * can issue a machine identity (client_credentials flow). Until then,
 * removing the token would freeze the gateway catalog.
 *
 * `get_snapshot` exception: a dashboard may federate `*_get_snapshot` with
 * the service token. This is admissible because `get_snapshot` is by
 * CONTRACT aggregated and non-identifying (CortexBackendSnapshot = scalar
 * counters): it has no per-user dimension, so no per-user ACL can apply to
 * it AND none is missing. It belongs to the discovery/health tier, not to
 * the nominative data tier.
 *
 * Guard rail: any backend implementing `get_snapshot` MUST return aggregates
 * only. Identifying data stays in dedicated data methods (`list_*`), which
 * remain refused to the static token.
 */
export const STATIC_TOKEN_METHODS: ReadonlySet<string> = new Set([
  'list_tools',
  'list_prompts',
  'list_resource_templates',
  'get_snapshot',
]);

export function isStaticTokenMethodAllowed(method: string): boolean {
  return STATIC_TOKEN_METHODS.has(method);
}
