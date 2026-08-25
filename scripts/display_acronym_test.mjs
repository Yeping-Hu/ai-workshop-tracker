#!/usr/bin/env node
/**
 * Regression tests for displayAcronym — the rule deciding whether an acronym is
 * shown beside a workshop's name in the weekly digest and on /changes/.
 * Pure logic, no network.
 * Run: node scripts/display_acronym_test.mjs
 *
 * Why this exists: every workshop in the dataset carries an `acronym`, but the
 * field is only sometimes an acronym. Where OpenReview had no real one, the
 * importer stored the name with its spaces removed, so digests went out saying
 * "… (NeurReps_Extended_Abstracts · NeurIPS 2026)" — the name printed twice,
 * once mangled. The fix is a display rule, never a data edit: if a label reads
 * badly the rule is wrong, and no workshop gets a special case.
 *
 * The last section is the one that matters most over time. The shape test is
 * shared with `acronymDrift`, and the whole point is that there is exactly one
 * copy of it — so this asserts both that the two agree at the boundary and that
 * the crosscheck script has not quietly grown its own second copy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { displayAcronym, displayLabel, isAcronymShaped, stripAcronymYear } from '../lib/identity.mjs';
import { acronymDrift } from './deadline_crosscheck.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
function check(label, got, expect) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(expect)})`}`);
}

// --- rule 1: underscore stems are names, not acronyms ----------------------
// Both of these shipped in the dataset and both appeared in a real digest.
check('NeurReps stem dropped',
  displayAcronym('Symmetry and Geometry in Neural Representations', 'NeurReps_Extended_Abstracts'), null);
check('Scalable Tactile stem dropped',
  displayAcronym('Scalable Tactile Manipulation', 'Scalable_Tactile_Manipulation'), null);
check('a spaced phrase is not an acronym',
  displayAcronym('Prompting in Vision', 'CVPR 2024 Workshop Prompting in Vision'), null);
check('exactly 15 chars is still an acronym', displayAcronym('Some Long Name', 'ABCDEFGHIJKLMNO'), 'ABCDEFGHIJKLMNO');
check('16 chars is not', displayAcronym('Some Long Name', 'ABCDEFGHIJKLMNOP'), null);

// --- rule 0: a venue year on the end is stripped, and the STRIPPED value
//            is what displays — the label's own suffix already says the year.
check('trailing year stripped', displayAcronym('Bridging NLP and Public Opinion Research', 'NLPOR 2025'), 'NLPOR');
// The apostrophe forms are pinned on the stripper itself. Going through
// displayAcronym would prove nothing here: "Social Simulation" contains "Sim",
// so rule 2 suppresses it for a different and equally correct reason.
check('apostrophe year stripped', stripAcronymYear("Sim'25"), 'Sim');
check('curly apostrophe year stripped', stripAcronymYear('Sim’25'), 'Sim');
check('apostrophe year survives to display when the name does not contain it',
  displayAcronym('Agent-Based Modelling of Society', "Sim'25"), 'Sim');
// Stripping does not rescue a value that was never one token: "Social Sim'25"
// loses the year and is still two words, so it stays suppressed.
check('spaced value still suppressed after stripping',
  displayAcronym('Agent-Based Modelling of Society', "Social Sim'25"), null);
check('hyphen-joined year stripped', displayAcronym('Realistic Generation', 'ReALM-GEN 2026'), 'ReALM-GEN');
check('venue-and-year tail stripped', displayAcronym('AI for Accelerated Materials Design', 'AI4Mat-ICLR-2026'), 'AI4Mat-ICLR');
check('a trailing digit that is not a year survives', displayAcronym('Reasoning Attention Memory', 'RAM2'), 'RAM2');
check('stripping never empties a value out of existence',
  displayAcronym('Some Workshop', '2026'), null);
// The strip runs BEFORE the name-contains test, so the stored year does not
// smuggle an acronym past rule 2.
check('name containing the stripped acronym still suppresses',
  displayAcronym('Bridging NLP and Public Opinion Research (NLPOR)', 'NLPOR 2025'), null);

// --- rule 2: the name already says it -------------------------------------
check('name contains the acronym',
  displayAcronym('Data and AI for Health (DAIH)', 'DAIH'), null);
check('match ignores case and punctuation',
  displayAcronym('AI 4 Math: reasoning', 'AI4Math'), null);
check('a genuine acronym absent from the name survives',
  displayAcronym('Dexterous Object Manipulation', 'DOM-R3'), 'DOM-R3');

// --- rule 3: do not stack a track the name already carries ----------------
check('track suffix stacked when the name lacks it',
  displayAcronym('Robot Learning', 'RL', 'Main Track'), 'RL (Main Track)');
check('track suffix dropped when the name carries it',
  displayAcronym('Robot Learning Main Track', 'RL', 'Main Track'), 'RL');
check('no track label given',
  displayAcronym('Robot Learning', 'RL', null), 'RL');

// --- label formats --------------------------------------------------------
check('acronym shown -> parenthesised with a middot',
  displayLabel('Dexterous Object Manipulation', 'DOM-R3', { conference: 'IROS', year: 2026 }),
  'Dexterous Object Manipulation (DOM-R3 · IROS 2026)');
check('no acronym -> em dash, venue not parenthesised',
  displayLabel('Symmetry and Geometry in Neural Representations', 'NeurReps_Extended_Abstracts',
    { conference: 'NeurIPS', year: 2026 }),
  'Symmetry and Geometry in Neural Representations — NeurIPS 2026');

// --- degenerate input -----------------------------------------------------
check('empty acronym', displayAcronym('Some Name', ''), null);
check('null acronym', displayAcronym('Some Name', null), null);
check('punctuation-only acronym', displayAcronym('Some Name', '---'), null);

// --- ONE shape predicate, not two ----------------------------------------
// Behavioural: acronymDrift must accept exactly the strings isAcronymShaped
// does. It reports drift only for acronym-shaped subtitles, so for a stored
// value that differs, "reported" and "acronym-shaped" have to coincide.
const boundary = ['AB', 'ABCDEFGHIJKLMNO', 'ABCDEFGHIJKLMNOP', 'has space', '', '   ', 'a_very_long_underscore_stem'];
for (const s of boundary) {
  const reported = acronymDrift('DIFFERENT', s) !== null;
  check(`acronymDrift agrees with isAcronymShaped on ${JSON.stringify(s)}`, reported, isAcronymShaped(s));
}

// Structural: catch a future re-duplication of the heuristic. The crosscheck
// must import the predicate and must not carry its own length/whitespace test.
const crosscheck = fs.readFileSync(path.join(ROOT, 'scripts/deadline_crosscheck.mjs'), 'utf8');
check('crosscheck imports the shared predicate',
  /import\s*\{[^}]*isAcronymShaped[^}]*\}\s*from\s*'\.\.\/lib\/identity\.mjs'/.test(crosscheck), true);
check('crosscheck has no second copy of the shape test',
  /length\s*>\s*15/.test(crosscheck), false);

// --- corpus-wide invariant ------------------------------------------------
// Unit cases pin the shapes we thought of; this pins the whole dataset, which
// is where the pseudo-acronyms came from in the first place. No displayed
// acronym may end in a year — that is the redundancy this rule exists to remove,
// and a new import carrying one should fail here rather than reach an inbox.
const { loadWorkshops } = await import('../lib/workshops.mjs');
const corpus = loadWorkshops();
const yearTailed = [];
const stems = [];
for (const w of corpus) {
  const shown = displayAcronym(w.name, w.acronym, w.trackLabel ?? null, w.year);
  if (!shown) continue;
  if (/(?:19|20)\d{2}$|['’]\d{2}$/.test(shown)) yearTailed.push(`${w.slug}: ${shown}`);
  if (!isAcronymShaped(shown.split(' (')[0])) stems.push(`${w.slug}: ${shown}`);
}
check(`no displayed acronym ends in a year (${corpus.length} workshops)`, yearTailed.slice(0, 5), []);
check('every displayed acronym is still acronym-shaped', stems.slice(0, 5), []);

console.log(failed ? `\n${failed} check(s) failed` : '\nAll display-acronym checks passed');
process.exit(failed ? 1 : 0);
