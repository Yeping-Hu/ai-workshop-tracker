#!/usr/bin/env node
/**
 * Tests for alerts/diff.mjs — the snapshot projection and event classifier that
 * decides what a weekly digest is allowed to claim happened.
 *
 * The two failure modes worth guarding are both about *fabricating* news:
 *
 *   - a first run with no snapshot would classify all ~750 workshops as newly
 *     announced and mail that to everyone;
 *   - a truncated or garbled /api/workshops.json would look like hundreds of
 *     workshops disappearing (and, on the next run, reappearing as "new").
 *
 * The third is subtler: this classifier must agree with the site. It mirrors
 * `deriveDeadlineChange` in lib/workshops.mjs — same MIN_CHANGE_MS threshold,
 * same max(1, round(days)) rounding — so an email can never report a move the
 * board itself suppresses. The rounding is asserted against the real function.
 *
 * Pure logic — no network. Run: node scripts/alerts_diff_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectFeed, diffSnapshot, deltaDays, closingWithin, feedUnchanged } from '../alerts/diff.mjs';
import { MIN_CHANGE_MS, SNAPSHOT_SHRINK_GUARD } from '../alerts/config.mjs';
import { deriveDeadlineChange } from '../lib/workshops.mjs';

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}
const eq = (label, got, want) =>
  check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);

const OBSERVED = '2026-08-14';

/** A minimal /api/workshops.json-shaped entry. */
const ws = (slug, over = {}) => ({
  slug,
  name: `Workshop ${slug}`,
  acronym: slug.toUpperCase(),
  conference: 'neurips',
  year: 2026,
  topics: ['llms'],
  status: 'upcoming',
  status_label: 'Open call',
  deadline_utc: null,
  abstract_deadline_utc: null,
  next_stage_utc: null,
  next_stage_is_abstract: false,
  website: 'https://example.com',
  ...over,
});

const feed = (list) => ({ generated_at: '2026-08-14T05:30:00.000Z', count: list.length, workshops: list });
const snap = (list) => projectFeed(feed(list));

/* ---------------------------------------------------------------- projection */
{
  const p = projectFeed(feed([ws('a', { deadline_utc: '2026-09-01T23:59:00.000Z' })]));
  check('projection is keyed by slug', !!p.workshops.a);
  check('projection carries the deadline', p.workshops.a.deadline_utc === '2026-09-01T23:59:00.000Z');
  check('projection counts entries', p.count === 1);
  check('projection drops unneeded fields', p.workshops.a.deadline_notes === undefined);
  const empty = projectFeed(null);
  check('a null feed projects to an empty snapshot', empty.count === 0);
  const noSlug = projectFeed(feed([{ name: 'no slug' }]));
  check('entries without a slug are skipped', noSlug.count === 0);
}

/* ------------------------------------------------------- first run seeds only */
{
  const live = snap([ws('a'), ws('b')]);
  const r = diffSnapshot(null, live, OBSERVED);
  check('no snapshot -> status "seed"', r.status === 'seed', r.status);
  check('no snapshot -> zero events (never announce the whole dataset)', r.events.length === 0);
  const r2 = diffSnapshot({ workshops: {} }, live, OBSERVED);
  check('an empty snapshot also seeds rather than diffing', r2.status === 'seed');
}

/* ------------------------------------------------------------- shrink guard */
{
  const prev = snap(Array.from({ length: 100 }, (_, i) => ws(`w${i}`)));

  const partial = snap(Array.from({ length: 60 }, (_, i) => ws(`w${i}`)));
  const abort = diffSnapshot(prev, partial, OBSERVED);
  check('a 60% dataset aborts the diff', abort.status === 'abort', abort.status);
  check('the abort explains itself', /shrank/.test(abort.reason || ''), abort.reason);
  check('an aborted diff emits no events', abort.events.length === 0);

  // Exactly at the guard is allowed: the rule is "below the threshold aborts",
  // so a legitimate slow shrink doesn't wedge the pipeline at the boundary.
  const atGuard = snap(Array.from({ length: SNAPSHOT_SHRINK_GUARD * 100 }, (_, i) => ws(`w${i}`)));
  check('exactly at the guard still diffs', diffSnapshot(prev, atGuard, OBSERVED).status === 'ok');

  const grew = snap(Array.from({ length: 140 }, (_, i) => ws(`w${i}`)));
  check('growth is never blocked', diffSnapshot(prev, grew, OBSERVED).status === 'ok');
}

