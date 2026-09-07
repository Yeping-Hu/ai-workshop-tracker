#!/usr/bin/env node
/**
 * The search results' sort orders — the "Sort" picker's rules, pinned.
 * Run: node scripts/result_sort_test.mjs
 *
 * site/src/scripts/result-sort.js orders the grouped results in the browser
 * from each result's metadata. What can go wrong there is quiet: a comparator
 * that puts a TBA edition before a dated one, an order that differs run to
 * run, a fallback that fails open when the keyword behind "Best match" is
 * removed, or the homepage and the module listing different options. Each rule
 * is one fixture below; the structural checks at the end keep the homepage
 * wired to this module rather than to a copy of it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SORTS, defaultSort, effectiveSort, sortResults } from '../site/src/scripts/result-sort.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
function check(label, got, expect) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(expect)})`}`);
}

// --- fixtures ----------------------------------------------------------------
// The browse key as workshop/[slug].astro writes it: a band, then a 14-digit
// zero-padded instant (its complement in the band that reads newest first),
// so the strings compare as the dates do.
const MAX = 99999999999999;
const pad = (ms) => String(Math.max(0, Math.min(ms, MAX))).padStart(14, '0');
const open = (ms) => '0-' + pad(ms);
const tba = (eventMs) => '1-' + pad(eventMs);
const closed = (ms) => '2-' + pad(MAX - ms);
const D = (y, m, d) => Date.UTC(y, m - 1, d);
const iso = (ms) => new Date(ms).toISOString();

// One item per shape the corpus has. `matched` is what a keyword search found
// inside the workshop; the array order is the engine's relevance ranking.
const item = (slug, view, matched = 0) => ({ view: { slug, ...view }, matched });
const ITEMS = [
  item('neurips-2025-b', { name: 'Bayesian Decision-making', year: '2025', deadline_utc: iso(D(2025, 8, 30)), order: closed(D(2025, 8, 30)) }, 3),
  item('neurips-2026-open-late', { name: 'Agents at Scale', year: '2026', deadline_utc: iso(D(2026, 9, 20)), order: open(D(2026, 9, 20)) }, 1),
  item('icml-2026-a', { name: 'agents in the wild', year: '2026', deadline_utc: iso(D(2026, 5, 1)), order: closed(D(2026, 5, 1)) }, 5),
  item('neurips-2026-open-soon', { name: 'Workshop 10', year: '2026', deadline_utc: iso(D(2026, 9, 10)), order: open(D(2026, 9, 10)) }, 0),
  item('iros-2026-tba', { name: 'Workshop 2', year: '2026', deadline_utc: '', order: tba(D(2026, 10, 19)) }, 2),
  item('cvpr-2021-old', { name: 'Workshop 2', year: '2021', deadline_utc: iso(D(2021, 3, 15)), order: closed(D(2021, 3, 15)) }, 1),
  // Metadata missing altogether: an index from before the key was published.
  item('unknown-year', { name: 'Zed', year: '', deadline_utc: '', order: '' }, 0),
];
const ENGINE_ORDER = ITEMS.map((i) => i.view.slug);
const slugs = (r) => r.items.map((it) => it.view.slug);

// --- the vocabulary ----------------------------------------------------------
check('the picker lists these orders, in this order', SORTS.map((s) => s.key), ['relevance', 'soonest', 'oldest', 'name', 'papers']);
check('every option has a label and a count-line phrase', SORTS.every((s) => s.label && s.says), true);
check('the two keyword-only orders are marked so', SORTS.filter((s) => s.needsQuery).map((s) => s.key), ['relevance', 'papers']);
check('the browse phrase is the one the count line always used', SORTS.find((s) => s.key === 'soonest').says, 'open calls first');
check('so is the relevance phrase', SORTS.find((s) => s.key === 'relevance').says, 'by relevance');

// --- which order applies -----------------------------------------------------
check('keywords default to relevance', defaultSort(true), 'relevance');
check('a filter-only browse defaults to the browse order', defaultSort(false), 'soonest');
check('a known order applies as asked', effectiveSort('oldest', true), 'oldest');
check('an unknown order falls back to the default', effectiveSort('bogus', true), 'relevance');
check('null falls back to the default', effectiveSort(null, false), 'soonest');
check('"Best match" without keywords is the browse order', effectiveSort('relevance', false), 'soonest');
check('"Most matching papers" without keywords is the browse order', effectiveSort('papers', false), 'soonest');
check('a mode-independent choice survives losing the keyword', effectiveSort('name', false), 'name');

// --- relevance: the engine's order, untouched --------------------------------
{
  const r = sortResults(ITEMS, 'relevance', true);
  check('relevance keeps the engine order', slugs(r), ENGINE_ORDER);
  check('and reports what it applied', r.key, 'relevance');
  check('a new array, not the input', r.items !== ITEMS, true);
  check('the default with keywords is the same list', slugs(sortResults(ITEMS, null, true)), ENGINE_ORDER);
}

// --- soonest: the browse key ---------------------------------------------------
{
  const r = sortResults(ITEMS, 'soonest', true);
  check('open calls by soonest deadline, then TBA, then most recent first, no key last', slugs(r), [
    'neurips-2026-open-soon', 'neurips-2026-open-late', 'iros-2026-tba', 'icml-2026-a', 'neurips-2025-b', 'cvpr-2021-old', 'unknown-year',
  ]);
  check('the default without keywords is this order', sortResults(ITEMS, null, false).key, 'soonest');
}

// --- oldest --------------------------------------------------------------------
{
  const r = sortResults(ITEMS, 'oldest', false);
  check('by year, then deadline within it; a TBA closes its year; unknown year last', slugs(r), [
    'cvpr-2021-old', 'neurips-2025-b', 'icml-2026-a', 'neurips-2026-open-soon', 'neurips-2026-open-late', 'iros-2026-tba', 'unknown-year',
  ]);
  check('and reports what it applied', r.key, 'oldest');
}

// --- name ----------------------------------------------------------------------
{
  const r = sortResults(ITEMS, 'name', true);
  check('dictionary order, case folded, digits as numbers; same name → newest edition first', slugs(r), [
    'neurips-2026-open-late', 'icml-2026-a', 'neurips-2025-b', 'iros-2026-tba', 'cvpr-2021-old', 'neurips-2026-open-soon', 'unknown-year',
  ]);
}

// --- papers --------------------------------------------------------------------
{
  const r = sortResults(ITEMS, 'papers', true);
  check('most matching papers first; ties keep the engine order', slugs(r), [
    'icml-2026-a', 'neurips-2025-b', 'iros-2026-tba', 'neurips-2026-open-late', 'cvpr-2021-old', 'neurips-2026-open-soon', 'unknown-year',
  ]);
  check('without keywords there is nothing to count, so the browse order applies', sortResults(ITEMS, 'papers', false).key, 'soonest');
}

// --- determinism ---------------------------------------------------------------
{
  const shuffled = [ITEMS[3], ITEMS[6], ITEMS[0], ITEMS[5], ITEMS[1], ITEMS[4], ITEMS[2]];
  for (const key of ['soonest', 'oldest', 'name']) {
    check(`${key}: independent of the incoming order`, slugs(sortResults(shuffled, key, true)), slugs(sortResults(ITEMS, key, true)));
  }
  check('the input is never mutated', ITEMS.map((i) => i.view.slug), ENGINE_ORDER);
  const same = { name: 'Same', year: '2024', deadline_utc: iso(D(2024, 1, 1)), order: closed(D(2024, 1, 1)) };
  const twins = [item('b-twin', same), item('a-twin', same)];
  for (const key of ['soonest', 'oldest', 'name']) {
    check(`${key}: rows identical in every field fall back to the slug`, slugs(sortResults(twins, key, false)), ['a-twin', 'b-twin']);
  }
}

// --- the homepage is wired to this module, not to a copy -----------------------
// Structural, because index.astro's search script is inline and cannot import;
// it takes SORTS through define:vars and the functions through window.
const index = fs.readFileSync(path.join(ROOT, 'site/src/pages/index.astro'), 'utf8');
const slugPage = fs.readFileSync(path.join(ROOT, 'site/src/pages/workshop/[slug].astro'), 'utf8');
check('the picker is rendered from SORTS', /SORTS\.map\(\(s\) => <option value=\{s\.key\}>\{s\.label\}<\/option>\)/.test(index), true);
check('the results are ordered by sortResults', /awtResultSort\.sortResults\(/.test(index), true);
check('the count line takes its phrase from SORTS', /SORTS\.map\(\(s\) => \[s\.key, s\.says\]\)/.test(index), true);
check("the sort travels in the URL as ?sort=", /p\.set\('sort', sortKey\)/.test(index), true);
check('the browse key is published in the results metadata', /\['order', searchOrder\]/.test(slugPage), true);
check('and read into the row view', /order: meta\.order/.test(index), true);

console.log(failed ? `\n${failed} check(s) failed` : '\nSort orders are consistent');
process.exit(failed ? 1 : 0);
