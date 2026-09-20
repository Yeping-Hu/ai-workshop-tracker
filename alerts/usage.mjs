/**
 * The paper matcher's daily tally — how often /match was used, and what it
 * spent on Jev. The dashboard's "Paper matcher" card reads it; nothing else does.
 *
 * **A number per day, and nothing of the request.** /match promises that a
 * title and abstract are judged and discarded, and this keeps the promise: a
 * row here is a day, a counter name and an integer. No address, no hash of
 * one, no title, no topic, no timestamp finer than the day. It answers "is
 * anyone using this, and what does it cost" and cannot answer "who" or "what
 * about".
 *
 * **Rows in `kv`, not a table of their own.** A new table is a manual
 * migration against production D1 (the deploy workflow applies no schema, on
 * purpose), and until someone ran it every search would fail to count. `kv`
 * exists everywhere the Worker does, a counter is a key and a value, and the
 * key sorts by day — so the first search after a deploy is counted with no
 * step in between. Key: `matchuse:<YYYY-MM-DD>:<counter>`; value: the integer
 * as text, which is what the column holds.
 *
 * **Counted only past Turnstile.** A request that fails the challenge is not a
 * person using the matcher, and counting it would hand anyone with `curl` a
 * D1 write per request against the free plan's daily allowance. Everything
 * counted here cost its sender a solved challenge.
 *
 * **Counting never fails a search.** `bumpUsage` swallows every error and
 * reports it in its return value; a tally that is short by one is a better
 * outcome than a visitor told the matcher is broken because a counter was.
 *
 * Pure apart from the database handed in: no Node built-ins, so it runs in
 * the Worker and under `scripts/alerts_usage_test.mjs` alike.
 */

import { JEV_USD_PER_MTOK } from '../lib/jev.mjs';

export const USAGE_PREFIX = 'matchuse:';

/**
 * The closed set of counters. A day's three outcomes are exclusive — a search
 * is one of them — and the last two are what the answered and failed ones
 * spent between them.
 *
 *   answered      Jev judged the paper and matches went back (partial included)
 *   failed        past every gate, and the visitor got "unavailable": no feed,
 *                 or the model did not answer
 *   turned_away   stopped by the hourly per-address limit or the daily brake
 *   jev_requests  calls to Jev that returned an answer (billed ones)
 *   input_tokens  what those calls were billed for; output tokens are free
 */
export const USAGE_COUNTERS = ['answered', 'failed', 'turned_away', 'jev_requests', 'input_tokens'];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const usageKey = (day, counter) => `${USAGE_PREFIX}${day}:${counter}`;

/** `matchuse:2026-09-19:answered` -> { day, counter }, or null for anything else. */
export function parseUsageKey(k) {
  const raw = String(k ?? '');
  if (!raw.startsWith(USAGE_PREFIX)) return null;
  const day = raw.slice(USAGE_PREFIX.length, USAGE_PREFIX.length + 10);
  const counter = raw.slice(USAGE_PREFIX.length + 11);
  if (!DAY_RE.test(day) || raw[USAGE_PREFIX.length + 10] !== ':' || !USAGE_COUNTERS.includes(counter)) return null;
  return { day, counter };
}

/**
 * Atomic in one statement, so two searches in the same millisecond both count.
 * Binds: key, amount, amount. `v` is a TEXT column shared with the snapshot,
 * so the sum is done on integers and stored as text — and the amount is cast
 * too, because a JavaScript number binds as a REAL and the row would otherwise
 * read "9330.0" (node:sqlite does this; the test caught it).
 */
export const BUMP_SQL =
  'INSERT INTO kv (k, v) VALUES (?, CAST(CAST(? AS INTEGER) AS TEXT)) ' +
  'ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + CAST(? AS INTEGER) AS TEXT)';

/** Everything older than the retention, by key range — the key sorts by day. */
export const PRUNE_SQL = `DELETE FROM kv WHERE k >= '${USAGE_PREFIX}' AND k < ?`;

/** The bind for PRUNE_SQL: rows for days before `todayIso - keepDays` go. */
export function pruneBefore(todayIso, keepDays) {
  const end = Date.parse(`${todayIso}T00:00:00Z`);
  if (!Number.isFinite(end)) return USAGE_PREFIX; // deletes nothing: no key sorts below the bare prefix
  return `${USAGE_PREFIX}${new Date(end - keepDays * 86_400_000).toISOString().slice(0, 10)}`;
}

/**
 * `{answered: 1, input_tokens: 5230}` -> the writes to make. Unknown names,
 * zeros, negatives and non-numbers are dropped rather than written, so a
 * caller's bug cannot mint a counter the dashboard has never heard of.
 */
export function usageWrites(day, counts) {
  if (!DAY_RE.test(String(day ?? ''))) return [];
  const out = [];
  for (const counter of USAGE_COUNTERS) {
    const by = Math.floor(Number(counts?.[counter]));
    if (Number.isFinite(by) && by > 0) out.push({ k: usageKey(day, counter), by });
  }
  return out;
}

/**
 * Add `counts` to `day`'s tally. `db` is a D1 binding (or anything with its
 * `prepare().bind()` and `batch()`). Resolves `{ ok, error? }` and never
 * throws — see the header.
 */
export async function bumpUsage(db, day, counts) {
  try {
    const writes = usageWrites(day, counts);
    if (!writes.length) return { ok: true };
    await db.batch(writes.map((w) => db.prepare(BUMP_SQL).bind(w.k, w.by, w.by)));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/**
 * Rows of {day, counter, n} (alerts/stats.mjs `SQL.matchUsage`) to what the
 * dashboard shows: a total per counter, the spend, and a gap-filled series of
 * searches per day. `todayIso` is passed in so this stays pure.
 *
 * The series is of *searches* — answered plus failed — because that is how
 * many times someone used the matcher; whether Jev held up its end is the
 * `failed` figure beside it. Turned-away requests are not searches: nothing
 * was asked.
 */
export function foldUsage(rows, n, todayIso) {
  const end = Date.parse(`${todayIso}T00:00:00Z`);
  const span = Math.min(Math.max(Math.floor(Number(n)) || 30, 1), 3650);
  const perDay = new Map();
  if (Number.isFinite(end)) {
    for (let i = span - 1; i >= 0; i--) perDay.set(new Date(end - i * 86_400_000).toISOString().slice(0, 10), 0);
  }

  // The window is the series' own days, applied to every figure: the query
  // reaches one day further back than the chart draws, and a headline that
  // counted that day would disagree with the chart under it.
  const totals = Object.fromEntries(USAGE_COUNTERS.map((c) => [c, 0]));
  for (const row of rows ?? []) {
    const counter = String(row?.counter ?? '');
    const day = String(row?.day ?? '');
    const v = Number(row?.n) || 0;
    if (!(counter in totals) || !perDay.has(day) || v <= 0) continue;
    totals[counter] += v;
    if (counter === 'answered' || counter === 'failed') perDay.set(day, perDay.get(day) + v);
  }
  return {
    ...totals,
    searches: totals.answered + totals.failed,
    usd: (totals.input_tokens / 1e6) * JEV_USD_PER_MTOK,
    by_day: [...perDay.entries()].map(([day, count]) => ({ day, n: count })),
  };
}
