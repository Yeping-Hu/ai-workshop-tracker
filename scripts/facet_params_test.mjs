#!/usr/bin/env node
/**
 * The facet URL contract — one parser, and proof the board still speaks it.
 * Run: node scripts/facet_params_test.mjs
 *
 * `?conference=NeurIPS,ICML&topic=Agents` is written by three things and read by
 * two: the board writes it, /changes/ reads it, and the weekly digest builds it
 * server-side for its "and N more →" links. If any of them disagreed about the
 * separator, the casing, or whether the values are labels or ids, a link built
 * in one place would silently filter to nothing in another.
 *
 * site/src/scripts/facet-params.js is the single definition, used by /changes/
 * and pinned here. The board's own copy is still inline in
 * site/src/pages/index.astro because that script is `is:inline` with
 * `define:vars` — it needs build-time data injected, and an inline script cannot
 * import a module. So the last section asserts structurally that its read and
 * write lines still implement this contract. If the board is ever restructured
 * so it can import, delete that section and import it there instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FACETS, readFacets, writeFacets, matchesFacets } from '../site/src/scripts/facet-params.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
function check(label, got, expect) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(expect)})`}`);
}

// --- reading ---------------------------------------------------------------
const one = readFacets('?conference=NeurIPS,ICML&topic=Agents');
check('comma-separated values split', [...one.conference], ['NeurIPS', 'ICML']);
check('a single value still yields a set', [...one.topic], ['Agents']);
check('an absent facet is an empty set, not undefined', [...one.status], []);
check('an empty facet yields nothing', [...readFacets('?conference=').conference], []);
check('surrounding whitespace is trimmed', [...readFacets('?topic=Agents, Vision').topic], ['Agents', 'Vision']);
check('no query string at all is safe', [...readFacets('').conference], []);
check('undefined is safe', [...readFacets(undefined).conference], []);

// --- writing ---------------------------------------------------------------
check('round trip', writeFacets(readFacets('?conference=NeurIPS,ICML&topic=Agents')),
  'conference=NeurIPS%2CICML&topic=Agents');
check('empty facets are omitted, not written blank',
  writeFacets({ conference: new Set(), topic: new Set(['Agents']) }), 'topic=Agents');
check('nothing selected yields an empty string', writeFacets({}), '');

// --- matching --------------------------------------------------------------
const row = { conference: 'NeurIPS', topic: ['Agents', 'Safety'] };
check('an empty selection matches everything', matchesFacets(row, readFacets('')), true);
check('a matching conference passes', matchesFacets(row, readFacets('?conference=NeurIPS')), true);
check('a non-matching conference fails', matchesFacets(row, readFacets('?conference=ICML')), false);
check('any-semantics within a facet', matchesFacets(row, readFacets('?conference=ICML,NeurIPS')), true);
check('and-semantics across facets',
  matchesFacets(row, readFacets('?conference=NeurIPS&topic=Vision')), false);
check('a multi-valued row matches on any of its values',
  matchesFacets(row, readFacets('?topic=Safety')), true);

// --- the board still speaks the same contract ------------------------------
// Structural, because index.astro's script cannot import the module. These are
// the two lines that read and write the facet params on the board.
const board = fs.readFileSync(path.join(ROOT, 'site/src/pages/index.astro'), 'utf8');
check('the board declares the same facets',
  /const FACETS = \['conference', 'status', 'year', 'topic'\]/.test(board), true);
check('the board reads comma-separated values into a set per facet',
  /\(p\.get\(f\) \|\| ''\)\.split\(','\)\.filter\(Boolean\)/.test(board), true);
check('the board writes them comma-joined, omitting empties',
  /if \(sel\[f\]\.size\) p\.set\(f, \[\.\.\.sel\[f\]\]\.join\(','\)\)/.test(board), true);
check('this module and the board list identical facets',
  FACETS, ['conference', 'status', 'year', 'topic']);

console.log(failed ? `\n${failed} check(s) failed` : '\nFacet URL contract is consistent');
process.exit(failed ? 1 : 0);