/* ------------------------------------------------------------- classification */
{
  const prev = snap([
    ws('known', { deadline_utc: '2026-09-01T23:59:00.000Z' }),
    ws('undated'),
    ws('stable', { deadline_utc: '2026-10-01T23:59:00.000Z' }),
    ws('gone', { deadline_utc: '2026-09-05T23:59:00.000Z' }),
  ]);
  const live = snap([
    ws('known', { deadline_utc: '2026-09-06T23:59:00.000Z' }), // +5 days
    ws('undated', { deadline_utc: '2026-11-11T23:59:00.000Z' }), // null -> value
    ws('stable', { deadline_utc: '2026-10-01T23:59:00.000Z' }), // unchanged
    ws('fresh', { deadline_utc: '2026-12-01T23:59:00.000Z' }), // new slug
  ]);
  const r = diffSnapshot(prev, live, OBSERVED);
  check('classification succeeds', r.status === 'ok');

  const by = Object.fromEntries(r.events.map((e) => [e.slug, e]));
  check('a moved-later deadline is "extended"', by.known?.kind === 'extended', by.known?.kind);
  check('the extension reports 5 days', by.known?.days === 5, String(by.known?.days));
  check('the extension carries both values', by.known?.old_utc === '2026-09-01T23:59:00.000Z' && by.known?.new_utc === '2026-09-06T23:59:00.000Z');
  check('null -> value is "deadline_announced"', by.undated?.kind === 'deadline_announced', by.undated?.kind);
  check('a new slug is "announced"', by.fresh?.kind === 'announced', by.fresh?.kind);
  check('an "announced" event has no day count', by.fresh?.days === null);
  check('an unchanged deadline produces nothing', !by.stable);
  check('a deleted slug produces nothing', !by.gone);
  check('every event is stamped with the observation date', r.events.every((e) => e.observed === OBSERVED));

  // A new slug that arrives WITH a deadline is announced once, not twice.
  check('a new slug with a deadline yields exactly one event',
    r.events.filter((e) => e.slug === 'fresh').length === 1);
}

/* ----------------------------------------------------- earlier moves + threshold */
{
  const prev = snap([
    ws('moved', { deadline_utc: '2026-09-10T23:59:00.000Z' }),
    ws('nudged', { deadline_utc: '2026-09-10T23:59:00.000Z' }),
    ws('tzslip', { deadline_utc: '2026-09-10T23:59:00.000Z' }),
    ws('lost', { deadline_utc: '2026-09-10T23:59:00.000Z' }),
  ]);
  const live = snap([
    ws('moved', { deadline_utc: '2026-09-08T11:59:00.000Z' }), // ~2.5 days earlier
    ws('nudged', { deadline_utc: '2026-09-11T23:00:00.000Z' }), // 23h later -> 1 day
    ws('tzslip', { deadline_utc: '2026-09-11T00:30:00.000Z' }), // 31 min -> suppressed
    ws('lost', { deadline_utc: null }), // value -> null: silent
  ]);
  const by = Object.fromEntries(diffSnapshot(prev, live, OBSERVED).events.map((e) => [e.slug, e]));

  check('a moved-earlier deadline is "earlier"', by.moved?.kind === 'earlier', by.moved?.kind);
  check('an earlier move rounds to 3 days', by.moved?.days === 3, String(by.moved?.days));
  check('a sub-day move still reports at least 1 day', by.nudged?.days === 1, String(by.nudged?.days));
  check(`a ${Math.round(MIN_CHANGE_MS / 60000)}-minute-threshold slip is suppressed`, !by.tzslip);
  check('a deadline going back to null is silent', !by.lost);
}

