/**
 * The board's facet URL contract, in one place.
 *
 * `?conference=NeurIPS,ICML&topic=Agents` — comma-joined **display labels**,
 * not ids. Labels because the URL is something a person reads, copies and edits;
 * ids would make a shared link unreadable and would break the moment a
 * vocabulary id was renamed.
 *
 * Why this module exists: /changes/ filters by the same facets as the board, and
 * a second parser would drift. A link built by one and read by the other has to
 * mean the same thing — including the digest's "and N more →" links, which
 * render.mjs builds server-side against this same format.
 *
 * A caveat worth stating plainly: the homepage's own copy of this logic still
 * lives inline in site/src/pages/index.astro. That script is `is:inline` with
 * `define:vars` (it needs build-time data injected), and an inline script cannot
 * import a module — so it could not be converted without restructuring how the
 * board receives its data. scripts/facet_params_test.mjs asserts that the
 * homepage's inline read/write lines still match this contract, so the two
 * cannot silently diverge while that remains true.
 */

/** The board's facets, in the order its UI presents them. */
export const FACETS = ['conference', 'status', 'year', 'topic'];

/**
 * Parse a query string into `{facet: Set<label>}`.
 * Unknown facets are ignored; an absent one yields an empty Set, never
 * undefined, so callers can treat "no filter" and "filter matching nothing"
 * as the distinct things they are.
 */
export function readFacets(search, facets = FACETS) {
  const p = new URLSearchParams(search || '');
  const out = {};
  for (const f of facets) {
    out[f] = new Set(
      (p.get(f) || '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    );
  }
  return out;
}

/**
 * The inverse: `{facet: Set<label>}` back into a query string, empty facets
 * omitted so a cleared filter leaves a clean URL rather than `?conference=`.
 */
export function writeFacets(sel, facets = FACETS) {
  const p = new URLSearchParams();
  for (const f of facets) {
    const vals = sel?.[f] ? [...sel[f]] : [];
    if (vals.length) p.set(f, vals.join(','));
  }
  return p.toString();
}

/** Does this row pass the current selection? An empty facet means "all". */
export function matchesFacets(row, sel, facets = FACETS) {
  for (const f of facets) {
    const want = sel?.[f];
    if (!want || want.size === 0) continue;
    const have = row?.[f];
    const values = Array.isArray(have) ? have : [have];
    if (!values.some((v) => v != null && want.has(String(v)))) return false;
  }
  return true;
}
