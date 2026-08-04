#!/usr/bin/env node
/**
 * Cross-checks OpenReview-backed deadlines against the live submission
 * invitation `duedate` and surfaces the ones a human should look at — the cases
 * the weekly auto-sync deliberately will NOT fix on its own:
 *
 *   1. human-conflict — a deadline a human curated (its note is no longer the
 *      bot's stamp) that now disagrees with OpenReview. The bot freezes such
 *      entries, so without this they diverge silently. Maintainer decides which
 *      to trust.
 *   2. bot-earlier   — a bot-managed deadline where OpenReview moved EARLIER.
 *      The sync is later-only (an earlier move is the dangerous direction, e.g.
 *      a transient bad read), so it's declined and never applied automatically.
 *      Maintainer confirms whether it's a real correction.
 *
 * Bot-managed later moves are applied automatically by the sync (not flagged),
 * and legacy "imported from OpenReview…" entries are skipped (discovery adopts
 * then syncs them) — so neither is fetched here, keeping call volume down.
 *
 * `--report <file>` writes a markdown summary for the weekly `deadline-review`
 * workflow to keep ONE self-maintaining issue up to date (empty report => the
 * workflow closes the issue). Network-tolerant: a venue whose duedate can't be
 * fetched (404 / 429 / down) is skipped, never failing the run.
 *
 * Usage:
 *   node scripts/deadline_crosscheck.mjs --recent                      # upcoming + recently-passed only
 *   node scripts/deadline_crosscheck.mjs --recent --report review.md   # + write the issue body
 *   node scripts/deadline_crosscheck.mjs --slug colm-2026-daih         # one workshop
 *   node scripts/deadline_crosscheck.mjs --strict                      # exit 1 if anything to review
 */
import fs from 'node:fs';
import { listWorkshopFiles, readWorkshopFile } from '../lib/workshops.mjs';
import { resolveDeadlineUtcMs } from '../lib/dates.mjs';
import { deadlineFromInvitation, parseGroupDeadline, syncedValue, LEGACY_IMPORT_NOTE } from './discover_openreview.mjs';
import { fetchGroupById } from './recheck_imminent.mjs';

// OpenReview wraps some content values as { value: … }; unwrap if so.
const val = (c, k) => {
  const x = c?.[k];
  return x && typeof x === 'object' && 'value' in x ? x.value : x;
};

const HOUR = 3_600_000;
const DAY = 86_400_000;
// Real UTC offsets are whole hours plus a handful of :30/:45 zones; AoE is -12h.
const OFFSET_STEPS_MIN = [60, 30, 15]; // whole, half, quarter hour
const NEAR_MS = 90_000;                // 90s tolerance for "lands on" an offset
const MAX_OFFSET_H = 14;               // largest real-world tz magnitude
// Gentle spacing between venue fetches. Each entry now costs a group lookup
// (for the authoritative `date` line) plus, only when that line has no
// deadline, an invitation lookup — so pacing is a little wider than when this
// job read invitations alone, to stay inside OpenReview's rate budget across
// ~200 entries. A throttled entry is warned about and skipped, never fatal.
const PACE_MS = 600;
const REVIEW_PAST_GRACE_MS = 14 * DAY; // keep reviewing a deadline until ~2 weeks past it

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/**
 * Decide whether a divergence needs human review, using the same provenance
 * rule the bot uses. Pure + exported for tests. Returns null (no review) or
 * { kind: 'human-conflict' | 'bot-earlier', diff }.
 */
export function reviewCategory({ notes, storedValue, storedMs, fetchedMs }) {
  if (storedMs == null || fetchedMs == null) return null;
  const diff = classifyDeadlineDiff(storedMs, fetchedMs);
  if (diff.kind === 'match') return null;
  if (notes === LEGACY_IMPORT_NOTE) return null;          // in transition: discovery adopts, then syncs
  const botManaged = syncedValue(notes) === storedValue;  // stamp still equals the stored value
  if (botManaged) {
    // Later moves are auto-applied by the weekly sync — not a review item.
    // Only an earlier move is declined (later-only) and needs a human eye.
    return fetchedMs < storedMs ? { kind: 'bot-earlier', diff } : null;
  }
  // Not legacy and not a matching bot stamp => a human curated this deadline.
  return { kind: 'human-conflict', diff };
}

/**
 * Is a deadline still worth a human's review — i.e. upcoming, or only recently
 * passed (within `graceMs`)? Once a deadline is comfortably behind us, a
 * disagreement with OpenReview is unactionable noise — nobody re-syncs a
 * workshop whose submission window closed months ago — so it's dropped from the
 * review scope (neither fetched nor listed). Pure + exported for tests.
 */
export function isWithinReviewWindow(deadlineMs, nowMs, graceMs = REVIEW_PAST_GRACE_MS) {
  return deadlineMs != null && deadlineMs >= nowMs - graceMs;
}

