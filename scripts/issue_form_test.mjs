#!/usr/bin/env node
/**
 * Reading topics back out of an issue-form body.
 *
 * The forms changed from a multi-select `dropdown` to `checkboxes` on
 * 2026-08-17, which changed the shape of what lands in the issue body. Two
 * things must hold, and the second is the one that is easy to forget:
 *
 *   1. Unticked boxes are not selections. A `checkboxes` field renders *every*
 *      option, so a naive line-split turns all 35 topics into "chosen".
 *   2. The old comma-separated shape still parses, because an issue opened
 *      before the switch — or reopened long after — is converted by whatever
 *      version of the script is on main at the time.
 *
 * Run: node scripts/issue_form_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTopics } from '../lib/issue_form.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ------------------------------------------------- checkboxes (current) ---- */
{
  const body = `- [x] agents
- [ ] causality
- [ ] climate
- [x] diffusion
- [ ] evaluation-benchmarks`;
  check('only ticked boxes are selected',
    eq(parseTopics(body), ['agents', 'diffusion']),
    JSON.stringify(parseTopics(body)));

  // The failure this guards against: 35 options render every time, so treating
  // each line as a choice tags the workshop with the entire vocabulary.
  const allUnticked = ['agents', 'causality', 'climate'].map((t) => `- [ ] ${t}`).join('\n');
  check('nothing ticked yields nothing', eq(parseTopics(allUnticked), []),
    'an untouched field must read as empty, not as every topic');

  check('an uppercase X counts as ticked', eq(parseTopics('- [X] agents'), ['agents']));
  check('asterisk bullets parse', eq(parseTopics('* [x] agents\n* [ ] climate'), ['agents']));
  check('indented boxes parse', eq(parseTopics('  - [x] agents'), ['agents']));
  check('ids are lowercased', eq(parseTopics('- [x] Agents'), ['agents']));
  check('duplicates collapse', eq(parseTopics('- [x] agents\n- [x] agents'), ['agents']));
  // The forms show "<id> — <Label>" since 2026-09-19; the id is what is stored.
  check('a labelled box yields its id, label and all punctuation dropped',
    eq(parseTopics('- [x] graphs — Graphs & geometry\n- [ ] climate — Climate & environment\n- [x] economics — Economics, finance & games\n- [x] vision-3d — 3D vision'),
      ['graphs', 'economics', 'vision-3d']),
    JSON.stringify(parseTopics('- [x] graphs — Graphs & geometry\n- [x] economics — Economics, finance & games\n- [x] vision-3d — 3D vision')));
  check('a hyphen inside an id is not the separator', eq(parseTopics('- [x] human-ai — Human-AI interaction'), ['human-ai']));
  check('an en dash or a spaced hyphen, as a renderer or mail client may leave it, still separates',
    eq(parseTopics('- [x] video – Video\n- [x] code - Code & software'), ['video', 'code']));
  check('bare ids and labelled ones mix — an issue opened before the forms changed still converts',
    eq(parseTopics('- [x] agents\n- [x] llms — Large language models\n- [x] other'), ['agents', 'llms', 'other']));
}

/* ----------------------------------------------------- dropdown (legacy) --- */
{
  check('a comma-separated list still parses',
    eq(parseTopics('agents, diffusion'), ['agents', 'diffusion']));
  check('a newline-separated list still parses',
    eq(parseTopics('agents\ndiffusion'), ['agents', 'diffusion']));
  check('a single value still parses', eq(parseTopics('agents'), ['agents']));
  check('surrounding whitespace is trimmed',
    eq(parseTopics('  agents ,  diffusion  '), ['agents', 'diffusion']));
}

/* ------------------------------------------------------------- emptiness --- */
{
  for (const [label, v] of [['empty string', ''], ['undefined', undefined], ['null', null]]) {
    check(`${label} yields no topics`, eq(parseTopics(v), []));
  }
  // issue_to_yaml.mjs blanks "_No response_" before this sees it, but an empty
  // result has to be the answer either way — it is what raises the error the
  // submitter is shown.
  check('a blank optional field yields no topics', eq(parseTopics('\n  \n'), []));
}

/* ---------------------------------- the forms actually emit what we parse -- */
{
  // A parser that understands checkboxes is worthless if the templates still
  // declare a dropdown, so assert the two agree.
  for (const f of ['add-workshop.yml', 'edit-workshop.yml']) {
    const src = fs.readFileSync(path.join(ROOT, '.github', 'ISSUE_TEMPLATE', f), 'utf8');
    const field = src.slice(src.indexOf('id: topics') - 200, src.indexOf('topic-options:end'));
    check(`${f}: topics is a checkboxes field`, /type: checkboxes/.test(field));
    check(`${f}: no leftover multi-select dropdown`, !/multiple: true/.test(field));
    check(`${f}: options are labelled mappings that show the id and then the label`, /- label: "agents — Agents"/.test(field) && /- label: "graphs — Graphs & geometry"/.test(field) && /- label: "other"/.test(field),
      'checkboxes options are mappings; bare scalars are dropdown syntax');
  }

  // `validations: required` is not supported on checkboxes — GitHub silently
  // ignores it, so leaving it would look like enforcement that is not there.
  const add = fs.readFileSync(path.join(ROOT, '.github', 'ISSUE_TEMPLATE', 'add-workshop.yml'), 'utf8');
  const after = add.slice(add.indexOf('topic-options:end'), add.indexOf('topic-options:end') + 120);
  check('add-workshop.yml drops the unsupported required validation on topics',
    !/validations:\s*\n\s*required: true/.test(after),
    'issue_to_yaml.mjs enforces this instead, and the workflow comments the error');
}

// --- Submission URL: the contributor path for a non-OpenReview portal -------
// The corpus was 929/929 OpenReview when this field was added, so nothing had
// ever needed it. A `cmt` or `other` portal without it renders as the bare word
// "CMT" with nothing to click.
{
  const form = fs.readFileSync(new URL('../.github/ISSUE_TEMPLATE/add-workshop.yml', import.meta.url), 'utf8');
  check('the add form offers a Submission URL field', /label: Submission URL/.test(form), true);
  check('...and tells contributors to leave it empty for OpenReview',
    /leave this empty for those/i.test(form), true);
}

console.log(failed === 0 ? '\nIssue-form parsing OK.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
