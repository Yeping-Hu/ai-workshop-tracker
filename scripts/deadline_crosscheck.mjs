#!/usr/bin/env node
/**
 * Cross-checks each OpenReview-backed deadline against the live submission
 * invitation `duedate` and flags likely *timezone-entry mistakes*.
 *
 * Why: deadlines are stored in UTC, but someone editing the YAML by hand may
 * paste a time as they saw it locally (OpenReview shows times in the viewer's
 * own zone) while leaving `timezone: UTC` — silently shifting the deadline by
 * their UTC offset. That makes the stored value differ from OpenReview's real
 * duedate by a near-whole-hour amount, which is the signature this check looks
 * for. It also catches deadlines the bot can no longer touch because a human
 * froze them (a human-edited value is never auto-re-synced).
 *
 * Classification is heuristic (see classifyDeadlineDiff) and intentionally
 * over-inclusive — it errs toward flagging, since every hit is a soft "please
 * verify", never an automatic edit:
 *   - match      : within ~a minute of OpenReview — fine.
 *   - tz-suspect : differs by ~a whole/half/quarter-hour offset (<=14h) and is
 *                  NOT ~a multiple of 24h — looks like a timezone slip. WARN.
 *   - changed    : differs by something else (e.g. ~a day) — most likely a real
 *                  extension/correction; reported for info, not warned.
 *
 * Network-tolerant: a venue whose duedate can't be fetched (404 / 429 / down)
 * is skipped, never failing the run. Exit code is 0 unless --strict is given and
 * at least one tz-suspect entry is found.
 *
 * Usage:
 *   node scripts/deadline_crosscheck.mjs                 # all venues, report only
 *   node scripts/deadline_crosscheck.mjs --recent        # current + next year only
 *   node scripts/deadline_crosscheck.mjs --slug <slug>   # one workshop
 *   node scripts/deadline_crosscheck.mjs --strict        # exit 1 on tz-suspect
 */
import { listWorkshopFiles, readWorkshopFile } from '../lib/workshops.mjs';
import { resolveDeadlineUtcMs } from '../lib/dates.mjs';
import { deadlineFromInvitation } from './discover_openreview.mjs';

const HOUR = 3_600_000;
const DAY = 86_400_000;
// Real UTC offsets are whole hours plus a handful of :30/:45 zones; AoE is -12h.
const OFFSET_STEPS_MIN = [60, 30, 15]; // whole, half, quarter hour
const NEAR_MS = 90_000;                // 90s tolerance for "lands on" an offset
const MAX_OFFSET_H = 14;               // largest real-world tz magnitude

/**
 * Classify the gap between a stored deadline and OpenReview's duedate (both UTC
 * ms). Pure + exported for tests. Returns { kind, diffMs, label }.
 *   kind ∈ { 'match', 'tz-suspect', 'changed', 'unknown' }
 */
export function classifyDeadlineDiff(storedMs, fetchedMs) {
  if (storedMs == null || fetchedMs == null) return { kind: 'unknown', diffMs: null, label: 'missing value' };
  const diff = fetchedMs - storedMs; // +ve => OpenReview is later than stored
  const abs = Math.abs(diff);
  if (abs <= NEAR_MS) return { kind: 'match', diffMs: diff, label: 'matches OpenReview' };
  // A near-multiple of 24h is a day-level shift (extension), not a tz slip.
  const dayRem = Math.abs(abs - Math.round(abs / DAY) * DAY);
  const isDayish = abs >= DAY - NEAR_MS && dayRem <= NEAR_MS;
  if (!isDayish) {
    for (const stepMin of OFFSET_STEPS_MIN) {
      const step = stepMin * 60_000;
      const k = Math.round(abs / step);
      if (k >= 1 && Math.abs(abs - k * step) <= NEAR_MS && k * step <= MAX_OFFSET_H * HOUR) {
        const h = (k * stepMin) / 60;
        const dir = diff > 0 ? 'stored is EARLIER than OpenReview' : 'stored is LATER than OpenReview';
        return { kind: 'tz-suspect', diffMs: diff, label: `off by ~${h}h (${dir})` };
      }
    }
  }
  return { kind: 'changed', diffMs: diff, label: `differs by ${(diff / DAY).toFixed(2)}d (likely a real change)` };
}

async function main() {
  const args = process.argv.slice(2);
  const recent = args.includes('--recent');
  const strict = args.includes('--strict');
  const slug = args.includes('--slug') ? args[args.indexOf('--slug') + 1] : null;
  const nowYear = new Date().getUTCFullYear();

  let entries = listWorkshopFiles()
    .map(readWorkshopFile)
    .filter(({ raw }) => raw?.openreview_venue_id && raw?.submission_deadline);
  if (slug) entries = entries.filter((e) => e.slug === slug);
  else if (recent) entries = entries.filter(({ raw }) => raw.year >= nowYear);

  console.log(`Cross-checking ${entries.length} OpenReview-backed deadline(s) against live duedates…\n`);

  let matched = 0, suspect = 0, changed = 0, skipped = 0;
  for (const { slug: s, raw } of entries) {
    let dl = null;
    try {
      dl = await deadlineFromInvitation({ id: raw.openreview_venue_id, content: {} });
    } catch {
      dl = null; // network / rate-limit / no invitation: skip, never fail
    }
    if (!dl) { skipped++; continue; }
    const storedMs = resolveDeadlineUtcMs(raw.submission_deadline, raw.timezone || 'UTC');
    const fetchedMs = resolveDeadlineUtcMs(dl.submission_deadline, 'UTC');
    const { kind, label } = classifyDeadlineDiff(storedMs, fetchedMs);
    if (kind === 'match') { matched++; continue; }
    if (kind === 'tz-suspect') {
      suspect++;
      console.log(`⚠ TZ-SUSPECT  ${s}: stored ${raw.submission_deadline} ${raw.timezone || 'UTC'}  vs  OpenReview ${dl.submission_deadline} UTC — ${label}`);
      console.log(`              → likely a wrong timezone on a manual edit. Re-pull the real value: node scripts/resync_deadline.mjs --slug ${s}`);
    } else if (kind === 'changed') {
      changed++;
      console.log(`•  changed     ${s}: stored ${raw.submission_deadline}  vs  OpenReview ${dl.submission_deadline} UTC — ${label}`);
    }
  }
  console.log(`\nDone. ${matched} match, ${suspect} tz-suspect, ${changed} changed, ${skipped} unfetchable.`);
  if (strict && suspect > 0) process.exit(1);
}

// Only run the CLI when invoked directly, so classifyDeadlineDiff can be
// imported in tests without the module hitting the network.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
