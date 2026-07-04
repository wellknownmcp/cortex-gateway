/**
 * OAuth 2.1 client registration & lookup (RFC 7591 Dynamic Client Registration).
 *
 * Public clients only (PKCE-mandatory, no client_secret) — matches Claude
 * Desktop / claude.ai / Cursor. DCR is open with rate limiting: acceptable
 * for this demo server because the protected tools are harmless and
 * per-user-consented; a production deployment should default to
 * moderationStatus 'pending' + disabled and add an admin approval step.
 */

import { prisma } from '../prisma';
import { randomBase64url } from './crypto';
import { ALL_SCOPES, filterValidScopes } from './scopes';

export interface DcrInput {
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
  redirect_uris?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  scope?: string;
  token_endpoint_auth_method?: string;
  software_id?: string;
  software_version?: string;
}

export interface DcrValidationError {
  error: string;
  error_description: string;
}

export interface DcrValidResult {
  clientName: string;
  clientUri: string | null;
  logoUri: string | null;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  scopesAllowed: string[];
  tokenEndpointAuthMethod: string;
  softwareId: string | null;
  softwareVersion: string | null;
}

const ALLOWED_GRANT_TYPES = ['authorization_code', 'refresh_token'];
const ALLOWED_RESPONSE_TYPES = ['code'];

/** Validates a DCR payload per RFC 7591 + OAuth 2.1 strictness. */
export function validateDcrPayload(input: DcrInput): DcrValidResult | DcrValidationError {
  const clientName = typeof input.client_name === 'string' ? input.client_name.trim() : '';
  if (!clientName || clientName.length > 200) {
    return { error: 'invalid_client_metadata', error_description: 'client_name is required (1-200 chars)' };
  }

  if (!Array.isArray(input.redirect_uris) || input.redirect_uris.length === 0) {
    return { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be a non-empty array' };
  }
  const redirectUris: string[] = [];
  for (const raw of input.redirect_uris) {
    if (typeof raw !== 'string') {
      return { error: 'invalid_redirect_uri', error_description: 'each redirect_uri must be a string' };
    }
    const trimmed = raw.trim();
    if (!isValidRedirectUri(trimmed)) {
      return {
        error: 'invalid_redirect_uri',
        error_description: `redirect_uri must be HTTPS or http://localhost (got: ${trimmed})`,
      };
    }
    if (trimmed.length > 2000) {
      return { error: 'invalid_redirect_uri', error_description: 'redirect_uri too long' };
    }
    redirectUris.push(trimmed);
  }

  const grantTypes: string[] = [];
  const gtRaw = Array.isArray(input.grant_types) ? input.grant_types : ALLOWED_GRANT_TYPES;
  for (const g of gtRaw) {
    if (typeof g !== 'string' || !ALLOWED_GRANT_TYPES.includes(g)) {
      return {
        error: 'invalid_client_metadata',
        error_description: `grant_type "${g}" not supported (only ${ALLOWED_GRANT_TYPES.join(', ')})`,
      };
    }
    if (!grantTypes.includes(g)) grantTypes.push(g);
  }
  if (grantTypes.length === 0) grantTypes.push('authorization_code');

  const responseTypes: string[] = [];
  const rtRaw = Array.isArray(input.response_types) ? input.response_types : ALLOWED_RESPONSE_TYPES;
  for (const r of rtRaw) {
    if (typeof r !== 'string' || !ALLOWED_RESPONSE_TYPES.includes(r)) {
      return { error: 'invalid_client_metadata', error_description: 'only response_type "code" is supported' };
    }
    if (!responseTypes.includes(r)) responseTypes.push(r);
  }
  if (responseTypes.length === 0) responseTypes.push('code');

  const tokenAuthMethod =
    typeof input.token_endpoint_auth_method === 'string' ? input.token_endpoint_auth_method : 'none';
  if (tokenAuthMethod !== 'none') {
    return {
      error: 'invalid_client_metadata',
      error_description: 'only token_endpoint_auth_method "none" is supported (public clients with PKCE)',
    };
  }

  const requestedScopes = typeof input.scope === 'string' ? input.scope.split(/\s+/).filter(Boolean) : [];
  const scopesAllowed = requestedScopes.length > 0 ? filterValidScopes(requestedScopes) : ALL_SCOPES;

  const clientUri = typeof input.client_uri === 'string' && input.client_uri.length <= 500 ? input.client_uri : null;
  const logoUri = typeof input.logo_uri === 'string' && input.logo_uri.length <= 500 ? input.logo_uri : null;
  const softwareId =
    typeof input.software_id === 'string' && input.software_id.length <= 100 ? input.software_id : null;
  const softwareVersion =
    typeof input.software_version === 'string' && input.software_version.length <= 50 ? input.software_version : null;

  return {
    clientName,
    clientUri,
    logoUri,
    redirectUris,
    grantTypes,
    responseTypes,
    scopesAllowed,
    tokenEndpointAuthMethod: tokenAuthMethod,
    softwareId,
    softwareVersion,
  };
}

/**
 * RFC 7591 redirect_uri validation: absolute URL, HTTPS (or http://localhost
 * for native-app dev), no fragment, exact match enforced at token exchange.
 */
export function isValidRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.hash) return false;
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')) {
    return true;
  }
  return false;
}

/** Creates the OauthClient row for a freshly DCR-registered client. */
export async function createDcrClient(validated: DcrValidResult) {
  const clientId = `cortex-demo-${randomBase64url(12)}`;
  return prisma.oauthClient.create({
    data: {
      clientId,
      clientName: validated.clientName,
      clientUri: validated.clientUri,
      logoUri: validated.logoUri,
      clientType: 'public',
      redirectUris: validated.redirectUris,
      grantTypes: validated.grantTypes,
      responseTypes: validated.responseTypes,
      scopesAllowed: validated.scopesAllowed,
      tokenEndpointAuthMethod: validated.tokenEndpointAuthMethod,
      softwareId: validated.softwareId,
      softwareVersion: validated.softwareVersion,
      registeredBy: 'dcr',
      moderationStatus: 'approved', // demo server: open DCR + rate limit
    },
  });
}

/** Lookup by public client_id; null when unknown, disabled or rejected. */
export async function getClientByPublicId(clientId: string) {
  const client = await prisma.oauthClient.findUnique({ where: { clientId } });
  if (!client) return null;
  if (client.disabled) return null;
  if (client.moderationStatus === 'rejected') return null;
  return client;
}

/** Exact-match redirect_uri check — never wildcards (OAuth 2.1 strictness). */
export function clientHasRedirectUri(client: { redirectUris: string[] }, redirectUri: string): boolean {
  return client.redirectUris.includes(redirectUri);
}
