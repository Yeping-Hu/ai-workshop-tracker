/**
 * Reconciling a saved list with the corpus it points at.
 *
 * `awt-fav-workshops` holds slugs, not snapshots (see favorites.js), so a slug
 * whose entry later leaves the dataset becomes a saved item that can never
 * render: the /saved/ heading counted 27, twenty-six rows appeared, and a note
 * said one was "no longer in the dataset". There was no star to press to clear
 * it — the row it belonged to is what carries the star — so the mismatch was
 * permanent, on every device the account synced to.
 *
 * A slug leaves the dataset in exactly two ways, and they deserve opposite
 * answers:
 *
 *   RENAMED. Two OpenReview groups for one workshop get merged, the duplicate's
 *   file is deleted and its id recorded in the survivor's `merged_venue_ids`.
 *   The URL already survives that (mergedSlugRedirects in lib/workshops.mjs
 *   turns each pair into a redirect); the star did not. Following the same map
 *   keeps the save pointing at the workshop the reader actually starred.
 *
 *   REMOVED. Nothing to point at any more, so the entry goes — and the count
 *   drops with it rather than being explained away in a note.
 *
 * Split out of favorites.js so the rule is testable under `node`: this module
 * is pure, touching no DOM, no storage and no network (scripts/saved_repair_test.mjs).
 * favorites.js owns the consequences — writing storage, recording the removal
 * in the alerts outbox so the account converges too, and repainting the badge.
 *
 * THE ONE THING IT MUST NOT DO is delete a list because a build was broken.
 * The corpus arrives over the network, and an empty or truncated
 * /api/workshops.json would otherwise read as "every workshop you saved is
 * gone". A dump smaller than MIN_CORPUS is refused outright: the corpus has
 * been in the hundreds since 2025 and only grows, so a fraction of it is a
 * deploy accident, and an accident must cost a repaint, never a saved list.
 */

/**
 * Below this many workshops the dump is treated as broken rather than as a
 * corpus that lost almost everything. Far under the real count (~940 and
 * climbing), so it can only ever fire on a genuinely truncated build.
 */
export const MIN_CORPUS = 100;

/** A merge chain is one hop in practice; the bound just makes a cycle finite. */
const MAX_HOPS = 5;

/** Where a slug ends up, or null when the chain leads nowhere live. */
function follow(slug, moved, live) {
  let cur = slug;
  const seen = new Set([cur]);
  for (let i = 0; i < MAX_HOPS; i++) {
    const next = moved.get(cur);
    if (typeof next !== 'string' || !next || seen.has(next)) return null;
    if (live.has(next)) return next;
    seen.add(next);
    cur = next;
  }
  return null;
}

/**
 * @param saved  the stored slug list, exactly as localStorage holds it
 * @param live   every slug in the corpus (array or Set)
 * @param moved  old slug -> current slug (object or Map), from the dump's
 *               `moved_slugs`
 * @returns {
 *   ran,        // false when the corpus looked broken: nothing was decided
 *   ws,         // the list to store
 *   renamed,    // [{from, to}] — saves that followed a merge
 *   dropped,    // slugs with nothing left to point at
 *   changed,    // whether `ws` differs from `saved` at all
 * }
 */
export function repairSavedWorkshops({ saved = [], live = [], moved = null, minCorpus = MIN_CORPUS } = {}) {
  const list = Array.isArray(saved) ? saved : [];
  const liveSet = live instanceof Set ? live : new Set(Array.isArray(live) ? live : []);
  if (liveSet.size < minCorpus) {
    return { ran: false, ws: [...list], renamed: [], dropped: [], changed: false };
  }
  const movedMap = moved instanceof Map ? moved : new Map(Object.entries(moved || {}));

  const ws = [];
  const renamed = [];
  const dropped = [];
  const seen = new Set();
  for (const entry of list) {
    // Anything that is not a slug never rendered and never will; it is dropped
    // silently rather than reported, because it is not a workshop the reader
    // lost — it is a corrupt row that was inflating the count.
    if (typeof entry !== 'string' || !entry) continue;
    let slug = entry;
    if (!liveSet.has(slug)) {
      const to = follow(slug, movedMap, liveSet);
      if (!to) {
        dropped.push(slug);
        continue;
      }
      renamed.push({ from: slug, to });
      slug = to;
    }
    // A rename can land on a slug the reader had already starred separately —
    // both groups of one merged workshop, saved before the merge.
    if (seen.has(slug)) continue;
    seen.add(slug);
    ws.push(slug);
  }

  const changed = ws.length !== list.length || ws.some((s, i) => s !== list[i]);
  return { ran: true, ws, renamed, dropped, changed };
}
