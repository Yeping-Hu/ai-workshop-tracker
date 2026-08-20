import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { loadWorkshops } from '../lib/workshops.mjs';

// Deployment knobs (set as env vars in CI; sensible local defaults):
//   SITE_URL  e.g. https://yourname.github.io  or  https://ml-workshops.pages.dev
//   SITE_BASE e.g. /ai-workshop-tracker  (GitHub *project* pages) — leave unset for "/"
const SITE = process.env.SITE_URL || 'https://ai-workshop-tracker.pages.dev';
const BASE = process.env.SITE_BASE || '/';
// Unique per build. Used to detect a stale back/forward-cache page after a
// deploy and force one fresh load (see Base.astro pageshow handler).
const BUILD_ID = process.env.BUILD_ID || String(Date.now());
const BUILD_DATE = new Date().toISOString().slice(0, 10);

// Last date each workshop's own data changed: when it was added, or the most
// recent deadline observation logged against it. Read once at config time.
const WORKSHOP_LASTMOD = new Map(
  loadWorkshops().map((w) => {
    const dates = [w.added, ...(w.deadline_history ?? []).map((h) => h.recorded)]
      .filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
    return [w.slug, dates.length ? dates[dates.length - 1] : null];
  }),
);

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
      // `lastmod` tells a crawler which pages are worth re-fetching. Stamping
      // every URL with the build time would be a lie — the site rebuilds daily
      // and almost nothing changes — and a sitemap that claims 900 pages
      // changed every night is one a crawler learns to discount. So each
      // workshop reports the last date its own data actually moved, and the
      // handful of pages that genuinely track the corpus get the build date.
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