/* ------------------------------- rounding matches the site's own derivation */
// If these ever diverge, the board and the email disagree about the same move.
{
  const parse = (v) => Date.parse(v);
  const cases = [
    ['2026-09-01T00:00:00Z', '2026-09-06T00:00:00Z'], //  5 days exactly
    ['2026-09-01T00:00:00Z', '2026-09-02T23:00:00Z'], //  1.96 days -> 2
    ['2026-09-01T00:00:00Z', '2026-09-01T23:00:00Z'], //  0.96 days -> 1
    ['2026-09-10T00:00:00Z', '2026-09-07T06:00:00Z'], //  2.75 days earlier -> 3
  ];
  for (const [from, to] of cases) {
    const site = deriveDeadlineChange(
      [
        { value: from, recorded: OBSERVED, timezone: 'UTC' },
        { value: to, recorded: OBSERVED, timezone: 'UTC' },
      ],
      Date.parse(`${OBSERVED}T12:00:00Z`),
      parse,
    );
    const mine = deltaDays(parse(to) - parse(from));
    check(`rounding matches deriveDeadlineChange for ${from} -> ${to}`, site?.days === mine,
      `site=${site?.days} alerts=${mine}`);
  }

  // And the suppression threshold matches too.
  const slip = deriveDeadlineChange(
    [
      { value: '2026-09-01T00:00:00Z', recorded: OBSERVED, timezone: 'UTC' },
      { value: '2026-09-01T00:30:00Z', recorded: OBSERVED, timezone: 'UTC' },
    ],
    Date.parse(`${OBSERVED}T12:00:00Z`),
    parse,
  );
  check('the site also suppresses a 30-minute slip', slip === null);
}

/* ------------------------------------------------------------- closingWithin */
{
  const now = Date.parse('2026-08-14T00:00:00Z');
  const live = snap([
    ws('soon', { next_stage_utc: '2026-08-16T23:59:00.000Z', deadline_utc: '2026-08-16T23:59:00.000Z' }),
    ws('sooner', { next_stage_utc: '2026-08-15T09:00:00.000Z', deadline_utc: '2026-08-30T09:00:00.000Z' }),
    ws('later', { next_stage_utc: '2026-09-30T23:59:00.000Z', deadline_utc: '2026-09-30T23:59:00.000Z' }),
    ws('past', { next_stage_utc: '2026-08-01T23:59:00.000Z', deadline_utc: '2026-08-01T23:59:00.000Z' }),
    ws('tba'),
  ]);
  const got = closingWithin(live.workshops, now, 7 * 86_400_000).map((w) => w.slug);
  eq('closingWithin returns only the in-window items, soonest first', got, ['sooner', 'soon']);

  // A two-stage venue is placed by its NEXT stage, not by the paper deadline —
  // same rule the board and the saved page use.
  const twoStage = closingWithin(live.workshops, now, 2 * 86_400_000).map((w) => w.slug);
  eq('a two-stage workshop sorts by its abstract stage', twoStage, ['sooner']);
}

