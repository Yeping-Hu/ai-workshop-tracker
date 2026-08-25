/**
 * Schema validation for data/changes.json — the feed behind /changes/.
 *
 * Why this exists: on 2026-08-25 a hand-authored data/changes.json shipped and
 * went live on a page whose footer says the data is observed. Every one of its
 * five rows was malformed in a way a machine can see — null timestamps on rows
 * claiming a date moved, day counts attached to nothing — and nothing checked.
 * Review caught it; review should not have had to.
 *
 * This is deliberately a *shape* check, not a truth check. It cannot know
 * whether a real extension was 5 days or 10; that is what the workshop's own
 * deadline_history says, and what the daily routine cross-checks. What it can
 * do is make the fabricated file mechanically rejectable: a row that says a
 * deadline moved must carry the two dates it moved between, and a feed with
 * events must say when it was generated. Every row of the retracted file fails
 * at least one of these — see scripts/changes_feed_test.mjs, which runs the
 * byte-exact file it shipped.
 *
 * Pure: takes the parsed feed and the set of known slugs, returns messages.
 * scripts/validate.mjs owns reading the file and reporting.
 */

/** Event kinds the pipeline emits (alerts/diff.mjs). */
export const KINDS = new Set(['extended', 'earlier', 'deadline_announced', 'announced']);

/** Kinds asserting that a deadline moved from one date to another. */
const MOVED = new Set(['extended', 'earlier']);

const isIso = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));

/**
 * @param {any} feed  parsed data/changes.json
 * @param {{slugs?: Set<string>, addedBySlug?: Map<string,string>}} corpus
 *        every slug in data/workshops, and each one's `added` date where it has
 *        one — enough to refute an `announced` claim without a truth pass.
 * @returns {string[]} error messages, empty when the feed is well-formed
 */
export function validateChangesFeed(feed, corpus = {}) {
  const knownSlugs = corpus.slugs ?? (corpus instanceof Set ? corpus : new Set());
  const addedBySlug = corpus.addedBySlug ?? new Map();
  const errs = [];

  if (feed === null || typeof feed !== 'object' || Array.isArray(feed)) {
    return ['File must contain a JSON object.'];
  }
  if (!Array.isArray(feed.events)) {
    return ['`events` is required and must be an array (use `[]` for a quiet week).'];
  }

  // An empty feed is a legitimate, expected state — a genuinely quiet week, or
  // the period before the pipeline has ever run. It carries no claims, so it
  // needs no timestamp. A feed WITH events is claiming observations, and an
  // observation with no recorded time is not one.
  if (feed.events.length > 0 && !isIso(feed.generated_at)) {
    errs.push('`generated_at` must be an ISO timestamp when `events` is non-empty.');
  }
  if (feed.since != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(feed.since))) {
    errs.push('`since` must be a YYYY-MM-DD date, or null.');
  }

  feed.events.forEach((e, i) => {
    const at = `event ${i + 1}`;
    const slug = e?.slug;
    const where = slug ? `${at} (${slug})` : at;

    if (typeof slug !== 'string' || !slug) {
      errs.push(`${at}: \`slug\` is required.`);
    } else if (knownSlugs.size && !knownSlugs.has(slug)) {
      // A slug the corpus does not contain cannot have been observed changing.
      errs.push(`${where}: no such workshop in data/workshops.`);
    }

    if (!KINDS.has(e?.kind)) {
      errs.push(`${where}: \`kind\` must be one of ${[...KINDS].join(', ')}.`);
      return; // the per-kind rules below are meaningless without a valid kind
    }

    if (MOVED.has(e.kind)) {
      // The load-bearing rule. "Extended by 5 days" from nothing to nothing is
      // the exact shape of the retracted file.
      if (!Number.isInteger(e.days) || e.days < 1) {
        errs.push(`${where}: \`${e.kind}\` requires an integer \`days\` of at least 1 (got ${JSON.stringify(e.days)}).`);
      }
      if (!isIso(e.old_utc)) {
        errs.push(`${where}: \`${e.kind}\` requires a parseable \`old_utc\` — the date it moved FROM (got ${JSON.stringify(e.old_utc)}).`);
      }
      if (!isIso(e.new_utc)) {
        errs.push(`${where}: \`${e.kind}\` requires a parseable \`new_utc\` — the date it moved TO (got ${JSON.stringify(e.new_utc)}).`);
      }
      // Direction is checkable from the row alone and is where the retracted
      // file's "earlier 2 days" for a 10-day extension would have been caught.
      if (isIso(e.old_utc) && isIso(e.new_utc)) {
        const delta = Date.parse(e.new_utc) - Date.parse(e.old_utc);
        if (e.kind === 'extended' && delta <= 0) {
          errs.push(`${where}: \`extended\` but \`new_utc\` is not after \`old_utc\`.`);
        }
        if (e.kind === 'earlier' && delta >= 0) {
          errs.push(`${where}: \`earlier\` but \`new_utc\` is not before \`old_utc\`.`);
        }
      }
    }

    if (e.kind === 'deadline_announced') {
      // A first deadline: there is a date now, and there was none before.
      if (!isIso(e.new_utc)) {
        errs.push(`${where}: \`deadline_announced\` requires a parseable \`new_utc\` (got ${JSON.stringify(e.new_utc)}).`);
      }
      if (e.old_utc != null) {
        errs.push(`${where}: \`deadline_announced\` must have a null \`old_utc\` — there was no previous date.`);
      }
      if (e.days != null) {
        errs.push(`${where}: \`deadline_announced\` must have a null \`days\` — nothing moved.`);
      }
    }

    // `announced` is a workshop appearing at all. Its shape asserts almost
    // nothing — no dates are required, because a workshop can be posted before
    // it has a deadline — so the shape alone cannot refute a fabricated one.
    // The corpus can: the claim is that this workshop appeared during the
    // window, and every real `announced` event in the store has an `added` date
    // equal to the day it was observed. A workshop added three weeks before
    // `since` did not appear this week.
    if (e.kind === 'announced') {
      if (e.days != null) {
        errs.push(`${where}: \`announced\` must have a null \`days\` — nothing moved.`);
      }
      const added = addedBySlug.get(slug);
      if (added && feed.since && /^\d{4}-\d{2}-\d{2}$/.test(added) && added < String(feed.since)) {
        errs.push(
          `${where}: \`announced\` claims the workshop appeared this window, ` +
          `but data/workshops/${slug}.yml records \`added: ${added}\`, before \`since: ${feed.since}\`.`,
        );
      }
    }
  });

  return errs;
}