function buildReport(items) {
  if (!items.length) return '';
  const human = items.filter((i) => i.kind === 'human-conflict');
  const earlier = items.filter((i) => i.kind === 'bot-earlier');
  const line = (i) =>
    `- [ ] \`${i.file}\` — **${i.name}** (${i.conf} ${i.year}) — stored \`${i.stored} UTC\`, OpenReview \`${i.fetched} UTC\` — ${i.label}. ` +
    `Accept OpenReview: \`node scripts/resync_deadline.mjs --slug ${i.slug}\``;
  const out = [
    'These deadlines disagree with OpenReview and the bot will **not** change them on its own — they need your call.',
    'To accept OpenReview\'s value, run the **Re-sync deadline from OpenReview** workflow with the slug (or the command shown). To keep the stored value, just leave it.',
    '',
  ];
  if (human.length) {
    out.push('### Human-edited, now disagrees with OpenReview', '_You edited these, so auto-sync is frozen. Decide which to trust._', '');
    for (const i of human) out.push(line(i));
    out.push('');
  }
  if (earlier.length) {
    out.push('### OpenReview moved these *earlier*', '_The bot only moves deadlines later automatically (an earlier move can be a transient bad read). Confirm whether it\'s a real correction._', '');
    for (const i of earlier) out.push(line(i));
    out.push('');
  }
  out.push('_This issue is updated automatically by the weekly `deadline-review` workflow._');
  return out.join('\n') + '\n';
}

async function main() {
  const args = process.argv.slice(2);
  const recent = args.includes('--recent');
  const strict = args.includes('--strict');
  const slug = args.includes('--slug') ? args[args.indexOf('--slug') + 1] : null;
  const reportPath = args.includes('--report') ? args[args.indexOf('--report') + 1] : null;
  const nowMs = Date.now();

  let entries = listWorkshopFiles()
    .map(readWorkshopFile)
    .filter(({ raw }) => raw?.openreview_venue_id && raw?.submission_deadline);
  if (slug) entries = entries.filter((e) => e.slug === slug);
  // --recent scopes by *deadline relevance*, not conference year: a workshop
  // whose deadline is comfortably past (even if its year is the current one) is
  // not a review item, so it's neither fetched nor listed. Fixes the review
  // issue filling up with long-closed deadlines (e.g. CVPR/ICML deadlines that
  // passed months ago) and spares the weekly job a lookup per stale entry.
  else if (recent) {
    entries = entries.filter(({ raw }) =>
      isWithinReviewWindow(resolveDeadlineUtcMs(raw.submission_deadline, raw.timezone || 'UTC'), nowMs));
  }
  // Legacy entries are in transition (discovery adopts then syncs them) and are
  // never review items — skip them so they cost no network call.
  const toCheck = entries.filter((e) => slug || e.raw.deadline_notes !== LEGACY_IMPORT_NOTE);

  console.log(`Cross-checking ${toCheck.length} deadline(s) against live OpenReview duedates (skipping ${entries.length - toCheck.length} legacy)…\n`);

  const items = [];
  let checked = 0, skipped = 0;
  for (const { slug: s, file, raw } of toCheck) {
    let dl = null;
    try {
      // Use the SAME value precedence as every write path (discovery, recheck,
      // backfill): the group's free `date` line first, the submission
      // invitation's duedate only as a fallback. Reading the invitation alone
      // silently disagreed with what the syncs actually store on two-stage
      // venues, whose date line carries both
      //   "Abstract Registration: <early>, Submission Deadline: <later>"
      // while the invitation's duedate is the ABSTRACT date. That reported a
      // phantom "OpenReview moved this earlier" for every such workshop (ASCI,
      // AutoMLR, VERICODEGEN, EBMV) even though the stored paper deadline was
      // correct and in sync — pure review noise, and dangerous noise, since
      // "accept OpenReview" would have replaced a paper deadline with an
      // abstract-registration date.
      const g = await fetchGroupById(raw.openreview_venue_id);
      dl = g ? parseGroupDeadline(val(g.content ?? {}, 'date')) || (await deadlineFromInvitation(g)) : null;
    } catch {
      dl = null; // network / rate-limit / no invitation: skip, never fail
    }
    await sleep(PACE_MS);
    if (!dl) { skipped++; continue; }
    checked++;
    const storedMs = resolveDeadlineUtcMs(raw.submission_deadline, raw.timezone || 'UTC');
    const fetchedMs = resolveDeadlineUtcMs(dl.submission_deadline, 'UTC');
    const cat = reviewCategory({
      notes: raw.deadline_notes,
      storedValue: raw.submission_deadline,
      storedMs,
      fetchedMs,
    });
    if (!cat) continue;
    const item = {
      kind: cat.kind, slug: s, file,
      name: raw.name, conf: String(raw.conference || '').toUpperCase(), year: raw.year,
      stored: raw.submission_deadline, fetched: dl.submission_deadline, label: cat.diff.label,
    };
    items.push(item);
    const tag = cat.kind === 'human-conflict' ? '⚠ CONFLICT  ' : '•  EARLIER   ';
    console.log(`${tag} ${s}: stored ${item.stored} vs OpenReview ${item.fetched} UTC — ${item.label}`);
  }

  const report = buildReport(items);
  if (reportPath) {
    fs.writeFileSync(reportPath, report);
    console.log(`\nWrote ${items.length ? items.length + ' item(s)' : 'empty report'} to ${reportPath}.`);
  }
  console.log(`\nDone. ${checked} checked, ${items.length} to review, ${skipped} unfetchable.`);
  if (strict && items.length > 0) process.exit(1);
}

// Only run the CLI when invoked directly, so the pure helpers can be imported in
// tests without the module hitting the network.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
