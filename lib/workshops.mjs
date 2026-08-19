/**
 * Loads and resolves all repository data (workshops, conferences, topics,
 * cached paper lists). Used by the Astro site at build time and by every
 * script. The repo root is derived from this file's location, so it works
 * from any working directory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import {
  resolveDeadlineUtcMs,
  parseDateUtcMs,
  computeStatus,
  formatDeadlineWallClock,
  formatDateYmd,
} from './dates.mjs';

/**
 * Locate the repo root by walking upward until `data/workshops` is found.
 * (A plain `../` from this file breaks once a bundler relocates the module,
 * e.g. into the Astro build output.) Override with env REPO_ROOT if needed.
 */
function findRepoRoot() {
  const starts = [
    process.env.REPO_ROOT,
    path.dirname(fileURLToPath(import.meta.url)),
    process.cwd(),
  ].filter(Boolean);
  for (const start of starts) {
    let dir = path.resolve(start);
    for (let i = 0; i < 10; i++) {
      if (fs.existsSync(path.join(dir, 'data', 'workshops'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error('ai-workshop-tracker: could not locate the repo root (no data/workshops directory found).');
}
export const REPO_ROOT = findRepoRoot();
export const WORKSHOPS_DIR = path.join(REPO_ROOT, 'data', 'workshops');
export const CACHE_DIR = path.join(REPO_ROOT, 'cache', 'openreview');

export function loadConferences() {
  const raw = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'data', 'conferences.yml'), 'utf8'));
  return Array.isArray(raw) ? raw : [];
}

export function loadTopics() {
  const raw = yaml.load(fs.readFileSync(path.join(REPO_ROOT, 'data', 'topics.yml'), 'utf8'));
  return Array.isArray(raw) ? raw : [];
}

/** List workshop YAML files (absolute paths), excluding the template. */
export function listWorkshopFiles() {
  return fs
    .readdirSync(WORKSHOPS_DIR)
    .filter((f) => (f.endsWith('.yml') || f.endsWith('.yaml')) && !f.startsWith('_'))
    .sort()
    .map((f) => path.join(WORKSHOPS_DIR, f));
}

/** Parse one workshop file without resolving derived fields. Throws on YAML errors. */
export function readWorkshopFile(filePath) {
  const raw = yaml.load(fs.readFileSync(filePath, 'utf8'));
  const slug = path.basename(filePath).replace(/\.ya?ml$/, '');
  return { slug, file: path.relative(REPO_ROOT, filePath), raw };
}

/** Conference edition dates from data/editions.yml; [] when the file is absent. */
export function loadEditions() {
  const p = path.join(REPO_ROOT, 'data', 'editions.yml');
  if (!fs.existsSync(p)) return [];
  return yaml.load(fs.readFileSync(p, 'utf8')) ?? [];
}

/** How recently a change must have been observed to be surfaced in the UI. */
const CHANGE_WINDOW_DAYS = 14;
/** Sub-hour deltas are timezone re-interpretations or typo fixes, not real moves. */
const MIN_CHANGE_MS = 3_600_000;

/**
 * Derive the most recent *notable* deadline change from an append-only
 * `deadline_history`. Returns null when there is nothing honest to report.
 *
 * Deliberately conservative: only the latest transition is described, only
 * within CHANGE_WINDOW_DAYS, and sub-hour deltas are suppressed so an
 * OpenReview timezone re-read never renders as "extended by 0 days".
 *
 * `recorded` dates are when WE saw a value, never when organizers changed it —
 * the UI must say so, because we cannot know the latter.
 */
export function deriveDeadlineChange(history, nowMs = Date.now(), parseDeadline, formatWallClock = (v) => v) {
  if (!Array.isArray(history) || history.length === 0) return null;
  const last = history[history.length - 1];
  if (!last?.recorded) return null;

  const recordedMs = Date.parse(`${last.recorded}T00:00:00Z`);
  if (!Number.isFinite(recordedMs)) return null;
  const daysAgo = Math.floor((nowMs - recordedMs) / 86_400_000);
  if (daysAgo < 0 || daysAgo > CHANGE_WINDOW_DAYS) return null;

  const prev = history.length >= 2 ? history[history.length - 2] : null;

  // First recorded value, or a date arriving where there was none: "announced".
  if (!prev || prev.value == null) {
    if (last.value == null) return null;
    return { kind: 'announced', daysAgo, days: 0, fromWallClock: null, recorded: last.recorded };
  }
  if (last.value == null) return null;

  const from = parseDeadline(prev.value, prev.timezone);
  const to = parseDeadline(last.value, last.timezone);
  if (from == null || to == null) return null;
  const deltaMs = to - from;
  if (Math.abs(deltaMs) < MIN_CHANGE_MS) return null;

  return {
    kind: deltaMs > 0 ? 'extended' : 'earlier',
    days: Math.max(1, Math.round(Math.abs(deltaMs) / 86_400_000)),
    fromWallClock: formatWallClock(prev.value, prev.timezone),
    daysAgo,
    recorded: last.recorded,
  };
}

/**
 * Record an observed submission-deadline value on a raw workshop record,
 * appending to the append-only `deadline_history` only when the value actually
 * changed. Returns true if a new entry was appended.
 *
 * Callers MUST still set `raw.submission_deadline` and re-stamp
 * `raw.deadline_notes` themselves — history and the visible note have to move
 * in the same write, or the page contradicts itself.
 *
 * Seeding: on the first observed change there is no prior log entry, so the
 * outgoing value is backfilled using the `(as of YYYY-MM-DD)` stamp that
 * `syncNote()` already writes into `deadline_notes` — that date is exactly when
 * the old value was last confirmed. Falls back to `added`, then to today.
 */
export function recordDeadlineObservation(raw, value, today, timezone) {
  const norm = (v) => (v == null || v === '' ? null : String(v));
  const next = norm(value);
  // A deadline string only fixes an instant together with its zone, so each entry
  // carries the zone it was recorded in. Without it, re-parsing an old value under
  // a zone the entry has since changed to shifts it by up to 12 hours (AoE is
  // UTC-12), which is enough to misreport a delta by a day.
  const nextTz = next == null ? null : norm(timezone) || norm(raw.timezone) || 'AoE';
  const hist = Array.isArray(raw.deadline_history) ? raw.deadline_history.slice() : [];

  if (hist.length === 0 && norm(raw.submission_deadline) != null) {
    const asOf = /\(as of (\d{4}-\d{2}-\d{2})\)/.exec(raw.deadline_notes || '')?.[1];
    // The outgoing value belongs to the zone the entry carries right now, before
    // the caller overwrites it.
    hist.push({
      value: norm(raw.submission_deadline),
      recorded: asOf || raw.added || today,
      timezone: norm(raw.timezone) || 'AoE',
    });
  }

  const tail = hist.length ? hist[hist.length - 1] : null;
  // Compare zone as well as text: the same wall-clock string in a different zone
  // is a real move (e.g. "2026-08-05 00:00" AoE -> UTC brings it 12h earlier), and
  // must not be swallowed as a no-op.
  if (tail && norm(tail.value) === next && (norm(tail.timezone) || null) === nextTz) return false;

  hist.push(nextTz == null ? { value: next, recorded: today } : { value: next, recorded: today, timezone: nextTz });
  raw.deadline_history = hist;
  return true;
}

/**
 * Resolve one raw workshop record into the shape the site renders.
 * When a workshop has no explicit workshop_date, the end date of its
 * conference edition (data/editions.yml, via `editionEnds` keyed
 * `conference-year`) stands in for it — so deadline-unknown workshops turn
 * "Past" the day their conference ends. Years missing from editions.yml fall
 * back to the last day of the conference's `typical_month` (1-12, via
 * `confMonths`) as a coarser estimate.
 */
export function resolveWorkshop({ slug, file, raw }, nowMs = Date.now(), confMonths = {}, editionEnds = {}) {
  // Multi-track workshops (e.g. MARINE/Full + MARINE/Short) carry a `tracks`
  // list. The headline deadline rolls to the SOONEST track still in the
  // future, so once an earlier track closes the next one takes over on the
  // next build. Status follows the actionability rule:
  //   any future track        -> upcoming (Open call)
  //   else any TBA track      -> Deadline unknown (a track may still open)
  //   else (all closed)       -> Past
  let effectiveDeadline = raw.submission_deadline;
  let effectiveTimezone = raw.timezone;
  let trackStatusOverride = null;
  let resolvedTracks = null;
  if (Array.isArray(raw.tracks) && raw.tracks.length) {
    resolvedTracks = raw.tracks.map((t) => {
      const ms = t.submission_deadline ? resolveDeadlineUtcMs(t.submission_deadline, t.timezone || 'AoE') : null;
      return {
        name: t.name,
        submission_deadline: t.submission_deadline || null,
        timezone: t.timezone || (t.submission_deadline ? 'AoE' : undefined),
        deadlineUtcMs: ms,
        deadlineWallClock: t.submission_deadline
          ? formatDeadlineWallClock(t.submission_deadline, t.timezone || 'AoE')
          : null,
        passed: ms != null && nowMs > ms,
      };
    });
    const future = resolvedTracks.filter((t) => t.deadlineUtcMs != null && t.deadlineUtcMs >= nowMs);
    const tba = resolvedTracks.filter((t) => t.deadlineUtcMs == null);
    if (future.length) {
      // soonest future track is the headline
      const soonest = future.reduce((a, b) => (a.deadlineUtcMs <= b.deadlineUtcMs ? a : b));
      effectiveDeadline = soonest.submission_deadline;
      effectiveTimezone = soonest.timezone;
      trackStatusOverride = 'upcoming';
    } else if (tba.length) {
      // an announced track has closed but another is still pending -> unknown
      effectiveDeadline = null;
      effectiveTimezone = undefined;
      trackStatusOverride = 'deadline_unknown';
    } else {
      // every track announced and all passed
      const latest = resolvedTracks.reduce((a, b) => (a.deadlineUtcMs >= b.deadlineUtcMs ? a : b));
      effectiveDeadline = latest.submission_deadline;
      effectiveTimezone = latest.timezone;
      trackStatusOverride = 'past';
    }
  }

  const deadlineUtcMs = effectiveDeadline
    ? resolveDeadlineUtcMs(effectiveDeadline, effectiveTimezone || 'AoE')
    : null;
  let workshopDateUtcMs = raw.workshop_date ? parseDateUtcMs(raw.workshop_date) : null;
  if (workshopDateUtcMs == null && editionEnds[`${raw.conference}-${raw.year}`] != null) {
    workshopDateUtcMs = editionEnds[`${raw.conference}-${raw.year}`];
  }
  if (workshopDateUtcMs == null && confMonths[raw.conference]) {
    // Last day of the conference's typical month (month index = typical_month -> day 0 of next).
    workshopDateUtcMs = Date.UTC(raw.year, confMonths[raw.conference], 0);
  }
  // Abstract-registration instant (always stored as UTC wall-clock, so it is
  // independent of the entry's `timezone`, which applies to the paper deadline).
  const abstractDeadlineUtcMs = raw.abstract_deadline
    ? resolveDeadlineUtcMs(raw.abstract_deadline, 'UTC')
    : null;
  // The abstract stage is "open" only while it is still ahead of us; once it
  // passes, the next thing to act on is the paper deadline.
  const abstractStageOpen = abstractDeadlineUtcMs != null && nowMs <= abstractDeadlineUtcMs;
  let status = computeStatus({ deadlineUtcMs, workshopDateUtcMs, year: raw.year }, nowMs);
  // Track-derived status wins: it encodes the actionability rule above and
  // must not be overridden by the date/edition fallback (which would wrongly
  // mark a closed-Full + TBA-Short workshop "Past").
  if (trackStatusOverride === 'upcoming') status = 'upcoming';
  else if (trackStatusOverride === 'deadline_unknown') status = status === 'past' ? 'past' : 'upcoming';
  // ^ "deadline_unknown" intent: keep it out of Open call (no actionable date)
  //   but not Past unless the conference itself is over. Label resolves to
  //   "Deadline unknown" below because deadlineUtcMs is null.

  return {
    ...raw,
    slug,
    file,
    timezone: effectiveTimezone || (effectiveDeadline ? 'AoE' : undefined),
    deadlineUtcMs,
    deadlineIso: deadlineUtcMs != null ? new Date(deadlineUtcMs).toISOString() : null,
    deadlineWallClock: effectiveDeadline
      ? formatDeadlineWallClock(effectiveDeadline, effectiveTimezone || 'AoE')
      : null,
    // Two-stage venues gate paper submission behind an earlier MANDATORY
    // abstract registration. Both dates are always rendered, and the headline
    // date below (`deadlineWallClock` / `deadlineUtcMs`) is ALWAYS the paper
    // deadline — the canonical submission deadline used for status, feeds and
    // the public API. The COUNTDOWN instead follows whichever stage is next
    // (`nextStage*`), because that is the date you actually have to act on, and
    // it is rendered with an explicit "abstract" label. Labelling plus keeping
    // both dates visible is what stops the switch from the abstract date to the
    // later paper date from reading as a deadline extension.
    abstractDeadlineUtcMs: abstractDeadlineUtcMs,
    abstractDeadlineWallClock: raw.abstract_deadline
      ? formatDeadlineWallClock(raw.abstract_deadline, 'UTC')
      : null,
    // ISO form so the client can show "Your time: …" for the abstract stage
    // exactly as it does for the paper deadline (.js-local[data-iso]).
    abstractDeadlineIso: abstractDeadlineUtcMs != null ? new Date(abstractDeadlineUtcMs).toISOString() : null,
    abstractDeadlinePassed: abstractDeadlineUtcMs != null ? nowMs > abstractDeadlineUtcMs : null,
    nextStageUtcMs: abstractStageOpen ? abstractDeadlineUtcMs : deadlineUtcMs,
    nextStageIso: abstractStageOpen
      ? new Date(abstractDeadlineUtcMs).toISOString()
      : deadlineUtcMs != null
        ? new Date(deadlineUtcMs).toISOString()
        : null,
    nextStageIsAbstract: abstractStageOpen,
    tracks: resolvedTracks,
    // Deadline provenance. `deadlineChange` is the single latest notable move,
    // shown inline on the board; `deadlineHistoryView` is the full audit trail
    // for the workshop page. Both are read-only derivations of
    // `raw.deadline_history` — nothing here affects status, feeds or the API.
    deadlineChange: deriveDeadlineChange(
      raw.deadline_history,
      nowMs,
      // Each logged value is interpreted in the zone it was recorded in; entries
      // written before that was stored fall back to the entry's current zone.
      (v, tz) => resolveDeadlineUtcMs(v, tz || effectiveTimezone || raw.timezone || 'AoE'),
      (v, tz) => formatDeadlineWallClock(v, tz || effectiveTimezone || raw.timezone || 'AoE'),
    ),
    deadlineHistoryView: Array.isArray(raw.deadline_history)
      ? raw.deadline_history
          .map((h) => ({
            recorded: h.recorded,
            recordedLabel: formatDateYmd(h.recorded),
            wallClock: h.value
              ? formatDeadlineWallClock(h.value, h.timezone || effectiveTimezone || raw.timezone || 'AoE')
              : null,
          }))
          .reverse()
      : [],
    workshopDateUtcMs,
    workshopDateLabel: raw.workshop_date ? formatDateYmd(raw.workshop_date) : null,
    notificationDateLabel: raw.notification_date ? formatDateYmd(raw.notification_date) : null,
    status,
  };
}

/** Load every workshop, resolved. Invalid YAML throws (CI catches it first). */
/* ------------------------------------------------------------- locations -- */

/**
 * Where a workshop is, tidied for display.
 *
 * OpenReview publishes `location` as free text and nobody normalises it, so one
 * city arrives under many names. These are real values from a single crawl:
 *
 *   Pittsburgh, PA, USA (8) · Pittsburgh, Pennsylvania, USA (7)
 *   Pittsburgh, Pennsylvania, United States (6) · Pittsburgh, USA (6)
 *   Pittsburgh (4) · Pittsburgh, PA (4)
 *   Malmö, Sweden (63) · Malmo, Sweden (15) · Malmo, Sweeden (1)
 *
 * Rendering those verbatim puts six Pittsburghs and a visible "Sweeden" typo on
 * the site. So spellings are grouped by city and the **most frequent original**
 * is shown for the whole group.
 *
 * Frequency rather than a hand-written alias table: the table would need editing
 * every time a conference moves city or an organiser invents a new abbreviation,
 * and the crowd is already right — "Malmö, Sweden" outnumbers the typo 63 to 1.
 * The raw value stays in the YAML, so this can be improved by rebuilding rather
 * than by migrating data.
 */

/** The comma-separated pieces of a location, with a leading "ECCV 2026" dropped. */
function segments(raw) {
  let parts = String(raw ?? '').trim().split(',').map((p) => p.trim()).filter(Boolean);
  // "ECCV 2026, Malmö, Sweden" — a leading segment carrying a four-digit year
  // is the conference, not a place; keep it and this keys on "eccv 2026".
  while (parts.length > 1 && /\d{4}/.test(parts[0])) parts = parts.slice(1);
  return parts;
}

const fold = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // Malmö -> Malmo, so both spellings group
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Fold a display value down to the city it names, for grouping only. */
export function locationKey(raw) {
  const parts = segments(raw);
  return parts.length ? fold(parts[0]) : '';
}

/**
 * Map each raw location to `{ label, key }` — the spelling to display, and the
 * place identity used to decide whether a conference is split.
 *
 * Two shapes have to be told apart, and only the corpus can do it:
 *
 *   "Sydney, Australia"       a city and its country
 *   "Sydney, Paris, Atlanta"  one workshop running at all three NeurIPS sites
 *
 * Both begin with Sydney, so a first-segment rule would file the second as
 * "Sydney" and tell a reader the workshop is somewhere it only partly is. The
 * giveaway is that its later segments are themselves cities *other workshops
 * are in*, which "Australia" never is. So single-city values are collected
 * first, then anything naming two or more of them is left exactly as written.
 */
export function canonicalLocations(rawValues) {
  const values = [...rawValues].map((v) => String(v ?? '').trim()).filter(Boolean);

  // Pass 1: the cities, taken from first segments.
  const cityKeys = new Set(values.map(locationKey).filter(Boolean));

  // Pass 2: a value naming two or more known cities is a multi-site listing.
  const isMultiCity = (raw) => {
    const parts = segments(raw);
    if (parts.length < 2) return false;
    return parts.filter((p) => cityKeys.has(fold(p))).length >= 2;
  };

  const counts = new Map();
  for (const v of values) {
    const key = isMultiCity(v) ? `multi:${fold(v)}` : locationKey(v);
    if (!key) continue;
    if (!counts.has(key)) counts.set(key, new Map());
    counts.get(key).set(v, (counts.get(key).get(v) ?? 0) + 1);
  }

  // Pass 3: absorb the long tail. Real values include "Sidney, Australia" once
  // against 57 Sydneys, and "NeurIPS Paris 2026" — a venue name rather than a
  // city. Left alone each becomes its own place, which is not merely untidy:
  // `locationDistinguishes` counts places, so one typo could make a
  // single-city conference look split and mark every card in it.
  //
  // Only a rare key is absorbed, and only into one at least five times as
  // common, so this can correct a slip but cannot merge two cities that both
  // genuinely host workshops.
  const total = (k) => [...(counts.get(k)?.values() ?? [])].reduce((a, b) => a + b, 0);
  const byFreq = [...counts.keys()].sort((a, b) => total(b) - total(a));
  const mergedInto = new Map();
  for (const rare of byFreq) {
    if (rare.startsWith('multi:')) continue;
    for (const common of byFreq) {
      if (common === rare || common.startsWith('multi:')) continue;
      if (total(common) < total(rare) * 5) continue;
      const contains = rare.split(' ').includes(common) || common.split(' ').includes(rare);
      if (contains || withinOneEdit(rare, common)) {
        mergedInto.set(rare, mergedInto.get(common) ?? common);
        const target = counts.get(mergedInto.get(rare));
        for (const [v, n] of counts.get(rare)) target.set(v, (target.get(v) ?? 0) + n);
        counts.delete(rare);
        break;
      }
    }
  }
  const resolveKey = (k) => mergedInto.get(k) ?? k;

  const labelFor = new Map();
  for (const [key, m] of counts) {
    let best = null;
    let bestN = -1;
    // Ties go to the longer string: "Sydney, Australia" over a bare "Sydney".
    // Without that the label could flip between builds on equal counts.
    for (const [v, n] of m) {
      if (n > bestN || (n === bestN && v.length > (best ?? '').length)) { best = v; bestN = n; }
    }
    labelFor.set(key, best);
  }

  // Some values name no place at all. A real one is literally "NeurIPS 2026":
  // the conference and the year, with no city in it. "NeurIPS Paris 2026" looks
  // similar but does name one, and has already been absorbed into Paris by the
  // pass above — so what is left carrying a year, and still standing alone, is
  // not a location. Better to show nothing than to print a conference name in
  // the space reserved for a city.
  const isNotAPlace = (key) => !key.startsWith('multi:') && /\d{4}/.test(key) && !mergedInto.has(key);

  const out = new Map();
  for (const v of values) {
    const key = resolveKey(isMultiCity(v) ? `multi:${fold(v)}` : locationKey(v));
    if (key && !isNotAPlace(key)) out.set(v, { label: labelFor.get(key), key });
  }
  return out;
}

/** Levenshtein distance of at most one — enough for a single-letter slip. */
function withinOneEdit(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  // Too short and a one-letter difference is a different word, not a typo.
  if (Math.min(a.length, b.length) < 5) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/* ------------------------------------------------------------- relations -- */

/**
 * Which entries are the same workshop.
 *
 * OpenReview publishes some workshops as several top-level venues — NeurIPS
 * 2026 NeurReps is three: `NeurReps_Extended_Abstracts`, `NeurReps_Findings`,
 * `NeurReps_Proceedings` — so they become three files here, and a series
 * returns every year as a fresh venue. Nothing in the data links any of them.
 * The links are derived at load time instead of stored, because a stored link
 * would need a human to add it every crawl, and the corpus already knows:
 *
 *   - the same website is the same workshop ("neurreps.org" appears five
 *     times across 2024-2026, tracks included);
 *   - the same venue-id stem within one conference-year is the same workshop
 *     (`ATTRIB` / `ATTRIB_Late` — needed because siblings don't always share
 *     a website: ATTRIB_Late has none, IAB's competition track has its own);
 *   - the same *hostname* is the same workshop only sometimes. Real series
 *     use per-edition paths (latinxinai.org/icml-2024, .../neurips-2024), but
 *     real labs host unrelated workshops on one domain (dynsyslab.org,
 *     vap.aau.dk, pediamedai.com, opendrivelab.com) — so a hostname match
 *     must also share enough of the workshop's name to count.
 */

/** A website folded down to its identity: the address minus everything
 *  organisers vary between editions of the same page. */
export function websiteKey(url) {
  let s = String(url ?? '').trim().toLowerCase();
  if (!s) return null;
  s = s
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[#?].*$/, '')        // '#home', '#', '?authuser=1'
    .replace(/\/index\.html?$/, '');
  // Google Sites publishes the same site under /corp/view/... and /view/...,
  // and with or without a trailing /home. Same page, four spellings.
  if (s.startsWith('sites.google.com/')) {
    s = s.replace(/^sites\.google\.com\/corp\//, 'sites.google.com/').replace(/\/home$/, '');
  }
  s = s.replace(/\/+$/, '');
  // A scheme with nothing after it (the template's placeholder) is not a site.
  return s && s !== 'https:' && s !== 'http:' ? s : null;
}

/** Track-name vocabulary actually seen as venue-id suffixes in the corpus.
 *  Kept literal rather than clever: a new suffix style shows up as an unlinked
 *  sibling, which is the safe failure. */
const TRACK_SUFFIX =
  /[-_](non[-_]?)?(archival|proceedings?|findings|extended[-_]abstracts?|abstracts?|track([-_]\d+)?|main|tiny|tutorials?|late([-_](breaking|submissions))?|arr[-_]commitment|shared[-_]tasks?|fast|competition|paper|demonstration|position|community|early[-_]bird|rolling)$/i;

/**
 * Split a venue id into the workshop's stem and its track suffix.
 * `NeurIPS.cc/2026/Workshop/NeurReps_Findings` ->
 *   { key: 'neurips.cc/2026/workshop/neurreps', suffixLabel: 'Findings' }
 * The key keeps the full path, so it can only ever match within one
 * conference-year; the label is what the sibling link shows.
 */
export function venueFamily(venueId) {
  const parts = String(venueId ?? '').split('/').filter(Boolean);
  if (!parts.length) return null;
  const seg = parts[parts.length - 1];
  let base = seg;
  for (;;) {
    const m = TRACK_SUFFIX.exec(base);
    // Never strip a segment down to nothing (or near it): `Competition` alone
    // is a workshop's whole name somewhere, not a suffix of an empty stem.
    if (!m || m.index < 2) break;
    base = base.slice(0, m.index);
  }
  const suffix = seg.slice(base.length).replace(/^[-_]+/, '');
  const suffixLabel = suffix
    ? suffix
        .split(/[-_]+/)
        .map((word) => (word ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word))
        .join(' ')
    : null;
  return {
    key: [...parts.slice(0, -1), base].join('/').toLowerCase(),
    suffixLabel,
  };
}

/**
 * The short, self-identifying name for a workshop: what the site shows where an
 * entry has to name itself in one line — the page <title>, the saved list, feed
 * summaries. Returned in parts so callers can word the line their own way.
 *
 * Two things make the stored acronym unusable raw:
 *
 *  - It frequently repeats the conference and year ("COLM 2025 Workshop
 *    PragLM", "MELT Workshop @ COLM 2025"), which then reads twice wherever the
 *    caller supplies them itself.
 *  - Sibling tracks of one workshop share it, so a bare "CVEU" names two
 *    different CVPR 2026 pages and merges their groups on the saved list.
 *
 * So: strip the venue noise, then re-attach the track label that already
 * distinguishes siblings elsewhere in the UI. `full` is unique within a
 * conference-year — acronym_identity_test.mjs holds that true.
 */
const SHORT_NAME_MAX = 48;
const stripVenue = (str, confName, year) => {
  const c = String(confName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(str)
    .replace(new RegExp(`\\s*(?:@|at|,|:|-|—)?\\s*${c}\\s*${year}\\b`, 'ig'), ' ')
    .replace(new RegExp(`\\s*(?:@|at|,|:|-|—)?\\s*\\b${c}\\b`, 'ig'), ' ')
    .replace(new RegExp(`\\s*\\b${year}\\b`, 'g'), ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s:@,\-—|]+|[\s:@,\-—|]+$/g, '')
    .trim();
};
/** Trim at a word boundary, never ending on a dangling connective. */
const clipWords = (str, n) => {
  if (str.length <= n) return str;
  const sp = str.lastIndexOf(' ', n);
  return str
    .slice(0, sp > 20 ? sp : n)
    .replace(/[\s,:;-]+$/, '')
    .replace(/\s+(?:and|or|the|an?|of|for|to|in|on|with|using|from|towards?|at|by|via)$/i, '');
};
export function workshopShortName(w, confName) {
  const year = w.year;
  const carries = (str) => stripVenue(str, confName, year).replace(/workshop/gi, '').trim().length >= 2;
  const raw = String(w.acronym || w.name || '').trim();
  let base;
  if (carries(raw)) {
    base = clipWords(stripVenue(raw, confName, year), SHORT_NAME_MAX);
  } else {
    // The acronym was only the venue. Fall back to the name — but OpenReview
    // sometimes prefixes that with the conference's own formal title ("The
    // Thirty-Ninth Annual Conference on ... workshop: AI for ..."), so prefer
    // whatever follows the final colon.
    const full = String(w.name || '');
    const tail = full.slice(full.lastIndexOf(':') + 1).trim();
    const pick = tail.length >= 8 ? tail : full;
    base = carries(pick) ? clipWords(stripVenue(pick, confName, year), SHORT_NAME_MAX) : raw;
  }
  const track = w.trackLabel ?? null;
  return { base, track, full: track ? `${base} (${track})` : base };
}

/** Words that appear in workshop names without saying which workshop it is. */
const NAME_STOPWORDS = new Set([
  'the', 'a', 'an', 'workshop', 'workshops', 'on', 'for', 'of', 'in', 'at',
  'and', 'to', 'with', 'from', 'towards', 'toward', 'via', 'conjunction',
  'track', 'tracks', 'st', 'nd', 'rd', 'th', 'edition', 'annual',
  // Conference names locate an entry, they don't identify the workshop.
  'neurips', 'iclr', 'icml', 'cvpr', 'eccv', 'corl', 'colm', 'icra', 'iros',
  'cvf', 'ieee',
]);

/** The identifying words of a workshop name, for the hostname-tier guard. */
export function nameTokens(name) {
  return new Set(
    fold(name)
      .split(' ')
      .filter((t) => t && !NAME_STOPWORDS.has(t) && !/^\d+(st|nd|rd|th)?$/.test(t)),
  );
}

/** Hosts where sharing a domain means nothing about sharing a workshop. */
const GENERIC_HOSTS = new Set([
  'sites.google.com', 'docs.google.com', 'drive.google.com', 'github.com',
  'codabench.org', 'kaggle.com', 'openreview.net', 'forms.gle',
  'neurips.cc', 'iclr.cc', 'icml.cc', 'thecvf.com', 'colmweb.org',
  'robot-learning.org', 'eventbrite.com', 'easychair.org',
]);

/**
 * Group the corpus into series and derive, for each entry, its sibling tracks
 * (same conference-year) and its other editions (everything else in the
 * series). Returns Map<slug, { relatedTracks, relatedEditions }>.
 *
 * Entries are expected resolved (deadlineWallClock/statusLabel present) so a
 * sibling link can show the sibling's deadline; tests feed plain fixtures.
 */
export function computeRelations(entries) {
  const parent = entries.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const unite = (a, b) => { parent[find(a)] = find(b); };

  // Tier 1: the same website is the same workshop.
  const bySiteKey = new Map();
  entries.forEach((e, i) => {
    const k = websiteKey(e.website);
    if (!k) return;
    if (!bySiteKey.has(k)) bySiteKey.set(k, []);
    bySiteKey.get(k).push(i);
  });
  for (const idxs of bySiteKey.values()) {
    for (let j = 1; j < idxs.length; j++) unite(idxs[0], idxs[j]);
  }

  // Tier 2: the same venue-id stem within one conference-year. Simulated over
  // the whole corpus this produced ~30 groups, all true siblings — the venue
  // path embeds conference and year, so unrelated workshops can't collide.
  const byFamily = new Map();
  entries.forEach((e, i) => {
    const f = venueFamily(e.openreview_venue_id);
    if (!f) return;
    const k = `${e.conference}|${e.year}|${f.key}`;
    if (!byFamily.has(k)) byFamily.set(k, []);
    byFamily.get(k).push(i);
  });
  for (const idxs of byFamily.values()) {
    for (let j = 1; j < idxs.length; j++) unite(idxs[0], idxs[j]);
  }

  // Tier 3: same hostname, different paths — per-edition URLs on one domain.
  // Guarded, because labs host unrelated workshops on one domain: two groups
  // merge only when their names share identity, not just an address.
  const byHost = new Map();
  for (const [k, idxs] of bySiteKey) {
    const host = k.split('/')[0];
    if (GENERIC_HOSTS.has(host)) continue;
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(idxs);
  }
  const tokensOf = (idxs) => {
    const out = new Set();
    for (const i of idxs) for (const t of nameTokens(entries[i].name)) out.add(t);
    return out;
  };
  const namesAgree = (a, b) => {
    let shared = 0;
    for (const t of a) if (b.has(t)) shared++;
    if (shared >= 2) return true;
    // One-token names ("MetaFood") can never share two; Jaccard catches them.
    const unionSize = a.size + b.size - shared;
    return unionSize > 0 && shared / unionSize >= 0.5;
  };
  for (const groups of byHost.values()) {
    if (groups.length < 2) continue;
    const tokens = groups.map(tokensOf);
    for (let a = 0; a < groups.length; a++) {
      for (let b = a + 1; b < groups.length; b++) {
        if (find(groups[a][0]) === find(groups[b][0])) continue;
        if (namesAgree(tokens[a], tokens[b])) unite(groups[a][0], groups[b][0]);
      }
    }
  }

  // Components -> per-entry views.
  const members = new Map();
  entries.forEach((_, i) => {
    const r = find(i);
    if (!members.has(r)) members.set(r, []);
    members.get(r).push(i);
  });

  const out = new Map();
  for (const idxs of members.values()) {
    // A track label disambiguates editions only where a conference-year holds
    // more than one entry of the series; elsewhere it is noise.
    const perConfYear = new Map();
    for (const i of idxs) {
      const k = `${entries[i].conference}|${entries[i].year}`;
      perConfYear.set(k, (perConfYear.get(k) ?? 0) + 1);
    }
    const labelOf = (e) => venueFamily(e.openreview_venue_id)?.suffixLabel ?? null;
    for (const i of idxs) {
      const w = entries[i];
      const others = idxs.filter((j) => j !== i).map((j) => entries[j]);
      const relatedTracks = others
        .filter((e) => e.conference === w.conference && e.year === w.year)
        .map((e) => ({
          slug: e.slug,
          name: e.name,
          trackLabel: labelOf(e) ?? 'Main track',
          deadlineWallClock: e.deadlineWallClock ?? null,
          passed: e.statusLabel === 'Past',
        }))
        .sort((a, b) => a.slug.localeCompare(b.slug));
      const relatedEditions = others
        .filter((e) => e.conference !== w.conference || e.year !== w.year)
        .map((e) => ({
          slug: e.slug,
          name: e.name,
          conference: e.conference,
          year: e.year,
          trackLabel: (perConfYear.get(`${e.conference}|${e.year}`) ?? 0) > 1 ? labelOf(e) ?? 'Main track' : null,
        }))
        .sort(
          (a, b) =>
            b.year - a.year ||
            a.conference.localeCompare(b.conference) ||
            a.slug.localeCompare(b.slug),
        );
      out.set(w.slug, { relatedTracks, relatedEditions });
    }
  }
  return out;
}

export function loadWorkshops(nowMs = Date.now()) {
  const confMonths = Object.fromEntries(
    loadConferences().filter((c) => c.typical_month).map((c) => [c.id, c.typical_month]),
  );
  const editionEnds = Object.fromEntries(
    loadEditions()
      .filter((e) => e.end)
      .map((e) => [`${e.conference}-${e.year}`, parseDateUtcMs(e.end)]),
  );
  const all = listWorkshopFiles().map((f) => {
    const w = resolveWorkshop(readWorkshopFile(f), nowMs, confMonths, editionEnds);
    const cache = loadPaperCache(w.slug);
    w.paperCount = cache?.paper_count ?? 0;
    // Accepted papers prove the call closed — even when the venue never
    // published its deadline metadata (so we couldn't compute it). But skip
    // this for multi-track workshops with a still-pending (TBA) track: a
    // closed track having papers doesn't mean the pending track has closed.
    const hasPendingTrack = Array.isArray(w.tracks) && w.tracks.some((t) => t.deadlineUtcMs == null);
    if (w.status === 'upcoming' && w.deadlineUtcMs == null && w.paperCount > 0 && !hasPendingTrack) {
      w.status = 'deadline_passed';
    }
    w.statusLabel =
      w.status === 'past' || w.status === 'deadline_passed' ? 'Past'
      : w.deadlineUtcMs == null ? 'Deadline unknown'
      : 'Open call';
    return w;
  });

  // Tidy locations across the whole corpus at once — the only place with enough
  // context to know which of six Pittsburgh spellings is the common one.
  const canon = canonicalLocations(all.map((w) => w.location).filter(Boolean));
  const placeOf = (w) => (w.location ? canon.get(w.location)?.key ?? null : null);
  // Which conference-years are actually split across places. NeurIPS 2026 runs
  // in Sydney, Paris and Atlanta; ECCV 2026 is entirely in Malmö. The board
  // marks the first and stays quiet about the second, because a label repeated
  // on all 84 cards of a single-city conference is furniture, not information.
  const places = new Map();
  for (const w of all) {
    if (!w.location) continue;
    const ck = `${w.conference}-${w.year}`;
    if (!places.has(ck)) places.set(ck, new Set());
    const place = placeOf(w);
    if (place) places.get(ck).add(place);
  }
  for (const w of all) {
    w.locationLabel = w.location ? canon.get(w.location)?.label ?? null : null;
    w.locationDistinguishes = !!w.locationLabel && (places.get(`${w.conference}-${w.year}`)?.size ?? 0) > 1;
  }

  // Link each entry to its sibling tracks and other editions — another
  // whole-corpus derivation, since only the corpus knows what is related.
  const relations = computeRelations(all);
  for (const w of all) {
    const rel = relations.get(w.slug);
    w.relatedTracks = rel?.relatedTracks ?? [];
    w.relatedEditions = rel?.relatedEditions ?? [];
    // This entry's own track label, the counterpart of the sibling labels
    // above — null for a main track, and null when there are no siblings, so
    // it reads as "the thing that tells this apart from its siblings" and is
    // absent whenever nothing needs telling apart.
    w.trackLabel = w.relatedTracks.length
      ? venueFamily(w.openreview_venue_id)?.suffixLabel ?? null
      : null;
  }
  return all;
}

/** Sort: upcoming by soonest NEXT ACTIONABLE deadline (TBA last), others by year
 *  desc then name. Two-stage venues sort by their abstract-registration date
 *  while that stage is open — the same instant their countdown shows — so a
 *  row counting down "2d" can never appear below a row counting down "5d". */
export function sortByDeadline(workshops) {
  return [...workshops].sort((a, b) => {
    const da = a.nextStageUtcMs ?? a.deadlineUtcMs ?? Number.POSITIVE_INFINITY;
    const db = b.nextStageUtcMs ?? b.deadlineUtcMs ?? Number.POSITIVE_INFINITY;
    if (da !== db) return da - db;
    return (a.name || '').localeCompare(b.name || '');
  });
}

/** Load the cached OpenReview paper list for a workshop slug, or null. */
export function loadPaperCache(slug) {
  const p = path.join(CACHE_DIR, `${slug}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Load workshop *proposal* calls (data/proposal_calls.yml), resolved. */
export function loadProposalCalls(nowMs = Date.now()) {
  const p = path.join(REPO_ROOT, 'data', 'proposal_calls.yml');
  if (!fs.existsSync(p)) return [];
  const raw = yaml.load(fs.readFileSync(p, 'utf8'));
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c) => {
      const deadlineUtcMs = c.proposal_deadline
        ? resolveDeadlineUtcMs(c.proposal_deadline, c.timezone || 'AoE')
        : null;
      return {
        ...c,
        deadlineUtcMs,
        deadlineWallClock: c.proposal_deadline
          ? formatDeadlineWallClock(c.proposal_deadline, c.timezone || 'AoE')
          : null,
        open: deadlineUtcMs != null && deadlineUtcMs > nowMs,
      };
    })
    .sort((a, b) => (b.deadlineUtcMs ?? 0) - (a.deadlineUtcMs ?? 0));
}
