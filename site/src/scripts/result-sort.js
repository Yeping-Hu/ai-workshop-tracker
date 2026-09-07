/**
 * How the homepage's search results are ordered — the "Sort" picker's rules,
 * in one place.
 *
 * The results arrive from Pagefind already grouped per workshop (buildState in
 * index.astro) in the engine's own order: relevance when there are keywords,
 * the build-time browse key when there are none. The picker re-orders those
 * groups in the browser — no second search, no fetch — from the metadata every
 * result carries anyway (the `pfFields` contract in workshop/[slug].astro): the
 * browse key itself (`order`), the edition year, the paper deadline as an ISO
 * instant, and the name.
 *
 * Why in the browser and not in the engine: Pagefind's `sort` option replaces
 * relevance outright, and the papers index carries no sort key, so with a
 * keyword the engine could not place a workshop that matched only through its
 * papers. Re-ordering the groups after they are built treats both kinds of
 * match alike and keeps the engine's deterministic base order (score, then id)
 * underneath every tie.
 *
 * Why "soonest deadline" reuses the browse key instead of rebuilding it here:
 * that key is the order the board and the filter-only browse already show —
 * open calls by soonest deadline, then announced editions with no deadline yet,
 * then everything else most recent first. One definition, made at build time,
 * so a keyword search sorted this way and a filter-only browse can never
 * disagree about where a workshop belongs.
 *
 * The homepage's search script is inline (it takes define:vars) and cannot
 * import, so index.astro bridges these onto window the way ws-row.js is
 * bridged; scripts/result_sort_test.mjs pins the rules below.
 */

/**
 * The picker's options, in the order it lists them.
 *   says        the phrase the result-count line uses to state the order
 *   needsQuery  meaningless without keywords (no score to rank by, no
 *               matching papers to count), so the option is greyed in a
 *               filter-only browse and the mode's default applies instead
 */
export const SORTS = [
  { key: 'relevance', label: 'Best match', says: 'by relevance', needsQuery: true },
  { key: 'soonest', label: 'Soonest deadline', says: 'open calls first' },
  { key: 'oldest', label: 'Oldest first', says: 'oldest first' },
  { key: 'name', label: 'Name A–Z', says: 'by name' },
  { key: 'papers', label: 'Most matching papers', says: 'most matching papers first', needsQuery: true },
];

/** With keywords, Pagefind's relevance; without, the browse order. */
export function defaultSort(hasQuery) {
  return hasQuery ? 'relevance' : 'soonest';
}

/**
 * The order actually applied for a requested key: the key itself when it is
 * known and usable in the current mode, otherwise the mode's default. A choice
 * can outlive the mode it was made in — "Best match" picked with a keyword
 * means nothing once the keyword is removed — and this is where it falls back.
 */
export function effectiveSort(key, hasQuery) {
  const s = SORTS.find((o) => o.key === key);
  return s && (hasQuery || !s.needsQuery) ? s.key : defaultSort(hasQuery);
}

const num = (v) => {
  if (v == null || v === '') return null; // Number('') is 0, not "unknown"
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const instant = (iso) => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? null : ms;
};
// Dictionary order, digits as numbers ("Workshop 2" before "Workshop 10"),
// case and accents folded — a list of names should read as a list of names.
const byName = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true, sensitivity: 'base' });
// The final tie-break everywhere: the slug is unique, so two runs over the
// same results can never disagree.
const bySlug = (a, b) => String(a.slug ?? '').localeCompare(String(b.slug ?? ''));
// Code-unit order, for the browse key: localeCompare's collation puts symbols
// before digits, which would float the "no key" placeholder to the top.
const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const COMPARE = {
  // The build-time browse key is a fixed-width ASCII string made to compare
  // code unit by code unit. A result without one (an index built before the
  // key was published, in the seconds around a deploy) goes last rather than
  // first: '~' is above every digit.
  soonest: (a, b) => byKey(a.view.order || '~', b.view.order || '~') || bySlug(a.view, b.view),
  // By edition year, then by the paper deadline within the year. An edition
  // with no deadline closes its year — a "TBA" is not older than a dated
  // sibling — and an unknown year goes last. Names, then slugs, settle the rest.
  oldest: (a, b) => {
    const ya = num(a.view.year), yb = num(b.view.year);
    if (ya !== yb) return ya == null ? 1 : yb == null ? -1 : ya - yb;
    const wa = instant(a.view.deadline_utc), wb = instant(b.view.deadline_utc);
    if ((wa == null) !== (wb == null)) return wa == null ? 1 : -1;
    return (wa ?? 0) - (wb ?? 0) || byName(a.view.name, b.view.name) || bySlug(a.view, b.view);
  },
  // Same name across editions: newest edition first, the way a series reads.
  name: (a, b) =>
    byName(a.view.name, b.view.name) || (num(b.view.year) ?? 0) - (num(a.view.year) ?? 0) || bySlug(a.view, b.view),
  // Workshops where the keywords hit the most papers first. Ties keep the
  // engine's relevance order (Array#sort is stable), so among workshops with
  // one matching paper each the best match still leads.
  papers: (a, b) => (b.matched || 0) - (a.matched || 0),
};

/**
 * Order the grouped results.
 *   items     [{ view, matched }] in the engine's order. `view` is the
 *             API-shaped object viewFromMeta builds (order, year, deadline_utc,
 *             name, slug); `matched` is how many papers the keywords matched
 *             inside the workshop (0 without keywords).
 *   key       the requested sort, resolved through effectiveSort
 *   hasQuery  whether keywords are active
 * Returns { key: the sort applied, items: a new array }. The input is never
 * mutated, so switching back to "Best match" is the engine's order again.
 */
export function sortResults(items, key, hasQuery) {
  const applied = effectiveSort(key, hasQuery);
  const cmp = COMPARE[applied];
  return { key: applied, items: cmp ? [...items].sort(cmp) : [...items] };
}
