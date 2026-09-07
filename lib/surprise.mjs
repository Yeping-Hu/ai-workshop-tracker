/**
 * "Surprise me": one random accepted paper from a workshop page.
 *
 * The paper cache holds ~20k titles that almost nobody scrolls. A button that
 * shows one at random is a cheap way to make a page worth a second look —
 * and, on an upcoming edition, to answer "what got in last time?" from the
 * previous edition's cache. No fetch: the pool is either the titles already
 * on the page or a build-time list embedded for the previous edition.
 *
 * Source, in order: the page's own papers, else the newest earlier edition
 * (`relatedEditions`, the same identity as "Other editions") that has a
 * non-empty cache. Links stay on this site (`/workshop/<slug>/#p-<id>`), where
 * the star lives, rather than jumping to OpenReview.
 *
 * `paperId()` is the one definition of a paper's stable id — the OpenReview
 * forum id when present (survives cache refreshes and reordering), else
 * slug+index — shared by the page's star buttons and the anchors here, so an
 * anchor built at build time always lands on the id the page rendered.
 *
 * Pinned by scripts/surprise_test.mjs.
 */

/** Stable id for a paper: forum id from its URLs, else `<slug>~<index>`. */
export function paperId(p, i, slug) {
  return String(p?.forum_url || p?.pdf_url || '').match(/[?&]id=([^&#]+)/)?.[1] ?? `${slug}~${i}`;
}

/**
 * @param {object} w resolved workshop (slug, year, relatedEditions)
 * @param {(slug: string) => object|null} readCache  a paper-cache reader (lib/workshops.mjs loadPaperCache in the site)
 * @param {{ max?: number, confName?: (id: string) => string }} opts
 * @returns {{ from: 'this', slug: string, count: number }
 *         | { from: 'previous', slug: string, label: string, papers: Array<[string, string]> }
 *         | null}
 */
export function surprisePool(w, readCache, { max = 150, confName = (id) => id } = {}) {
  if (!w || typeof readCache !== 'function') return null;
  const own = readCache(w.slug);
  if (Array.isArray(own?.papers) && own.papers.length > 0) {
    return { from: 'this', slug: w.slug, count: own.papers.length };
  }
  const earlier = (w.relatedEditions ?? [])
    .filter((e) => Number.isInteger(e.year) && e.year < w.year)
    .sort((a, b) => b.year - a.year || String(a.slug).localeCompare(String(b.slug)));
  for (const e of earlier) {
    const cache = readCache(e.slug);
    const papers = Array.isArray(cache?.papers) ? cache.papers.filter((p) => p && p.title) : [];
    if (!papers.length) continue;
    return {
      from: 'previous',
      slug: e.slug,
      label: `${confName(e.conference)} ${e.year}`,
      papers: papers.slice(0, max).map((p, i) => [String(p.title), `/workshop/${e.slug}/#p-${paperId(p, i, e.slug)}`]),
    };
  }
  return null;
}

/** A random index in [0, n) that is never `avoid` when n > 1. */
export function pickIndex(n, avoid = -1, rand = Math.random) {
  if (!(n > 1)) return 0;
  let i = Math.floor(rand() * n);
  if (!(i >= 0 && i < n)) i = 0;
  if (i === avoid) i = (i + 1) % n;
  return i;
}
