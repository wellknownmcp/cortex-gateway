/**
 * GET /oauth/authorize — OAuth 2.1 authorization endpoint.
 *
 * Validates the request, signs a 5-min JWT carrying the validated params and
 * redirects to the consent screen (stateless — no in-flight request table).
 *
 * Error modes per OAuth 2.1 §4.1.2.1:
 *  - invalid client_id / redirect_uri → 400 JSON (NEVER redirect to an
 *    unverified redirect_uri)
 *  - other errors → redirect back to the registered redirect_uri with ?error=
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';
import { getClientByPublicId, clientHasRedirectUri } from '@/lib/oauth/client';
import { filterValidScopes, parseScopeString } from '@/lib/oauth/scopes';
import { signAuthorizeRequest } from '@/lib/oauth/authorize-request';
import { getIssuer } from '@/lib/oauth/keys';

export async function GET(request: NextRequest) {
  const rl = checkRateLimit('oauth-authorize', getClientIp(request), 20, 60_000);
  if (!rl.allowed) {
    return jsonError('temporarily_unavailable', 'Rate limit exceeded', 429);
  }

  const params = request.nextUrl.searchParams;
  const responseType = params.get('response_type');
  const clientIdParam = params.get('client_id');
  const redirectUri = params.get('redirect_uri');
  const scope = params.get('scope');
  const state = params.get('state') ?? undefined;
  const codeChallenge = params.get('code_challenge');
  const codeChallengeMethod = params.get('code_challenge_method');

  // Phase 1 — params whose failure must NOT redirect
  if (!clientIdParam) return jsonError('invalid_request', 'Missing client_id', 400);
  const client = await getClientByPublicId(clientIdParam);
  if (!client) return jsonError('invalid_client', 'Unknown or disabled client', 400);
  if (!redirectUri) return jsonError('invalid_request', 'Missing redirect_uri', 400);
  if (!clientHasRedirectUri(client, redirectUri)) {
    return jsonError('invalid_request', 'redirect_uri does not match registered URIs', 400);
  }

  // Phase 2 — errors redirect back to the (validated) client
  if (responseType !== 'code') {
    return redirectError(redirectUri, 'unsupported_response_type', state);
  }
  if (!codeChallenge) {
    return redirectError(redirectUri, 'invalid_request', state, 'code_challenge required (PKCE mandatory)');
  }
  if (codeChallengeMethod !== 'S256') {
    return redirectError(redirectUri, 'invalid_request', state, 'code_challenge_method must be S256');
  }

  // Silent scope filtering (RFC 6749 §3.3): unknown + client-disallowed drop out.
  const requested = parseScopeString(scope);
  let scopes: string[] = filterValidScopes(requested);
  if (requested.length === 0) {
    // Clients that request no scope get everything the client registration allows.
    scopes = client.scopesAllowed;
  } else if (client.scopesAllowed.length > 0) {
    const allowed = new Set(client.scopesAllowed);
    scopes = scopes.filter((s) => allowed.has(s));
  }
  if (scopes.length === 0) {
    return redirectError(redirectUri, 'invalid_scope', state, 'No valid scopes requested');
  }

  // Phase 3 — sign the validated request and hand over to the consent screen.
  const req = await signAuthorizeRequest({
    client_id: client.clientId,
    client_db_id: client.id,
    client_name: client.clientName,
    client_uri: client.clientUri,
    logo_uri: client.logoUri,
    redirect_uri: redirectUri,
    scopes,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  // getIssuer(), not url.origin — behind a reverse proxy url.origin resolves
  // to the internal upstream address.
  const consentUrl = new URL(`${getIssuer()}/oauth/consent`);
  consentUrl.searchParams.set('req', req);
  return NextResponse.redirect(consentUrl.toString(), { status: 302 });
}

function jsonError(error: string, description: string, status: number) {
  return NextResponse.json({ error, error_description: description }, { status });
}

function redirectError(redirectUri: string, error: string, state: string | undefined, description?: string) {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (description) url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  return NextResponse.redirect(url.toString(), { status: 302 });
}
