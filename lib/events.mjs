/**
 * Collapsing a week of deadline events into one row per workshop.
 *
 * A deadline can move more than once in seven days, and the event store records
 * each hop separately — correctly, because each was a real observation. But a
 * reader wants one line per workshop and the net effect: extended 7 days and
 * then 1 more is an 8-day extension, not two entries with different numbers.
 *
 * This is a derivation from recorded values, not an invention: the earliest
 * `old_utc` and the latest `new_utc` both come straight from the store, and the
 * day count is the distance between them. It is the same shape of derivation
 * `deriveDeadlineChange` already performs over a workshop's deadline_history.
 *
 * Pure and dependency-free for the same two reasons lib/identity.mjs is: the
 * digest renderer imports it and is bundled into the Worker (no `node:` builtins
 * available), and the site imports it too, so it cannot live under `alerts/`,
 * which must stay deletable. Because the Worker bundle spans this file,
 * .github/workflows/alerts-worker-deploy.yml lists it among the paths that
 * trigger a redeploy.
 */

const DAY_MS = 86_400_000;

const ms = (v) => {
  const t = v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};

/**
 * One event per slug, carrying the net change across the window.
 *
 * Order matters and is taken from the input: the feed is written in observation
 * order, so the first entry for a slug is its earliest hop and the last is its
 * most recent. Input order is preserved in the output, keyed on first
 * appearance, so a caller that sorts afterwards is unaffected.
 *
 * Rules:
 *   - A first-deadline event anywhere in a slug's run wins the kind. There was
 *     no previous date, so nothing can have "moved" — the net is simply that the
 *     workshop now has a deadline, and the latest value is what it is.
 *   - `announced` likewise: the workshop appearing is the news.
 *   - Otherwise the net runs from the earliest `old_utc` to the latest
 *     `new_utc`, and the direction follows the sign of that distance.
 *   - A net that rounds to zero days is dropped. A deadline that moved out and
 *     back is not a change this week, and "+0d" says nothing true.
 *
 * @param {Array<{slug:string,kind:string,days:number|null,old_utc:string|null,new_utc:string|null}>} events
 * @returns {Array} one merged event per slug, in first-appearance order
 */
export function mergeEventsBySlug(events) {
  const runs = new Map();
  for (const e of Array.isArray(events) ? events : []) {
    if (!e?.slug) continue;
    if (!runs.has(e.slug)) runs.set(e.slug, []);
    runs.get(e.slug).push(e);
  }

  const out = [];
  for (const [slug, run] of runs) {
    if (run.length === 1) {
      out.push(run[0]);
      continue;
    }

    // The workshop appearing, or getting its first date, outranks any later
    // movement of that date.
    const announced = run.find((e) => e.kind === 'announced');
    const first = run.find((e) => e.kind === 'deadline_announced');
    const last = run[run.length - 1];
    if (announced) {
      out.push({ ...announced, new_utc: last.new_utc ?? announced.new_utc });
      continue;
    }
    if (first) {
      out.push({ ...first, kind: 'deadline_announced', days: null, old_utc: null, new_utc: last.new_utc ?? first.new_utc });
      continue;
    }

    const from = ms(run[0].old_utc);
    const to = ms(last.new_utc);
    if (from == null || to == null) {
      // Not enough recorded to net anything out; the most recent hop stands.
      out.push(last);
      continue;
    }
    const days = Math.round(Math.abs(to - from) / DAY_MS);
    if (days < 1) continue; // moved out and back: no change this week
    out.push({
      ...last,
      kind: to > from ? 'extended' : 'earlier',
      days,
      old_utc: run[0].old_utc,
      new_utc: last.new_utc,
    });
  }
  return out;
}
