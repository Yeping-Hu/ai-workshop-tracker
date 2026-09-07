/**
 * How often deadlines move — derived from the append-only `deadline_history`
 * across the whole corpus, never stored.
 *
 * The question a submitter actually has at 2am is "will this get extended?".
 * Nobody can answer it for one workshop, but the corpus can say what
 * happened to its neighbours: at NeurIPS 2026, two thirds of workshop
 * deadlines ended up later than first announced. That is the whole feature.
 *
 * Two rules, tried in order by `extensionInsight()`:
 *
 *   series      the workshop's own earlier editions (`relatedEditions`, the
 *               same identity the "Other editions" list uses) — "extended in
 *               3 of the last 4 editions we tracked". Needs MIN_SERIES_EDITIONS
 *               observed earlier editions. Logging began in the 2026 cycle, so
 *               this rule is dormant until 2027 and switches itself on as
 *               history accumulates; nothing per-workshop to wire.
 *   conference  the same conference-year — "so far at NeurIPS 2026, 66% of
 *               workshop deadlines were extended". Needs MIN_GROUP observed
 *               entries, and is shown only on an upcoming edition, because a
 *               past one has no decision left to support.
 *
 * What counts:
 *
 *   - The observation window starts at the earliest `recorded` date of any
 *     entry that is not a log's first value — i.e. the first change the
 *     automation actually saw. The first value is backfilled from the
 *     "(as of …)" stamp when a log is seeded (recordDeadlineObservation), so it
 *     can predate the logging itself; a deadline that closed before the window
 *     may have moved unobserved and is left out of both numerator and
 *     denominator. Derived from the data, so there is no constant to update.
 *   - An entry is *observed* iff it is not `not_running`, has a deadline, and
 *     that deadline is inside the window AND has passed. Closed only: an open
 *     deadline may still move, so counting it as "not extended" would
 *     understate the rate.
 *   - *Extended* means the NET move from the first logged value to the last is
 *     later by at least MIN_CHANGE_MS — the same floor deriveDeadlineChange()
 *     uses, so a timezone re-read never counts, and the same netting rule
 *     lib/events.mjs uses for the digest: out and back is not an extension.
 *   - The median is reported only from MIN_MEDIAN extended entries; a "median"
 *     of one number is a number wearing a costume.
 *
 * Pinned by scripts/extension_stats_test.mjs.
 */
import { MIN_CHANGE_MS } from './workshops.mjs';
import { resolveDeadlineUtcMs } from './dates.mjs';

const DAY_MS = 86_400_000;
/** Observed earlier editions needed before the series rule speaks. */
export const MIN_SERIES_EDITIONS = 2;
/** Observed entries a conference-year needs before its rate is shown. */
export const MIN_GROUP = 10;
/** Extended entries needed before a median is reported. */
export const MIN_MEDIAN = 3;

/**
 * Net move from the first logged value to the last.
 * @returns {{ deltaMs: number, days: number, kind: 'extended'|'earlier' } | null}
 */
export function netDeadlineMove(history, parse) {
  if (!Array.isArray(history)) return null;
  const dated = history.filter((h) => h && h.value != null && h.value !== '');
  if (dated.length < 2) return null;
  const first = dated[0];
  const last = dated[dated.length - 1];
  const from = parse(String(first.value), first.timezone);
  const to = parse(String(last.value), last.timezone);
  if (from == null || to == null || !Number.isFinite(from) || !Number.isFinite(to)) return null;
  const deltaMs = to - from;
  if (Math.abs(deltaMs) < MIN_CHANGE_MS) return null;
  return {
    deltaMs,
    days: Math.max(1, Math.round(Math.abs(deltaMs) / DAY_MS)),
    kind: deltaMs > 0 ? 'extended' : 'earlier',
  };
}

/** The parser resolveWorkshop() injects: each value in the zone it was recorded in. */
const parserFor = (w) => (v, tz) => resolveDeadlineUtcMs(v, tz || w.timezone || 'AoE');

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * Corpus-wide stats. `entries` are resolved workshops (loadWorkshops()) — the
 * fields read are slug, conference, year, status, deadlineUtcMs, timezone and
 * deadlineHistory.
 *
 * @returns {{ observedSince: string|null,
 *             bySlug: Map<string, { observed: boolean, extendedDays: number|null }>,
 *             byConferenceYear: Map<string, { observed: number, extended: number, rate: number, medianDays: number|null }> }}
 */
