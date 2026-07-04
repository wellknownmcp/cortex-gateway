/**
 * GET /.well-known/oauth-authorization-server — RFC 8414 metadata.
 * MCP clients fetch this to discover register/authorize/token endpoints.
 */

import { NextResponse } from 'next/server';
import { ALL_SCOPES } from '@/lib/oauth/scopes';
import { getIssuer } from '@/lib/oauth/keys';

export function GET() {
  const issuer = getIssuer();
  return NextResponse.json(
    {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      introspection_endpoint: `${issuer}/oauth/introspect`,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      scopes_supported: ALL_SCOPES,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      service_documentation: 'https://github.com/wellknownmcp/cortex-gateway',
    },
    { headers: { 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' } },
  );
}
