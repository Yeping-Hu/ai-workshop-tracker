/**
 * How a workshop's identity is *displayed*. Display only — nothing here decides
 * what is stored, and no caller may edit data to make a label come out nicer.
 *
 * Deliberately pure and dependency-free, for two reasons:
 *
 *   1. `alerts/render.mjs` imports it, and that module is bundled into the
 *      Cloudflare Worker. Anything reaching for `node:fs` or a YAML parser here
 *      would break the Worker build. (Because the Worker bundle now spans this
 *      file, `.github/workflows/alerts-worker-deploy.yml` lists it in the paths
 *      that trigger a redeploy — otherwise a change here would ship to the site
 *      and silently leave the digest running the old rule.)
 *   2. The site build imports it too, so it cannot live under `alerts/` without
 *      breaking the promise that deleting that directory leaves the site
 *      unchanged (docs/ALERTS.md).
 */

/**
 * Is this string shaped like an acronym at all?
 *
 * **THE** definition — one token, at most 15 characters. `acronymDrift` in
 * scripts/deadline_crosscheck.mjs calls this rather than re-testing the shape,
 * because two copies of a heuristic drift apart and then the reviewer and the
 * renderer disagree about what an acronym even is.
 *
 * The threshold is not arbitrary: OpenReview's `subtitle` is only sometimes an
 * acronym and is often a descriptive phrase, and measuring against the corpus
 * put the false-positive rate at 4.9% without this test and 0% with it.
 *
 * It is also what stops the digest printing an underscore-joined stem as though
 * it were an acronym — `NeurReps_Extended_Abstracts` and
 * `Scalable_Tactile_Manipulation` carry no whitespace but are far past the
 * length limit, so neither is acronym-shaped.
 */
export function isAcronymShaped(value) {
  const s = String(value ?? '').trim();
  return !!s && !/\s/.test(s) && s.length <= 15;
}

/** Case- and punctuation-insensitive comparison key. */
const key = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

/**
 * A venue year sitting on the end of an acronym: "NLPOR 2025" -> "NLPOR",
 * "Sim'25" -> "Sim", "ReALM-GEN 2026" -> "ReALM-GEN", "AI4Mat-ICLR-2026" ->
 * "AI4Mat-ICLR".
 *
 * **One shared shape predicate, caller-specific input normalization.** This is
 * the normalization half, and it is deliberately NOT folded into
 * `isAcronymShaped`: the shape test answers "is this token acronym-shaped",
 * this answers "is part of this token just the year again". A future reader
 * tempted to unify them should not — `acronymDrift` must keep testing the shape
 * of what upstream actually said, unnormalized.
 *
 * **Asymmetry with the stored-data normalizer, on purpose.** `cleanAcronym`
 * removes a year only to decide whether an acronym is nothing but the venue,
 * and otherwise returns the value untouched, because a year can be part of a
 * workshop's branding and stored data must not quietly lose it. Display is
 * free to be more aggressive: the label it builds already ends in
 * "· NeurIPS 2026", so a year inside the acronym is pure redundancy. Stored
 * stays conservative to protect branding; display eliminates repetition.
 *
 * Only a four-digit 19xx/20xx, or an apostrophe and two digits, counts. A bare
 * trailing digit pair would eat real acronyms — "RAM2" and "MARS2" both end in
 * a digit and neither is a year.
 */
const YEAR_TAIL = /(?:[\s._-]*(?:19|20)\d{2}|['’]\d{2})\s*$/;

export function stripAcronymYear(value, year = null) {
  let s = String(value ?? '').trim();
  if (year) s = s.split(String(year)).join(' ');
  s = s.replace(YEAR_TAIL, '');
  return s.replace(/\s{2,}/g, ' ').replace(/[\s._-]+$/, '').trim();
}

/**
 * The acronym to show beside a workshop's name, or `null` for "show none".
 *
 * Rules, applied in this order — the order is load-bearing:
 *
 *   0. Strip a trailing venue year (`stripAcronymYear`). The **stripped** value
 *      is what everything below sees and what is ultimately displayed, because
 *      the label's own suffix already carries the year.
 *   1. Not acronym-shaped (see `isAcronymShaped`) → nothing. A long
 *      underscore-joined stem is a name written without spaces, not an acronym.
 *   2. The name already contains it → nothing. Repeating "DAIH" beside
 *      "…Data and AI for Health (DAIH)" is noise, and the comparison ignores
 *      case and punctuation so "AI4Math" matches "ai4-math". This runs on the
 *      STRIPPED value on purpose: a name containing "NLPOR" must still suppress
 *      the acronym even though the stored value was "NLPOR 2025".
 *   3. A derived track suffix that the name already states → do not stack it.
 *      `workshopShortName` appends "(Main Track)" mechanically, which reads as a
 *      stutter on a workshop already called "… Main Track".
 *
 * Returns the acronym alone, or `ACRO (Track)` when the track adds something.
 *
 * @param {string} name        the workshop's full name
 * @param {string} acronym     the stored acronym — NOT the derived short_name,
 *                             whose "(track)" suffix would fail rule 1
 * @param {string|null} trackLabel  `track_label` from the feed, when present
 * @param {number|string|null} year the workshop's year, so the strip can remove
 *                             it even when written in a form the tail regex
 *                             alone would miss
 */
export function displayAcronym(name, acronym, trackLabel = null, year = null) {
  const acr = stripAcronymYear(acronym, year);
  if (!isAcronymShaped(acr)) return null;

  const acrKey = key(acr);
  if (!acrKey) return null;

  const nameKey = key(name);
  if (nameKey && nameKey.includes(acrKey)) return null;

  const track = String(trackLabel ?? '').trim();
  if (!track) return acr;
  const trackKey = key(track);
  if (!trackKey || (nameKey && nameKey.includes(trackKey))) return acr;
  return `${acr} (${track})`;
}

/**
 * The one-line label for a workshop, in both consumers (digest and /changes/).
 *
 *   with an acronym     Name (ACRO · NeurIPS 2026)
 *   without one         Name — NeurIPS 2026
 *
 * The em dash form matters: falling back to `Name (NeurIPS 2026)` would put the
 * venue where readers have learned to expect the acronym.
 */
export function displayLabel(name, acronym, { conference, year, trackLabel = null } = {}) {
  const venue = [conference, year].filter(Boolean).join(' ');
  const shown = displayAcronym(name, acronym, trackLabel, year);
  const title = String(name ?? '').trim() || String(acronym ?? '').trim();
  if (!venue) return title;
  return shown ? `${title} (${shown} · ${venue})` : `${title} — ${venue}`;
}
