/**
 * robots.txt, generated so the Sitemap line follows SITE_URL. A static file in
 * public/ carried the production hostname, so every fork and PR preview
 * advertised production's sitemap rather than its own.
 */
import type { APIRoute } from 'astro';
import { href } from '../lib/site';

export const GET: APIRoute = ({ site }) => {
  const origin = site ?? new URL('https://ai-workshop-tracker.pages.dev');
  const sitemap = new URL(href('/sitemap-index.xml'), origin).href;
  const body = `User-agent: *\nAllow: /\n\nSitemap: ${sitemap}\n`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
