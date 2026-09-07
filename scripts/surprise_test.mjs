#!/usr/bin/env node
/**
 * Tests for "Surprise me" (lib/surprise.mjs): which edition supplies the
 * pool, the stable paper id, and the never-repeat pick.
 *
 * Run: node scripts/surprise_test.mjs
 */
import { surprisePool, pickIndex, paperId } from '../lib/surprise.mjs';

let failed = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
};
const caches = {
  'x-2026': { papers: [] },
  'x-2025': { papers: [{ title: 'A', forum_url: 'https://openreview.net/forum?id=AAA' }, { title: 'B', pdf_url: 'https://openreview.net/pdf?id=BBB' }, { title: 'C' }] },
  'x-2024': { papers: [{ title: 'Old' }] },
  'x-2023': null,
  'y-2026': { papers: [{ title: 'Mine' }] },
};
const load = (slug) => caches[slug] ?? null;
const conf = () => 'Conf';
const w = (slug, year, relatedEditions = []) => ({ slug, year, relatedEditions });

console.log('— source —');
const mine = surprisePool(w('y-2026', 2026, [{ slug: 'x-2025', year: 2025, conference: 'x' }]), load, { confName: conf });
check("the page's own papers win", mine?.from === 'this' && mine.count === 1, JSON.stringify(mine));
const prev = surprisePool(w('x-2026', 2026, [
  { slug: 'x-2024', year: 2024, conference: 'x' },
  { slug: 'x-2025', year: 2025, conference: 'x' },
  { slug: 'x-2027', year: 2027, conference: 'x' },
]), load, { confName: conf });
check('an empty own cache falls through to the newest earlier edition with papers', prev?.from === 'previous' && prev.slug === 'x-2025', JSON.stringify(prev));
check('a later edition is never a source', prev?.slug !== 'x-2027');
check('the label names conference and year', prev?.label === 'Conf 2025');
check('anchors use the forum id when present', prev?.papers[0][1] === '/workshop/x-2025/#p-AAA' && prev.papers[1][1] === '/workshop/x-2025/#p-BBB');
check('…and slug+index when not', prev?.papers[2][1] === '/workshop/x-2025/#p-x-2025~2');
const skip = surprisePool(w('x-2026', 2026, [{ slug: 'x-2023', year: 2023, conference: 'x' }, { slug: 'x-2024', year: 2024, conference: 'x' }]), load, { confName: conf });
check('an earlier edition with no cache is skipped for the next one', skip?.slug === 'x-2024');
check('nothing anywhere → null', surprisePool(w('x-2026', 2026, [{ slug: 'x-2023', year: 2023 }]), load) === null);
check('no related editions → null', surprisePool(w('x-2026', 2026), load) === null);
check('undefined workshop → null, no throw', surprisePool(undefined, load) === null);
const capped = surprisePool(w('x-2026', 2026, [{ slug: 'x-2025', year: 2025, conference: 'x' }]), load, { max: 2, confName: conf });
check('the pool is capped', capped?.papers.length === 2);

console.log('— paper ids —');
check('forum id from forum_url', paperId({ forum_url: 'https://openreview.net/forum?id=Q1&x=2' }, 0, 's') === 'Q1');
check('forum id from pdf_url', paperId({ pdf_url: 'https://openreview.net/pdf?id=Q2#top' }, 0, 's') === 'Q2');
check('fallback is slug~index', paperId({ title: 't' }, 4, 'my-ws') === 'my-ws~4');

console.log('— picking —');
check('n = 1 → 0', pickIndex(1, 0) === 0 && pickIndex(1) === 0);
check('n = 0 → 0', pickIndex(0) === 0);
let repeated = false;
let last = -1;
for (let k = 0; k < 500; k++) {
  const i = pickIndex(5, last);
  if (i === last) repeated = true;
  if (!(i >= 0 && i < 5)) repeated = true;
  last = i;
}
check('never repeats the previous pick when n > 1', !repeated);
check('a pick that lands on the previous one moves to the next', pickIndex(3, 1, () => 0.5) === 2);
check('wraps around at the end', pickIndex(3, 2, () => 0.99) === 0);

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
