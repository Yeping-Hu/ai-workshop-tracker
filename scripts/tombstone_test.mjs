#!/usr/bin/env node
/**
 * A venue its organizers deleted is not a workshop (isTombstonedVenue in
 * discover_openreview.mjs): the importer refuses one on arrival, and no entry
 * in the corpus is one. The fixture is OpenReview's own record of the venue
 * that taught the rule, verbatim.
 *
 * Run: node scripts/tombstone_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTombstonedVenue } from './discover_openreview.mjs';
import { listWorkshopFiles, readWorkshopFile, slugOfFile } from '../lib/workshops.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}

// NeurIPS.cc/2024/Workshop/ATTRIB_Late as api2.openreview.net returned it on
// 2026-09-19: created 2024-10-02, renamed the next day. Everything but the
// title looks like a live venue — which is why the title is the rule.
const ATTRIB_LATE = {
  title: 'Deleted',
  subtitle: 'DELETE',
  website: 'N/A',
  date: 'Submission Start: Oct 02 2024 12:00AM UTC-0, Submission Deadline: Oct 04 2024 12:00AM UTC-0',
  location: 'Vancouver, BC, Canada',
};

check('the venue that taught the rule', isTombstonedVenue(ATTRIB_LATE));
check('however it is cased, bracketed or punctuated',
  ['deleted', 'DELETED', '[Deleted]', ' Delete ', '(removed)', 'To be deleted.'].every((title) => isTombstonedVenue({ title })));
check('the whole title, never a word in it — these are workshops',
  !['Deleted Scenes: What Generative Video Leaves Out', 'Machine Unlearning: Removed but Not Forgotten', 'Delete, Edit, Forget: Model Editing'].some((title) => isTombstonedVenue({ title })));
check('a short real name is not a husk (every one of these is in the corpus with a website)',
  !['MARINE', 'Re-Align', 'DBM', 'NewInML', 'RemembeRL', 'LM4Plan'].some((title) => isTombstonedVenue({ title })));
check('no title is not a tombstone — the empty-group rule owns that case',
  !isTombstonedVenue({}) && !isTombstonedVenue({ title: '' }) && !isTombstonedVenue());

const discover = fs.readFileSync(path.join(ROOT, 'scripts', 'discover_openreview.mjs'), 'utf8');
const guard = discover.indexOf("if (isTombstonedVenue({ title: val(c, 'title') }))");
const create = discover.indexOf('const record = { name: title, acronym, conference: conf, year };');
check('the importer refuses one before it builds a record', guard !== -1 && create !== -1 && guard < create);

const husks = listWorkshopFiles().filter((f) => isTombstonedVenue({ title: readWorkshopFile(f).raw.name })).map(slugOfFile);
check('no entry in the corpus is one', husks.length === 0,
  `${husks.join(', ')} — run \`node scripts/remove_tombstoned.mjs --write\`, and ask how it got past the importer`);

const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'validate.yml'), 'utf8');
check('CI runs this test', /tombstone_test\.mjs/.test(ci), 'the workflow lists tests by hand');

console.log(failed === 0 ? '\nTombstoned venues OK.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
