#!/usr/bin/env node
/**
 * Tests for the trends derivation (lib/trends.mjs): ranking, exclusions,
 * multi-label counting, shares, and the bar geometry.
 *
 * Run: node scripts/trends_test.mjs
 */
import { topicTrends, barLayout } from '../lib/trends.mjs';
import { loadWorkshops, loadTopics } from '../lib/workshops.mjs';

let failed = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
};
const TOPICS = [
  { id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }, { id: 'c', label: 'Gamma' }, { id: 'd', label: 'Delta' }, { id: 'other', label: 'Other' },
];
const w = (year, topics, over = {}) => ({ year, topics, status: 'past', ...over });

console.log('— counting —');
const t = topicTrends([
  w(2025, ['a']), w(2025, ['a', 'b']), w(2025, ['other']),
  w(2026, ['a', 'b', 'c']), w(2026, ['b']), w(2026, ['b', 'b']), w(2026, ['a']), w(2026, ['d'], { status: 'not_running' }), w(2026, ['zzz']),
], TOPICS, { topN: 2 });
check('years ascend', t.years.join(',') === '2025,2026');
check('totals count every live edition, whatever its topics', t.totals[2025] === 3 && t.totals[2026] === 5, JSON.stringify(t.totals));
check('not_running is excluded from totals and counts', !t.rows.some((r) => r.id === 'd') && t.rest.ids.length === 1 && t.rest.ids[0] === 'c');
check('a multi-label workshop counts once per topic', t.rows.find((r) => r.id === 'a')?.counts[2026] === 2 && t.rows.find((r) => r.id === 'b')?.counts[2026] === 3, JSON.stringify(t.rows.map((r) => [r.id, r.counts])));
check('a duplicated topic id counts once', t.rows.find((r) => r.id === 'b')?.counts[2026] === 3);
check('an unknown topic id is ignored', !t.rows.some((r) => r.id === 'zzz') && !t.rest.ids.includes('zzz'));
check('"other" is excluded', !t.rows.some((r) => r.id === 'other') && !t.rest.ids.includes('other'));
check('rows rank by latest-year count', t.rows.map((r) => r.id).join(',') === 'b,a', t.rows.map((r) => r.id).join(','));
check('shares divide by that year\'s total', Math.abs(t.rows[0].shares[2026] - 3 / 5) < 1e-9 && Math.abs(t.rows[1].shares[2025] - 2 / 3) < 1e-9);
check('the rest row sums the topics past topN', t.rest.counts[2026] === 1 && t.rest.counts[2025] === 0, JSON.stringify(t.rest));

console.log('— ties and edges —');
const tie = topicTrends([w(2026, ['c']), w(2026, ['a'])], TOPICS, { topN: 1 });
check('ties break by label', tie.rows[0].id === 'a');
check('empty corpus → no years, no rows, no throw', topicTrends([], TOPICS).years.length === 0 && topicTrends([], TOPICS).rows.length === 0);
check('undefined input → no throw', topicTrends(undefined, undefined).rows.length === 0);
check('a year with no topics has zero shares, not NaN', topicTrends([w(2024, []), w(2025, ['a'])], TOPICS).rows[0].shares[2024] === 0);

console.log('— layout —');
const L = barLayout(topicTrends([w(2025, ['a']), w(2025, ['b']), w(2026, ['a']), w(2026, ['a'], {}), w(2026, ['b'])], TOPICS, { topN: 2 }), { width: 400, labelWidth: 100, valueWidth: 40 });
check('the widest share spans the plot', L.rows[0].bars.some((b) => Math.abs(b.width - L.plotW) < 0.01), JSON.stringify(L.rows[0].bars.map((b) => b.width)));
check('a zero share is a zero-width bar with its label kept', barLayout(topicTrends([w(2025, ['a']), w(2026, ['b'])], TOPICS)).rows.some((r) => r.bars.some((b) => b.width === 0 && b.pct === 0)));
check('the latest year is drawn at full opacity, the first faint', L.years[L.years.length - 1].opacity === 1 && L.years[0].opacity < 1);
check('height covers every row', L.height >= L.rows[L.rows.length - 1].y + L.rows[0].bars.length * L.barH);
check('a single year is still drawn at full opacity', barLayout(topicTrends([w(2026, ['a'])], TOPICS)).years[0].opacity === 1);
check('empty trends → empty layout, no throw', barLayout(topicTrends([], TOPICS)).rows.length === 0);

console.log('— the real corpus —');
const real = topicTrends(loadWorkshops(), loadTopics());
check('eight rows by default', real.rows.length === 8, String(real.rows.length));
check('every share within [0, 1]', real.rows.every((r) => real.years.every((y) => r.shares[y] >= 0 && r.shares[y] <= 1)));
check('years are consecutive integers', real.years.every((y, i) => i === 0 || y === real.years[i - 1] + 1), real.years.join(','));

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
