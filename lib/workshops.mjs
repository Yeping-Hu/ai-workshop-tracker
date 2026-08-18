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

  const out = new Map();
  for (const v of values) {
    const key = resolveKey(isMultiCity(v) ? `multi:${fold(v)}` : locationKey(v));
    if (key) out.set(v, { label: labelFor.get(key), key });
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
  const placeOf = (w) => (w.location ? canon.get(w.location)?.key ?? locationKey(w.location) : null);
  // Which conference-years are actually split across places. NeurIPS 2026 runs
  // in Sydney, Paris and Atlanta; ECCV 2026 is entirely in Malmö. The board
  // marks the first and stays quiet about the second, because a label repeated
  // on all 84 cards of a single-city conference is furniture, not information.
  const places = new Map();
  for (const w of all) {
    if (!w.location) continue;
    const ck = `${w.conference}-${w.year}`;
    if (!places.has(ck)) places.set(ck, new Set());
    places.get(ck).add(placeOf(w));
  }
  for (const w of all) {
    w.locationLabel = w.location ? canon.get(w.location)?.label ?? w.location : null;
    w.locationDistinguishes = !!w.location && (places.get(`${w.conference}-${w.year}`)?.size ?? 0) > 1;
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
