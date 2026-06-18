import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Deployment knobs (set as env vars in CI; sensible local defaults):
//   SITE_URL  e.g. https://yourname.github.io  or  https://ml-workshops.pages.dev
//   SITE_BASE e.g. /ai-workshop-tracker  (GitHub *project* pages) — leave unset for "/"
const SITE = process.env.SITE_URL || 'https://ai-workshop-tracker.pages.dev';
const BASE = process.env.SITE_BASE || '/';

export default defineConfig({
  site: SITE,
  base: BASE,
  redirects: {
    '/archive': '/',
    '/search': '/',
    '/contribute': '/about',
    '/calendar': '/about',
  },
  trailingSlash: 'ignore',
  integrations: [sitemap()],
  vite: {
    // The site imports shared code + data from the repo root (../lib, ../data).
    server: { fs: { allow: ['..'] } },
  },
});
