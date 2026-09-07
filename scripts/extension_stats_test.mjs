#!/usr/bin/env node
/**
 * Tests for the extension-rate derivation (lib/extensions.mjs): what counts as
 * observed, what counts as extended, the two gates, and the sentence.
 *
 * Run: node scripts/extension_stats_test.mjs
 */
import {
  netDeadlineMove,
  computeExtensionStats,
  extensionInsight,
  conferenceInsight,
  extensionSentence,
  MIN_GROUP,
  MIN_SERIES_EDITIONS,
} from '../lib/extensions.mjs';
import { deriveDeadlineChange, loadWorkshops } from '../lib/workshops.mjs';
import { resolveDeadlineUtcMs } from '../lib/dates.mjs';

let failed = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
};
const parse = (v, tz) => resolveDeadlineUtcMs(v, tz || 'UTC');
const NOW = Date.parse('2026-09-06T12:00:00Z');

console.log('— netDeadlineMove agrees with deriveDeadlineChange on its own cases —');
const ext7 = [
  { value: '2026-08-05 00:00', recorded: '2026-07-28', timezone: 'UTC' },
  { value: '2026-08-12 00:00', recorded: '2026-08-02', timezone: 'UTC' },
];
const d = deriveDeadlineChange(ext7, Date.parse('2026-08-04T00:00:00Z'), parse);
const n = netDeadlineMove(ext7, parse);
check('a 7-day extension reads the same in both', d?.kind === 'extended' && n?.kind === 'extended' && d.days === n.days && n.days === 7, JSON.stringify({ d, n }));
check('a sub-hour delta is suppressed', netDeadlineMove([
  { value: '2026-08-05 00:00', recorded: '2026-07-28', timezone: 'UTC' },
  { value: '2026-08-05 00:30', recorded: '2026-08-02', timezone: 'UTC' },
], parse) === null);
check('null -> date is not a move', netDeadlineMove([
  { value: null, recorded: '2026-07-28' },
  { value: '2026-08-05 00:00', recorded: '2026-08-02', timezone: 'UTC' },
], parse) === null);
check('date -> null is not a move', netDeadlineMove([
  { value: '2026-08-05 00:00', recorded: '2026-07-28', timezone: 'UTC' },
  { value: null, recorded: '2026-08-02' },
], parse) === null);
const zone = netDeadlineMove([
  { value: '2026-08-05 00:00', recorded: '2026-07-28', timezone: 'AoE' },
  { value: '2026-08-05 00:00', recorded: '2026-08-02', timezone: 'UTC' },
], parse);
check('same wall clock AoE -> UTC reads as earlier (each value in its own zone)', zone?.kind === 'earlier', JSON.stringify(zone));

console.log('— netting —');
check('5 + 3 nets to 8 days', netDeadlineMove([
  { value: '2026-08-05 00:00', recorded: '2026-07-28', timezone: 'UTC' },
  { value: '2026-08-10 00:00', recorded: '2026-08-02', timezone: 'UTC' },
  { value: '2026-08-13 00:00', recorded: '2026-08-08', timezone: 'UTC' },
], parse)?.days === 8);
check('out and back is not an extension', netDeadlineMove([
  { value: '2026-08-05 00:00', recorded: '2026-07-28', timezone: 'UTC' },
  { value: '2026-08-12 00:00', recorded: '2026-08-02', timezone: 'UTC' },
  { value: '2026-08-05 00:00', recorded: '2026-08-08', timezone: 'UTC' },
], parse) === null);
check('extended then pulled back to within an hour is nothing', netDeadlineMove([
  { value: '2026-08-05 00:00', recorded: '2026-07-28', timezone: 'UTC' },
  { value: '2026-08-12 00:00', recorded: '2026-08-02', timezone: 'UTC' },
  { value: '2026-08-05 00:20', recorded: '2026-08-08', timezone: 'UTC' },
], parse) === null);
check('an unparseable value yields null, not a throw', netDeadlineMove([
  { value: 'soon', recorded: '2026-07-28', timezone: 'UTC' },
  { value: '2026-08-12 00:00', recorded: '2026-08-02', timezone: 'UTC' },
], parse) === null);

