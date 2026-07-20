import type { APIRoute } from 'astro';
import { site } from '../config/site';

// Emit robots.txt with an absolute Sitemap URL (a relative one is invalid).
// Indexing of preview deployments is separately gated by a noindex meta tag
// (see Layout.astro) when PUBLIC_INDEXABLE !== 'true'.
export const GET: APIRoute = () => {
  const sitemap = new URL('/sitemap-index.xml', site.baseUrl).href;
  const body = `# Luna Front Desk
User-agent: *
Allow: /

Sitemap: ${sitemap}
`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
