/** GET /.well-known/jwks.json — public signing keys (RS256). */

import { NextResponse } from 'next/server';
import { getJwks } from '@/lib/oauth/keys';

export async function GET() {
  const jwks = await getJwks();
  return NextResponse.json(jwks, {
    headers: { 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' },
  });
}