console.log('— what counts as observed —');
const ms = (s) => Date.parse(s);
// The window opens at the earliest recorded CHANGE (index >= 1): 2026-08-04.
const hist = (a, b, rec = '2026-08-04') => [
  { value: a, recorded: '2026-06-23', timezone: 'UTC' },
  ...(b ? [{ value: b, recorded: rec, timezone: 'UTC' }] : []),
];
const entry = (slug, deadline, over = {}) => ({
  slug, conference: 'x', year: 2026, status: 'upcoming', timezone: 'UTC',
  deadlineUtcMs: deadline ? ms(deadline) : null, deadlineHistory: [], relatedEditions: [], ...over,
});
const corpus = [
  entry('a', '2026-08-20T00:00:00Z', { deadlineHistory: hist('2026-08-13 00:00', '2026-08-20 00:00') }), // extended 7
  entry('b', '2026-08-25T00:00:00Z'), // observed, not extended
  entry('c', '2026-07-20T00:00:00Z', { deadlineHistory: hist('2026-07-13 00:00', '2026-07-20 00:00', '2026-08-04') }), // before the window
  entry('d', '2026-09-20T00:00:00Z', { deadlineHistory: hist('2026-09-13 00:00', '2026-09-20 00:00') }), // still open
  entry('e', null), // no deadline
  entry('f', '2026-08-22T00:00:00Z', { status: 'not_running', deadlineHistory: hist('2026-08-15 00:00', '2026-08-22 00:00') }),
];
const stats = computeExtensionStats(corpus, NOW);
check('observedSince is the earliest recorded change, not the seeded first value', stats.observedSince === '2026-08-04', String(stats.observedSince));
check('a closed deadline inside the window is observed', stats.bySlug.get('a')?.observed === true);
check('…and its net extension is measured', stats.bySlug.get('a')?.extendedDays === 7, String(stats.bySlug.get('a')?.extendedDays));
check('a closed deadline with no history is observed and not extended', stats.bySlug.get('b')?.observed === true && stats.bySlug.get('b')?.extendedDays === null);
check('a deadline that closed before the window is not observed', stats.bySlug.get('c')?.observed === false);
check('an open deadline is not observed, even when already extended', stats.bySlug.get('d')?.observed === false);
check('no deadline → not observed', stats.bySlug.get('e')?.observed === false);
check('not_running → not observed', stats.bySlug.get('f')?.observed === false);
const g = stats.byConferenceYear.get('x-2026');
check('the group counts only observed entries', g?.observed === 2 && g?.extended === 1, JSON.stringify(g));
check('no median below MIN_MEDIAN extended entries', g?.medianDays === null);

console.log('— empty and sparse corpora never throw —');
const empty = computeExtensionStats([], NOW);
check('empty corpus → no window, no groups', empty.observedSince === null && empty.byConferenceYear.size === 0);
const noChanges = computeExtensionStats([entry('a', '2026-08-20T00:00:00Z', { deadlineHistory: hist('2026-08-20 00:00') })], NOW);
check('histories with only seeded first values open no window', noChanges.observedSince === null);
check('undefined input is fine', computeExtensionStats(undefined, NOW).observedSince === null);

console.log('— gates —');
const group = (n, extendedEvery = 2, conf = 'y') =>
  Array.from({ length: n }, (_, i) =>
    entry(`${conf}${i}`, '2026-08-20T00:00:00Z', {
      conference: conf,
      deadlineHistory: extendedEvery > 0 && i % extendedEvery === 0 ? hist('2026-08-13 00:00', '2026-08-20 00:00') : [],
    }));
const nine = computeExtensionStats(group(MIN_GROUP - 1), NOW);
const ten = computeExtensionStats(group(MIN_GROUP), NOW);
const probe = entry('p', '2026-10-01T00:00:00Z', { conference: 'y', status: 'upcoming' });
check(`${MIN_GROUP - 1} observed → no conference line`, extensionInsight(probe, nine) === null);
const ci = extensionInsight(probe, ten);
check(`${MIN_GROUP} observed → a conference line`, ci?.kind === 'conference' && ci.observed === MIN_GROUP, JSON.stringify(ci));
check('a past workshop gets no conference line', extensionInsight({ ...probe, status: 'past' }, ten) === null);
check('a not-running workshop gets nothing', extensionInsight({ ...probe, status: 'not_running' }, ten) === null);
check('median reported once MIN_MEDIAN extended entries exist', ci?.medianDays === 7, String(ci?.medianDays));
check('hub picks the latest year that clears the gate', conferenceInsight('y', [2025, 2026], ten)?.year === 2026);
check('hub with no qualifying year → null', conferenceInsight('y', [2025], ten) === null);

