/**
 * Aggregates over the subscriber table — the only shape in which subscriber
 * data is allowed to leave the database.
 *
 * Two callers, one definition: scripts/alerts_stats.mjs (reads D1 directly
 * through wrangler, so it still answers when the Worker is down) and the
 * Worker's /admin/stats, which feeds the dashboard. They must agree, or the
 * dashboard and the terminal will quietly disagree about how many people are
 * subscribed and there will be no way to tell which is right.
 *
 * **Every statement here selects a COUNT, a date prefix, or a bucketed
 * timezone. None selects an address, and none may.** That is the property the
 * whole dashboard design rests on: the page is behind Cloudflare Access, but if
 * that were ever misconfigured, what leaks is numbers rather than people.
 * scripts/alerts_dashboard_test.mjs asserts it, so adding `email` to a query
 * here fails the build rather than shipping quietly.
 *
 * Pure: no I/O, no Node built-ins. Runs unchanged in a Worker and in node.
 */

/* `created` is written by the Worker as an ISO-8601 stamp ("…T12:00:00.000Z"),
 * so the cutoff is rendered in that same shape. SQLite's `datetime('now')`
 * gives "YYYY-MM-DD HH:MM:SS" — a space where the ISO form has a "T" — and a
 * string comparison of the two included every row on the cutoff day whatever
 * its time, because "T" sorts after " ". */
/** Days are interpolated into SQL, so they must be an integer, not a string. */
const days = (n) => {
  const d = Math.floor(Number(n));
  if (!Number.isFinite(d) || d < 1 || d > 3650) return 30;
  return d;
};

export const SQL = {
  /** One row: every top-level count, in a single pass over the table. */
  totals: () => `
    SELECT
      COUNT(*)                                                    AS total,
      SUM(CASE WHEN confirmed_at IS NOT NULL THEN 1 ELSE 0 END)   AS confirmed,
      SUM(CASE WHEN confirmed_at IS NULL THEN 1 ELSE 0 END)       AS pending,
      SUM(CASE WHEN suppressed_at IS NOT NULL THEN 1 ELSE 0 END)  AS suppressed,
      SUM(CASE WHEN cadence = 'off' THEN 1 ELSE 0 END)            AS paused,
      SUM(CASE WHEN scope = 'starred' THEN 1 ELSE 0 END)          AS saved_only,
      SUM(CASE WHEN tz IS NOT NULL AND tz != '' THEN 1 ELSE 0 END) AS with_tz
    FROM subscribers`,

  /** Who actually receives anything — the number that matters most. */
  mailable: () => `
    SELECT COUNT(*) AS n FROM subscribers
    WHERE confirmed_at IS NOT NULL AND suppressed_at IS NULL AND cadence != 'off'`,

  signupsSince: (n) => `
    SELECT COUNT(*) AS n FROM subscribers
    WHERE created >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${days(n)} days')`,

  /**
   * Ascending, unlike the terminal script's DESC — a chart reads left to right
   * through time, and reversing in the caller is one more place to get it wrong.
   */
  signupsByDay: (n) => `
    SELECT substr(created, 1, 10) AS day, COUNT(*) AS n
    FROM subscribers
    WHERE created >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${days(n)} days')
    GROUP BY day ORDER BY day ASC`,

  /** Raw cadence strings; fold them with foldCadence() rather than reading directly. */
  cadences: () => `
    SELECT cadence, COUNT(*) AS n FROM subscribers
    WHERE confirmed_at IS NOT NULL AND suppressed_at IS NULL
    GROUP BY cadence`,

  /**
   * Raw IANA zone names, bucketed by regionOf() in JS rather than SQL.
   *
   * The zone is what the browser reported at signup — no IP geolocation is
   * involved anywhere in this project, and none is needed to answer "roughly
   * where are these people".
   */
  timezones: () => `
    SELECT tz, COUNT(*) AS n FROM subscribers
    WHERE confirmed_at IS NOT NULL AND suppressed_at IS NULL
    GROUP BY tz`,
};

