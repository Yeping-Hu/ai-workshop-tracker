#!/usr/bin/env node
/**
 * Regression tests for cleanAcronym — the guard that stops OpenReview's
 * `subtitle` from being stored as a workshop acronym when it only names the
 * venue. Pure logic, no network.
 * Run: node scripts/acronym_clean_test.mjs
 *
 * Why this exists: 11 imported entries arrived with acronym "<CONF> <year>"
 * ("COLM 2026", "NeurIPS 2025"). The site reads `acronym || name` in several
 * places — conference hub rows, the saved list, .ics feed summaries — so those
 * workshops displayed under the conference's name instead of their own, and a
 * reader browsing a hub saw several rows all called "COLM 2026". The bad value
 * beat a good fallback, which is the whole reason to drop it at import.
 *
 * The cases below are the real values from that batch, plus the genuine
 * acronyms that sit closest to them and must survive.
 */
import { cleanAcronym } from '../lib/workshops.mjs';

let failed = 0;
function check(label, got, expect) {
  const ok = got === expect;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(expect)})`}`);
}

// --- dropped: the acronym is just the venue -------------------------------
// Every one of these is a value that actually shipped in data/workshops.
check('NeurIPS 2025', cleanAcronym('NeurIPS 2025', 'neurips', 2025), '');
check('COLM 2026', cleanAcronym('COLM 2026', 'colm', 2026), '');
check('CoRL 2025 (mixed case)', cleanAcronym('CoRL 2025', 'corl', 2025), '');
check('CVPR 2025', cleanAcronym('CVPR 2025', 'cvpr', 2025), '');
check('ICRA 2026', cleanAcronym('ICRA 2026', 'icra', 2026), '');
check('IROS 2025', cleanAcronym('IROS 2025', 'iros', 2025), '');

// Punctuation and spacing shouldn't let the same value through.
check('hyphenated', cleanAcronym('CoRL-2025', 'corl', 2025), '');
check('no separator', cleanAcronym('IROS2026', 'iros', 2026), '');
check('year first', cleanAcronym('2026 ICRA', 'icra', 2026), '');
check('surrounding space', cleanAcronym('  CVPR 2026  ', 'cvpr', 2026), '');
// A bare conference name is just as useless as one carrying the year.
check('bare conference', cleanAcronym('CVPR', 'cvpr', 2026), '');

// --- kept: genuine workshop acronyms --------------------------------------
// Taken from the same import batch, so these are exactly the values a
// too-greedy rule would eat.
check('AIMS', cleanAcronym('AIMS', 'colm', 2026), 'AIMS');
check('RemembeRL', cleanAcronym('RemembeRL', 'corl', 2025), 'RemembeRL');
check('CVEU', cleanAcronym('CVEU', 'cvpr', 2025), 'CVEU');
check('FDIAMM', cleanAcronym('FDIAMM', 'iros', 2025), 'FDIAMM');
check('NextVid', cleanAcronym('NextVid', 'neurips', 2025), 'NextVid');
// Digits in a real acronym must not be mistaken for a year.
check('AI4RWC keeps its digits', cleanAcronym('AI4RWC', 'cvpr', 2026), 'AI4RWC');
check('MATH-AI', cleanAcronym('MATH-AI', 'neurips', 2025), 'MATH-AI');
// Contains the conference name but says more than it.
check('longer than the venue', cleanAcronym('CVPR Workshop on X', 'cvpr', 2025), 'CVPR Workshop on X');
// A different conference's name is not this conference's.
check('other venue kept', cleanAcronym('ICML 2025', 'neurips', 2025), 'ICML 2025');

// --- degenerate input -----------------------------------------------------
check('empty stays empty', cleanAcronym('', 'colm', 2026), '');
check('undefined stays empty', cleanAcronym(undefined, 'colm', 2026), '');
check('null stays empty', cleanAcronym(null, 'colm', 2026), '');
check('whitespace only', cleanAcronym('   ', 'colm', 2026), '');

console.log(failed ? `\n${failed} check(s) failed` : '\nAll acronym checks passed');
process.exit(failed ? 1 : 0);
