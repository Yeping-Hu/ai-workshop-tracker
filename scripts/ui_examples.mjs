/**
 * Which live examples the browser suite exercises, chosen from the built
 * /api/workshops.json at run time instead of written into the test.
 *
 * Why: the ordering checks need open calls, and open calls are a function of
 * the calendar. A conference named in the test ("IROS") passes until its last
 * deadline does and then fails three checks on every run — Build check went
 * red that way on 2026-09-26 with no change to the code it guards. Picking the
 * example from the corpus keeps the suite meaningful as calls open and close;
 * when the corpus genuinely has nothing to show (off-season), the caller warns
 * and skips the check rather than failing on a date.
 *
 * Pure functions over the API rows, pinned by scripts/ui_examples_test.mjs.
 */

/** Rows that are an open call at `now`: the API's status, re-checked against the clock. */
export function openCalls(workshops, now) {
  return workshops.filter((w) => w.status === 'upcoming' && w.deadline_utc && Date.parse(w.deadline_utc) > now);
}

/**
 * The conference with the most open calls (ties broken by id, so a run is
 * reproducible), or null when none has at least `min` — the browse-order
 * checks compare neighbouring open-call rows, so they need two.
 */
export function pickBrowseConference(workshops, now, { min = 2 } = {}) {
  const counts = new Map();
  for (const w of openCalls(workshops, now)) counts.set(w.conference, (counts.get(w.conference) ?? 0) + 1);
  const best = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return best && best[1] >= min ? { conference: best[0], open: best[1] } : null;
}

/** What a keyword search can match on a row without the paper index. */
const haystack = (w) => [w.name, w.acronym, w.short_name, ...(w.topics ?? [])].filter(Boolean).join(' ');

/**
 * The first candidate keyword whose matches include a few open calls (at least
 * `min`, at most `max` — fewer than a 50-row page, so page one also shows
 * closed calls) and at least `minClosed` closed ones, or null. Candidates are
 * tried in order, so the long-standing query stays in use while it works.
 * Word-prefix matching approximates Pagefind's stemming ("robot" ~ "Robotics").
 */
export function pickSortQuery(workshops, now, candidates, { min = 2, max = 30, minClosed = 10 } = {}) {
  const open = new Set(openCalls(workshops, now).map((w) => w.slug));
  for (const q of candidates) {
    const re = new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    const hits = workshops.filter((w) => re.test(haystack(w)));
    const nOpen = hits.filter((w) => open.has(w.slug)).length;
    if (nOpen >= min && nOpen <= max && hits.length - nOpen >= minClosed) return { q, open: nOpen };
  }
  return null;
}