/**
 * `cadence` holds either a canonical CSV ('weekly,urgent') or one of four
 * legacy single keywords. Counting the raw strings would file 'weekly,urgent'
 * and 'weekly_urgent' as different things, so both are folded to flags.
 */
const LEGACY = {
  weekly: ['weekly'],
  weekly_urgent: ['weekly', 'urgent'],
  starred_changes: ['urgent', 'changes'],
  off: [],
};

export function foldCadence(rows) {
  const flags = { weekly: 0, urgent: 0, changes: 0 };
  for (const row of rows ?? []) {
    const raw = String(row.cadence ?? '');
    const kinds = LEGACY[raw] ?? raw.split(',').map((s) => s.trim());
    for (const k of kinds) if (k in flags) flags[k] += Number(row.n) || 0;
  }
  return flags;
}

/**
 * An IANA zone to a coarse region.
 *
 * Coarse on purpose. With a handful of subscribers, "Europe/Zurich × 1" names a
 * person about as well as their address does; a continent does not. It is also
 * all the question is really asking.
 */
const AREAS = {
  America: 'Americas',
  US: 'Americas',
  Canada: 'Americas',
  Mexico: 'Americas',
  Brazil: 'Americas',
  Chile: 'Americas',
  Cuba: 'Americas',
  Jamaica: 'Americas',
  Europe: 'Europe',
  GB: 'Europe',
  Eire: 'Europe',
  Portugal: 'Europe',
  Poland: 'Europe',
  Turkey: 'Europe',
  Asia: 'Asia',
  Israel: 'Asia',
  Japan: 'Asia',
  Singapore: 'Asia',
  Hongkong: 'Asia',
  ROK: 'Asia',
  PRC: 'Asia',
  Iran: 'Asia',
  Africa: 'Africa',
  Egypt: 'Africa',
  Libya: 'Africa',
  Australia: 'Oceania',
  Pacific: 'Oceania',
  NZ: 'Oceania',
};

export const UNKNOWN_REGION = 'Unknown';

export function regionOf(tz) {
  const raw = String(tz ?? '').trim();
  // NULL is a real state, not missing data: someone whose browser did not
  // report a zone gets UTC-only times, and is honestly unplaceable.
  if (!raw) return UNKNOWN_REGION;
  const area = raw.split('/')[0];
  if (AREAS[area]) return AREAS[area];
  // Atlantic, Indian, Antarctica, Arctic, Etc/*, UTC and anything the zone
  // database adds after this was written. Never throws on an unknown zone —
  // a dashboard must not 500 because someone travelled somewhere new.
  return 'Other';
}

/** Rows of {tz, n} to [{region, n}], largest first, Unknown last. */
export function foldRegions(rows) {
  const out = new Map();
  for (const row of rows ?? []) {
    const region = regionOf(row.tz);
    out.set(region, (out.get(region) ?? 0) + (Number(row.n) || 0));
  }
  return [...out.entries()]
    .map(([region, n]) => ({ region, n }))
    .sort((a, b) => {
      if (a.region === UNKNOWN_REGION) return 1;
      if (b.region === UNKNOWN_REGION) return -1;
      return b.n - a.n || a.region.localeCompare(b.region);
    });
}

/**
 * Fill gaps so a sparkline shows quiet days as flat rather than skipping them.
 * `todayIso` is passed in because this module must stay pure — the Worker and
 * the script both know what day it is; this does not need to.
 */
export function fillDays(rows, n, todayIso) {
  const byDay = new Map((rows ?? []).map((r) => [String(r.day), Number(r.n) || 0]));
  const end = Date.parse(`${todayIso}T00:00:00Z`);
  if (!Number.isFinite(end)) return (rows ?? []).map((r) => ({ day: r.day, n: Number(r.n) || 0 }));
  const out = [];
  for (let i = days(n) - 1; i >= 0; i--) {
    const day = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ day, n: byDay.get(day) ?? 0 });
  }
  return out;
}
