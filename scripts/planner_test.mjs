#!/usr/bin/env node
/**
 * Tests for the saved-page agenda (site/src/scripts/planner.js): grouping,
 * ordering, collisions, what is skipped, and the rendered HTML's escaping.
 *
 * Run: node scripts/planner_test.mjs
 */
import { buildAgenda, agendaHtml, starBucket, COLLISION_DAYS, COLLISION_N, monthKey } from '../site/src/scripts/planner.js';

let failed = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
};
const NOW = Date.parse('2026-09-06T12:00:00Z');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ws = (slug, over = {}) => ({ slug, name: slug, short_name: slug, conference: 'neurips', year: 2026, status: 'upcoming', deadline_utc: null, ...over });
const DAY = 86_400_000;
const at = (d) => new Date(NOW + d * DAY).toISOString();

console.log('— grouping and order —');
const a = buildAgenda([
  ws('late', { deadline_utc: '2026-10-02T11:59:00Z' }),
  ws('edge', { deadline_utc: '2026-09-30T23:59:00Z' }),
  ws('soon', { deadline_utc: '2026-09-10T11:59:00Z' }),
], { nowMs: NOW });
check('two months, ascending', a.months.map((m) => m.key).join(',') === '2026-09,2026-10', a.months.map((m) => m.key).join(','));
check('month labels are English month + year', a.months[0].label === 'September 2026', a.months[0].label);
check('items ascend within a month', a.months[0].items.map((i) => i.slug).join(',') === 'soon,edge');
check('23:59Z on the last day stays in its month', monthKey(Date.parse('2026-09-30T23:59:00Z')) === '2026-09');
check('total counts the starred rows', a.total === 3);

console.log('— what is included and skipped —');
const b = buildAgenda([
  ws('past', { deadline_utc: '2026-08-01T11:59:00Z', status: 'past' }),
  ws('two-stage', { deadline_utc: at(20), abstract_deadline_utc: at(15) }),
  ws('dated', { deadline_utc: at(5), notification_date: '2026-10-15', workshop_date: '2026-12-07' }),
  ws('tba'),
  ws('dead', { deadline_utc: at(3), status: 'not_running' }),
  ws('elsewhere', { deadline_utc: at(4), conference: 'iros' }),
], {
  nowMs: NOW,
  editions: { 'neurips-2026': { start: '2026-12-06', end: '2026-12-12', label: 'Dec 6–12, 2026' }, 'iros-2026': { start: '2026-08-01', end: '2026-08-05' } },
});
const kinds = b.months.flatMap((m) => m.items).map((i) => `${i.kind}:${i.slug ?? i.conference}`);
check('a passed deadline is dropped and counted', !kinds.includes('deadline:past') && b.passed === 1, `${kinds} passed=${b.passed}`);
check('the abstract stage is its own item', kinds.includes('abstract:two-stage'));
check('notification and workshop dates become items', kinds.includes('notification:dated') && kinds.includes('workshop:dated'));
check('a workshop with no dates contributes nothing (and no error)', !kinds.some((k) => k.endsWith(':tba')));
check('not_running is skipped entirely', !kinds.some((k) => k.endsWith(':dead')) && b.total === 5);
check('one conference item per starred conference-year with a future edition', kinds.filter((k) => k.startsWith('conference:')).join(',') === 'conference:neurips');
check('a conference edition already over is not listed', !kinds.includes('conference:iros'));
const confItem = b.months.flatMap((m) => m.items).find((i) => i.kind === 'conference');
check('the conference item carries the edition label', confItem?.name === 'Dec 6–12, 2026' && confItem.year === 2026, JSON.stringify(confItem));
check('only deadlines and abstracts are timed (get a countdown)', b.months.flatMap((m) => m.items).every((i) => i.timed === (i.kind === 'deadline' || i.kind === 'abstract')));

console.log('— collisions —');
const cluster = (days) => buildAgenda(days.map((d, i) => ws(`w${i}`, { deadline_utc: at(d) })), { nowMs: NOW }).collisions;
check(`${COLLISION_N} deadlines within ${COLLISION_DAYS} days → one cluster`, cluster([1, 5, 10]).length === 1 && cluster([1, 5, 10])[0].count === 3);
check('two deadlines never collide', cluster([1, 2]).length === 0);
check(`${COLLISION_N} over ${COLLISION_DAYS + 1} days → none`, cluster([1, 5, 12]).length === 0);
check('two separate clusters are both reported, non-overlapping', cluster([1, 2, 3, 30, 31, 32]).length === 2);
check('a cluster is measured from its first deadline', cluster([1, 9, 11]).length === 1); // 11-1 = 10 days
check('the abstract stage counts toward a collision', buildAgenda([
  ws('x', { deadline_utc: at(8), abstract_deadline_utc: at(2) }),
  ws('y', { deadline_utc: at(5) }),
], { nowMs: NOW }).collisions.length === 1);
check('a cluster names its slugs', cluster([1, 5, 10])[0].slugs.join(',') === 'w0,w1,w2');

console.log('— shapes —');
check('zero rows → nothing, no throw', buildAgenda([], { nowMs: NOW }).months.length === 0);
check('undefined → nothing, no throw', buildAgenda(undefined).months.length === 0);
const one = buildAgenda([ws('only', { deadline_utc: at(3) })], { nowMs: NOW });
check('one star → its items, no collision', one.months.length === 1 && one.collisions.length === 0);
check('buckets', ['0', '1', '2-4', '2-4', '5-9', '10+'].join() === [0, 1, 2, 4, 9, 10].map(starBucket).join());

console.log('— html —');
const html = agendaHtml(buildAgenda([
  ws('evil', { name: '<b>x</b> & "y"', short_name: '<b>x</b> & "y"', deadline_utc: at(1) }),
  ws('w1', { deadline_utc: at(2) }),
  ws('w2', { deadline_utc: at(3) }),
], { nowMs: NOW }), { base: '/p', esc });
check('names are escaped', html.includes('&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;') && !html.includes('<b>x</b>'));
check('links honour the base path', html.includes('href="/p/workshop/evil/"'));
check('deadline items carry a countdown for board.js', /class="countdown" data-deadline-ms="\d+"/.test(html));
check('a collision renders a warning', html.includes('class="planner-warn') && html.includes(`3 deadlines within ${COLLISION_DAYS} days`));
check('items are addressable by slug', html.includes('data-planner-slug="w1"'));
const empty = agendaHtml(buildAgenda([ws('gone', { deadline_utc: '2026-01-01T00:00:00Z' })], { nowMs: NOW }), { esc });
check('all passed → the "nothing ahead" line', empty.includes('Nothing ahead') && empty.includes('1 saved deadline has passed'), empty);
const tba = agendaHtml(buildAgenda([ws('tba')], { nowMs: NOW }), { esc });
check('no dates at all → the "nothing scheduled" line', tba.includes('Nothing scheduled yet'), tba);
let threw = false;
try { agendaHtml(one, {}); } catch { threw = true; }
check('rendering without an escaper is refused', threw);

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