/* ------------------------------------------------------- not_running entries */
{
  const now = Date.parse('2026-08-14T00:00:00Z');
  // A rejected proposal keeps a live OpenReview group, so its deadline really is
  // imminent. Nothing but the status distinguishes it from a genuine open call.
  const live = snap([
    ws('real', { next_stage_utc: '2026-08-16T23:59:00.000Z', deadline_utc: '2026-08-16T23:59:00.000Z' }),
    ws('marked', {
      status: 'not_running',
      status_label: 'Not running',
      // The recorded deadline is KEPT in the feed; only next_stage_utc is nulled.
      deadline_utc: '2026-08-15T22:00:00.000Z',
      next_stage_utc: null,
    }),
  ]);
  eq(
    'closingWithin skips a not-running entry, however imminent its deadline',
    closingWithin(live.workshops, now, 7 * 86_400_000).map((w) => w.slug),
    ['real'],
  );

  // The transition is deliberately SILENT: no new event kind in this landing.
  // Pinned so a later refactor cannot start mailing subscribers by accident —
  // if that becomes wanted, it should be a decision, not a side effect.
  const before = snap([ws('marked', { deadline_utc: '2026-08-15T22:00:00.000Z', next_stage_utc: '2026-08-15T22:00:00.000Z' })]);
  const after = snap([
    ws('marked', {
      status: 'not_running',
      status_label: 'Not running',
      deadline_utc: '2026-08-15T22:00:00.000Z',
      next_stage_utc: null,
    }),
  ]);
  const r = diffSnapshot(before, after, OBSERVED);
  check('marking an entry not-running emits no event', r.status === 'ok' && r.events.length === 0,
    JSON.stringify(r.events));
  // ...and because the slug STAYS in the feed, it cannot count against the
  // shrink guard on a bulk cleanup, nor re-announce itself if ever unmarked.
  check('the slug stays in the feed', Object.keys(after.workshops).includes('marked'));
}

/* ----------------------------------------------------------- feedUnchanged */
// The daily job runs 73 minutes after the daily deploy by cron, and GitHub's
// cron drifts by hours either way. Equal build stamps mean "not rebuilt yet";
// the pipeline waits on that rather than recording a quiet day.
{
  const a = { generated_at: '2026-08-14T05:50:00.000Z' };
  const b = { generated_at: '2026-08-15T05:50:00.000Z' };
  check('same build stamp -> unchanged', feedUnchanged(a, a) === true);
  check('a newer build -> changed', feedUnchanged(a, b) === false);
  check('no snapshot (first run) -> not "unchanged"', feedUnchanged(null, b) === false);
  check('a snapshot without a stamp -> not "unchanged"', feedUnchanged({}, b) === false);
}

/* ---------------------------------------------- one definition of imminent */
// closingWithin carries the not_running gate. It was once "shared" only on
// paper: both real callers had private copies of the window arithmetic and
// neither checked status, so this suite was green while the shipped code could
// mail "41h left" for a workshop that is not happening. Structural, like
// alerts_session_test: the callers must import it, and must not keep a private
// window filter beside it.
{
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const run = fs.readFileSync(path.join(ROOT, 'scripts', 'alerts_run.mjs'), 'utf8');
  const render = fs.readFileSync(path.join(ROOT, 'alerts', 'render.mjs'), 'utf8');
  check('alerts_run.mjs imports closingWithin', /import \{[^}]*\bclosingWithin\b[^}]*\} from '\.\.\/alerts\/diff\.mjs'/.test(run));
  check('the urgent pass goes through closingWithin', /function starredImminent[\s\S]*?closingWithin\(/.test(run));
  check('render.mjs imports closingWithin', /import \{[^}]*\bclosingWithin\b[^}]*\} from '\.\/diff\.mjs'/.test(render));
  check('the digest\'s "closing soon" section goes through closingWithin', /closingPairs = closingWithin\(/.test(render));
  check('the digest\'s saved section goes through closingWithin', /savedAll = closingWithin\(/.test(render));
  // The tell of a re-inlined window filter: a `ms < nowMs + <window>` comparison
  // outside closingWithin itself.
  const inlineWindow = /\bms\s*<\s*nowMs\s*\+\s*(weekMs|URGENT_WINDOW_MS|windowMs)\b/;
  check('render.mjs keeps no private copy of the window filter', !inlineWindow.test(render));
  check('alerts_run.mjs keeps no private copy of the window filter', !/NOW_MS\s*\+\s*URGENT_WINDOW_MS/.test(run.replace(/closingWithin\([^)]*\)/g, '')));
}

console.log(failed === 0 ? '\nDiff/classification logic OK.' : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
