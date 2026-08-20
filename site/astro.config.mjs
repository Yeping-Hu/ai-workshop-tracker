import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { lastDataChange } from '../lib/workshops.mjs';

// Deployment knobs (set as env vars in CI; sensible local defaults):
//   SITE_URL  e.g. https://yourname.github.io  or  https://ml-workshops.pages.dev
//   SITE_BASE e.g. /ai-workshop-tracker  (GitHub *project* pages) — leave unset for "/"
const SITE = process.env.SITE_URL || 'https://ai-workshop-tracker.pages.dev';
const BASE = process.env.SITE_BASE || '/';
// Unique per build. Used to detect a stale back/forward-cache page after a
// deploy and force one fresh load (see Base.astro pageshow handler).
const BUILD_ID = process.env.BUILD_ID || String(Date.now());
const BUILD_DATE = new Date().toISOString().slice(0, 10);

// When each workshop's data last actually changed, straight from git — see
// lastDataChange() in lib/workshops.mjs for why the dates inside the YAML are
// not enough on their own.
const WORKSHOP_LASTMOD = lastDataChange();

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
  integrations: [
    sitemap({
      // `lastmod` tells a crawler which pages are worth re-fetching, so it has
      // to be honest: each workshop reports the date git says its own data last
      // changed, and only the handful of pages that genuinely track the whole
      // corpus (home, hubs, about) carry the build date.
      serialize(item) {
        const m = /\/workshop\/([^/]+)\/?$/.exec(new URL(item.url).pathname);
        if (m) {
          const d = WORKSHOP_LASTMOD.get(m[1]);
          if (d) item.lastmod = d;
          return item;
        }
        item.lastmod = BUILD_DATE;
        return item;
      },
    }),
  ],
});
