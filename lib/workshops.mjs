/**
 * Loads and resolves all repository data (workshops, conferences, topics,
 * cached paper lists). Used by the Astro site at build time and by every
 * script. The repo root is derived from this file's location, so it works
 * from any working directory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
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
    tracks: resolvedTracks,
    workshopDateUtcMs,
    workshopDateLabel: raw.workshop_date ? formatDateYmd(raw.workshop_date) : null,
    notificationDateLabel: raw.notification_date ? formatDateYmd(raw.notification_date) : null,
    status,
  };
}

/** Load every workshop, resolved. Invalid YAML throws (CI catches it first). */
export function loadWorkshops(nowMs = Date.now()) {
  const confMonths = Object.fromEntries(
    loadConferences().filter((c) => c.typical_month).map((c) => [c.id, c.typical_month]),
  );
  const editionEnds = Object.fromEntries(
    loadEditions()
      .filter((e) => e.end)
      .map((e) => [`${e.conference}-${e.year}`, parseDateUtcMs(e.end)]),
  );
  return listWorkshopFiles().map((f) => {
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
}

/** Sort: upcoming by soonest deadline (TBA last), others by year desc then name. */
export function sortByDeadline(workshops) {
  return [...workshops].sort((a, b) => {
    const da = a.deadlineUtcMs ?? Number.POSITIVE_INFINITY;
    const db = b.deadlineUtcMs ?? Number.POSITIVE_INFINITY;
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
