/**
 * Pages that exist for a visitor mid-workflow, not for a searcher.
 *
 * Plain JS with no Astro imports on purpose: `astro.config.mjs` reads this to
 * keep these URLs out of the sitemap, and `Base.astro` reads it to put a
 * `noindex,follow` meta on the same pages, so the two can never drift apart.
 * Every entry below is also why it's here, because a later reader will
 * otherwise wonder whether `/alerts/` itself belongs on the list (it doesn't:
 * it is the feature's landing page and the one alerts URL a search should find).
 *
 *   /alerts/manage/        token-gated; renders "sign in" to a crawler
 *   /alerts/confirmed/     a state a visitor lands in once, from an email
 *   /alerts/unsubscribed/  likewise
 *   /alerts/error/         likewise
 *   /saved/                the visitor's own starred list, from localStorage —
 *                          the crawler sees an empty page
 *
 * Google had all five as "Discovered – currently not indexed": it was spending
 * crawl on them and the sitemap was inviting it to. `follow` (not `nofollow`)
 * so the links each page carries — header, footer hubs — still count.
 */
export const NOINDEX_PATHS = [
  '/alerts/manage/',
  '/alerts/confirmed/',
  '/alerts/unsubscribed/',
  '/alerts/error/',
  '/saved/',
];

const norm = (p) => (String(p || '/').replace(/\/+$/, '') || '') + '/';

/** Is this pathname (already including any site base) one of the above? */
export function isNoindex(pathname, base = '/') {
  const b = String(base || '/').replace(/\/+$/, '');
  let p = norm(pathname);
  if (b && p.startsWith(b + '/')) p = p.slice(b.length);
  return NOINDEX_PATHS.some((x) => norm(x) === p);
}
