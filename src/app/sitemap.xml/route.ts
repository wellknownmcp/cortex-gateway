/**
 * Sitemap — /sitemap.xml
 *
 * An MCP host is not a content site, and this sitemap does not pretend
 * otherwise: it lists the four URLs that actually exist here and are worth
 * fetching — the status page, and the three machine-readable descriptors.
 * Everything else on this host answers 401 and has no business in a sitemap.
 *
 * It exists because agent-readiness scanners (and the registries that reuse
 * their verdicts) look for one at the scanned origin, and an MCP host that
 * answers 404 there reads as an unmaintained endpoint. Listing four real URLs
 * is an honest answer to that; inventing pages would not be.
 *
 * A route rather than a static file: every `<loc>` must be absolute, and the
 * host is only known from configuration. Derived from CORTEX_CANONICAL_URI —
 * the endpoint URL — so the sitemap cannot disagree with what the gateway
 * tells clients about itself.
 */

import { canonicalUri } from '@/lib/oauth-validator';

const PATHS = [
  '/',
  '/llms.txt',
  '/.well-known/mcp/server-card.json',
  '/.well-known/oauth-protected-resource',
] as const;

export async function GET(): Promise<Response> {
  let origin: string;
  try {
    origin = new URL(canonicalUri()).origin;
  } catch {
    // Misconfigured CORTEX_CANONICAL_URI: an empty sitemap is a truthful
    // answer, a sitemap of broken URLs is not.
    origin = '';
  }

  const urls = origin
    ? PATHS.map((p) => `  <url><loc>${origin}${p}</loc></url>`).join('\n')
    : '';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
