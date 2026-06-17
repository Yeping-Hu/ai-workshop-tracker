import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Deployment knobs (set as env vars in CI; sensible local defaults):
//   SITE_URL  e.g. https://yourname.github.io  or  https://ml-workshops.pages.dev
//   SITE_BASE e.g. /ai-workshop-tracker  (GitHub *project* pages) — leave unset for "/"
const SITE = process.env.SITE_URL || 'https://ai-workshop-tracker.pages.dev';
const BASE = process.env.SITE_BASE || '/';
// Unique per build. Used to detect a stale back/forward-cache page after a
// deploy and force one fresh load (see Base.astro pageshow handler).
const BUILD_ID = process.env.BUILD_ID || String(Date.now());

export default defineConfig({
  site: SITE,
  base: BASE,
  vite: {
    define: { 'import.meta.env.PUBLIC_BUILD_ID': JSON.stringify(BUILD_ID) },
    // The site imports shared code + data from the repo root (../lib, ../data).
    server: { fs: { allow: ['..'] } },
  },
  redirects: {
    '/archive': '/',
    '/search': '/',
    '/contribute': '/about',
    '/calendar': '/about',
  },
  trailingSlash: 'ignore',
  integrations: [sitemap()],
});