export function computeExtensionStats(entries, nowMs = Date.now()) {
  const bySlug = new Map();
  const byConferenceYear = new Map();
  const list = Array.isArray(entries) ? entries : [];

  let observedSince = null;
  for (const w of list) {
    const hist = Array.isArray(w.deadlineHistory) ? w.deadlineHistory : [];
    for (let i = 1; i < hist.length; i++) {
      const r = hist[i]?.recorded;
      if (typeof r === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r) && (observedSince == null || r < observedSince)) observedSince = r;
    }
  }
  if (observedSince == null) return { observedSince: null, bySlug, byConferenceYear };
  const sinceMs = Date.parse(`${observedSince}T00:00:00Z`);

  const groups = new Map(); // conf-year -> number[] of extension days, plus count
  for (const w of list) {
    const observed =
      w.status !== 'not_running' &&
      w.deadlineUtcMs != null &&
      w.deadlineUtcMs >= sinceMs &&
      w.deadlineUtcMs <= nowMs;
    let extendedDays = null;
    if (observed) {
      const move = netDeadlineMove(w.deadlineHistory, parserFor(w));
      if (move?.kind === 'extended') extendedDays = move.days;
    }
    bySlug.set(w.slug, { observed, extendedDays });
    if (!observed) continue;
    const key = `${w.conference}-${w.year}`;
    if (!groups.has(key)) groups.set(key, { observed: 0, days: [] });
    const g = groups.get(key);
    g.observed++;
    if (extendedDays != null) g.days.push(extendedDays);
  }
  for (const [key, g] of groups) {
    byConferenceYear.set(key, {
      observed: g.observed,
      extended: g.days.length,
      rate: g.days.length / g.observed,
      medianDays: g.days.length >= MIN_MEDIAN ? median(g.days) : null,
    });
  }
  return { observedSince, bySlug, byConferenceYear };
}

/**
 * The one line for a workshop page, or null when nothing honest can be said.
 * `resolveBySlug` maps a related edition's slug to its resolved entry (it is
 * only used to confirm the edition exists; the numbers come from `stats`).
 */
export function extensionInsight(w, stats, resolveBySlug = () => null) {
  if (!w || !stats || w.status === 'not_running') return null;

  const earlier = (w.relatedEditions ?? []).filter((e) => e.year < w.year && resolveBySlug(e.slug));
  const observedEarlier = earlier.map((e) => stats.bySlug.get(e.slug)).filter((s) => s?.observed);
  if (observedEarlier.length >= MIN_SERIES_EDITIONS) {
    const days = observedEarlier.map((s) => s.extendedDays).filter((d) => d != null);
    return {
      kind: 'series',
      editions: observedEarlier.length,
      extended: days.length,
      medianDays: days.length ? median(days) : null,
    };
  }

  if (w.status !== 'upcoming') return null;
  const g = stats.byConferenceYear.get(`${w.conference}-${w.year}`);
  if (!g || g.observed < MIN_GROUP) return null;
  return { kind: 'conference', conference: w.conference, year: w.year, ...g };
}

/**
 * The conference-year line for a hub: the latest year that clears MIN_GROUP,
 * or null. Independent of any one workshop's status — the hub is read while
 * a cycle is open and after it closes alike.
 */
export function conferenceInsight(conferenceId, years, stats) {
  if (!stats) return null;
  for (const year of [...new Set(years)].sort((a, b) => b - a)) {
    const g = stats.byConferenceYear.get(`${conferenceId}-${year}`);
    if (g && g.observed >= MIN_GROUP) return { kind: 'conference', conference: conferenceId, year, ...g };
  }
  return null;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One formatter for every surface, so the same fact never reads two ways. */
export function extensionSentence(insight, { confName } = {}) {
  if (!insight) return '';
  if (insight.kind === 'series') {
    const { editions, extended, medianDays } = insight;
    if (extended === 0) return `Not extended in any of the ${plural(editions, 'earlier edition')} we tracked.`;
    const by = extended === 1 ? `by ${plural(medianDays, 'day')}` : `median ${plural(medianDays, 'day')}`;
    return `Extended in ${extended} of the ${plural(editions, 'earlier edition')} we tracked (${by}).`;
  }
  const name = confName ?? insight.conference;
  const pct = Math.round(insight.rate * 100);
  const tail = insight.medianDays != null
    ? `median ${plural(insight.medianDays, 'day')}, across ${plural(insight.observed, 'closed call')}`
    : `across ${plural(insight.observed, 'closed call')}`;
  return `So far at ${name} ${insight.year}, ${pct}% of workshop deadlines were extended (${tail}).`;
}