// Even-count median: 4 and 8 → 6.
const evenCorpus = [
  ...group(MIN_GROUP, 0, 'z'), // none extended on their own
  entry('m1', '2026-08-20T00:00:00Z', { conference: 'z', deadlineHistory: hist('2026-08-16 00:00', '2026-08-20 00:00') }),
  entry('m2', '2026-08-20T00:00:00Z', { conference: 'z', deadlineHistory: hist('2026-08-12 00:00', '2026-08-20 00:00') }),
  entry('m3', '2026-08-20T00:00:00Z', { conference: 'z', deadlineHistory: hist('2026-08-16 00:00', '2026-08-20 00:00') }),
  entry('m4', '2026-08-20T00:00:00Z', { conference: 'z', deadlineHistory: hist('2026-08-12 00:00', '2026-08-20 00:00') }),
];
check('even-count median averages the middle pair', computeExtensionStats(evenCorpus, NOW).byConferenceYear.get('z-2026')?.medianDays === 6);

console.log('— series rule (dormant until earlier editions carry history) —');
const seriesCorpus = [
  entry('s-2024', '2024-08-20T00:00:00Z', { year: 2024, status: 'past' }),
  entry('s-2025', '2025-08-20T00:00:00Z', { year: 2025, status: 'past' }),
  ...group(MIN_GROUP, 2, 'x'),
];
// Backdate the window by giving an early edition a recorded change.
seriesCorpus[0].deadlineHistory = [
  { value: '2024-08-13 00:00', recorded: '2024-07-01', timezone: 'UTC' },
  { value: '2024-08-20 00:00', recorded: '2024-08-01', timezone: 'UTC' },
];
const bySlug = new Map(seriesCorpus.map((w) => [w.slug, w]));
const sStats = computeExtensionStats(seriesCorpus, NOW);
const cur = entry('s-2026', '2026-10-01T00:00:00Z', {
  relatedEditions: [{ slug: 's-2025', year: 2025 }, { slug: 's-2024', year: 2024 }],
});
const si = extensionInsight(cur, sStats, (s) => bySlug.get(s));
check(`${MIN_SERIES_EDITIONS} observed earlier editions → the series line`, si?.kind === 'series' && si.editions === 2 && si.extended === 1, JSON.stringify(si));
check('series beats conference when both apply', si?.kind === 'series');
const one = extensionInsight({ ...cur, relatedEditions: [{ slug: 's-2025', year: 2025 }] }, sStats, (s) => bySlug.get(s));
check('one earlier edition → falls through to the conference rule', one?.kind === 'conference', JSON.stringify(one));
check('an earlier edition that is not in the corpus does not count', extensionInsight({ ...cur, relatedEditions: [{ slug: 'ghost', year: 2025 }, { slug: 's-2025', year: 2025 }] }, sStats, (s) => bySlug.get(s))?.kind === 'conference');
check('the series line renders on a past edition too', extensionInsight({ ...cur, status: 'past' }, sStats, (s) => bySlug.get(s))?.kind === 'series');

console.log('— sentences —');
check('conference sentence', extensionSentence(ci, { confName: 'NeurIPS' }) === 'So far at NeurIPS 2026, 50% of workshop deadlines were extended (median 7 days, across 10 closed calls).', extensionSentence(ci, { confName: 'NeurIPS' }));
check('conference sentence without a median', extensionSentence({ kind: 'conference', year: 2026, rate: 0.1, observed: 10, extended: 1, medianDays: null }, { confName: 'CoLM' }) === 'So far at CoLM 2026, 10% of workshop deadlines were extended (across 10 closed calls).');
check('series sentence, one extension', extensionSentence({ kind: 'series', editions: 2, extended: 1, medianDays: 7 }) === 'Extended in 1 of the 2 earlier editions we tracked (by 7 days).');
check('series sentence, several', extensionSentence({ kind: 'series', editions: 4, extended: 3, medianDays: 1 }) === 'Extended in 3 of the 4 earlier editions we tracked (median 1 day).');
check('series sentence, none', extensionSentence({ kind: 'series', editions: 3, extended: 0, medianDays: null }) === 'Not extended in any of the 3 earlier editions we tracked.');
check('null → empty string', extensionSentence(null) === '');

console.log('— the real corpus —');
const real = computeExtensionStats(loadWorkshops());
check('observedSince parses as a date', real.observedSince === null || Number.isFinite(Date.parse(real.observedSince)), String(real.observedSince));
check('every rate is within [0, 1]', [...real.byConferenceYear.values()].every((g) => g.rate >= 0 && g.rate <= 1 && g.extended <= g.observed));

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
