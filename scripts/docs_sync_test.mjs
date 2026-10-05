#!/usr/bin/env node
/**
 * Docs-sync guard. The workshop schema (schema/workshop.schema.json) is the
 * single source of truth for which fields a workshop YAML may have. This test
 * fails if a field exists in the schema but is NOT documented in the two
 * contributor-facing places that are supposed to mirror it:
 *
 *   1. CONTRIBUTING.md  — the "Field reference" table (a `| \`field\` |` row)
 *   2. data/workshops/_template.yml — present as a key `field:` or as a
 *      commented mention `# field:` / `name: "Full"`-style example
 *
 * Why this exists: new fields kept shipping in code + schema while these docs
 * silently fell behind (it took a human noticing). A mechanical check can't be
 * forgotten across sessions the way a written rule can — if you add a field to
 * the schema, CI now makes you document it before the PR can merge clean.
 *
 * Scope/limits: this enforces that every field is MENTIONED, not that the
 * description is accurate, and it only covers field drift — behavior-only
 * changes (e.g. new status logic with no new field) still need human review.
 *
 * Run: node scripts/docs_sync_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const schema = JSON.parse(read('schema/workshop.schema.json'));
const fields = Object.keys(schema.properties);

const contributing = read('CONTRIBUTING.md');
const template = read('data/workshops/_template.yml');

// CONTRIBUTING field-reference rows look like:  | `field` | … | … |
const documentedInContributing = new Set(
  [...contributing.matchAll(/^\|\s*`([a-z_]+)`\s*\|/gim)].map((m) => m[1]),
);

// Template: a field counts as present if it appears as an active key
// (`field:`) OR is mentioned in a comment (commented-out optional fields like
// `# tracks:` or example lines such as `#   - { name: ... }` are legitimate).
function inTemplate(field) {
  const activeKey = new RegExp(`^\\s*${field}\\s*:`, 'm');
  const commentedKey = new RegExp(`#.*\\b${field}\\b`);
  return activeKey.test(template) || commentedKey.test(template);
}

const missingFromContributing = fields.filter((f) => !documentedInContributing.has(f));
const missingFromTemplate = fields.filter((f) => !inTemplate(f));

let failed = false;
function report(label, missing, hint) {
  if (missing.length === 0) {
    console.log(`✓ ${label}: all ${fields.length} schema fields present`);
    return;
  }
  failed = true;
  console.log(`✗ ${label}: missing ${missing.length} field(s): ${missing.join(', ')}`);
  console.log(`  ${hint}`);
}

report(
  'CONTRIBUTING.md field table',
  missingFromContributing,
  'Add a row `| `<field>` | <required?> | <format/notes> |` to the Field reference table.',
);
report(
  'data/workshops/_template.yml',
  missingFromTemplate,
  'Add the field (or a commented example) to the template so contributors can discover it.',
);

// Reverse direction: a documented field that no longer exists in the schema is
// also drift (a removed field left dangling in the docs).
const stale = [...documentedInContributing].filter((f) => !fields.includes(f));
if (stale.length) {
  failed = true;
  console.log(`✗ CONTRIBUTING.md documents field(s) not in the schema: ${stale.join(', ')}`);
  console.log('  Remove the stale row(s) or restore the field to the schema.');
} else {
  console.log('✓ no stale fields documented in CONTRIBUTING.md');
}

// --- second drift: a test script that no workflow ever runs ----------------
// The step lists in the workflows are hand-maintained, so a new scripts/*_test.mjs
// is only as useful as somebody remembering to add it. Five had quietly gone
// unrun that way before this check existed — a guard nobody runs is worse than
// no guard, because it reads like coverage.
const WORKFLOWS = [
  '.github/workflows/validate.yml',
  '.github/workflows/alerts-ci.yml',
  // ui_test.mjs lives here: it needs a built site and a server, both of which
  // this job already has. shipped_ui_test.mjs too, on the second (alerts-
  // configured) build, since that is the only artefact carrying the scripts it
  // is written to catch.
  '.github/workflows/pr-build-check.yml',
  // smoke_test.mjs lives here: it needs a deployed site rather than a built
  // one, so it cannot run in any of the jobs above.
  '.github/workflows/smoke.yml',
];
// Empty on purpose. Anything added here needs a reason in the comment, because
// an allowlist is where a guard goes to stop guarding quietly.
const NOT_IN_CI_ON_PURPOSE = new Set();

const testFiles = fs
  .readdirSync(path.join(ROOT, 'scripts'))
  .filter((f) => f.endsWith('_test.mjs'))
  .filter((f) => !NOT_IN_CI_ON_PURPOSE.has(f));
const wired = WORKFLOWS.map((w) => read(w)).join('\n');
const unwired = testFiles.filter((f) => !wired.includes(f));
if (unwired.length) {
  failed = true;
  console.log(`✗ test script(s) that no workflow runs: ${unwired.join(', ')}`);
  console.log(`  Add a step to ${WORKFLOWS.join(' or ')} (or allowlist it in NOT_IN_CI_ON_PURPOSE with a reason).`);
} else {
  console.log(`✓ every test script runs in CI (${testFiles.length} wired, ${NOT_IN_CI_ON_PURPOSE.size} allowlisted)`);
}

// --- third drift: a workflow step whose exit code is thrown away -----------
// GitHub's default `run:` shell is `bash -e {0}` — no pipefail — so a step that
// pipes a command into `tee` reports tee's status and passes whatever the
// command did. smoke.yml shipped that way and would have reported the live site
// healthy under any failure, which is the exact shape of bug it exists to
// catch. `shell: bash` is GitHub's own opt-in (`bash --noprofile --norc -eo
// pipefail`), so requiring it wherever a step pipes is the general rule.
{
  const wfDir = path.join(ROOT, '.github', 'workflows');
  const offenders = [];
  for (const f of fs.readdirSync(wfDir).filter((n) => n.endsWith('.yml'))) {
    const src = fs.readFileSync(path.join(wfDir, f), 'utf8');
    // Steps are `- name:`-separated; good enough to attribute a pipe to a step.
    for (const step of src.split(/\n(?=\s*- (?:name|uses|run):)/)) {
      if (!/\|\s*tee\b/.test(step)) continue;
      if (/^\s*shell:\s*bash\s*$/m.test(step) || /set -o pipefail/.test(step)) continue;
      offenders.push(`${f}: ${(step.match(/- name: (.+)/) ?? [, '(unnamed step)'])[1]}`);
    }
  }
  if (offenders.length) {
    failed = true;
    console.log(`✗ workflow step(s) piping into tee without pipefail: ${offenders.join('; ')}`);
    console.log('  Add `shell: bash` to the step, or the pipe swallows the command\'s exit code.');
  } else {
    console.log('✓ no workflow throws away an exit code through a pipe');
  }
}

// --- fourth drift: a data write that can be dropped while it waits ----------
// `cancel-in-progress: false` only spares the RUNNING job. GitHub keeps one
// pending run per group by default and cancels it when the next one queues, so
// in `data-write`, where every run is a different job, a waiting write simply
// vanished: the 2026-08-14 blank-deadline backfill, behind a manual discovery
// run, replaced by the track sync. `queue: max` keeps them all
// (AUTOMATION.md, "The data jobs are serialised"). A run that waited must
// also check out the branch tip when its job starts: without a `ref`, checkout
// fetches the commit the run was QUEUED on, so it computes and validates the
// tree from before the push of the run ahead of it (the 2026-08-14 track sync
// fetched 11ca701 fourteen seconds after discovery's 3b4e8b3 landed on it).
// Separately, anything that
// pushes to `main` must be serialised by SOME group that never cancels a run
// mid-push; `alerts` is deliberately its own group, which is allowed.
{
  const PUSHES = /\.\/\.github\/actions\/publish-data|\bgit push\b/;
  const concurrencyProblems = (src) => {
    const wf = yaml.load(src) ?? {};
    const c = typeof wf.concurrency === 'string' ? { group: wf.concurrency } : wf.concurrency;
    const problems = [];
    if (c?.group === 'data-write') {
      if (c['cancel-in-progress'] !== false) problems.push('data-write without `cancel-in-progress: false`');
      if (c.queue !== 'max') problems.push('data-write without `queue: max` (a waiting run is cancelled when the next queues)');
      const checkouts = Object.values(wf.jobs ?? {}).flatMap((j) => j.steps ?? [])
        .filter((st) => /^actions\/checkout@/.test(st.uses ?? ''));
      if (checkouts.some((st) => !['${{ github.ref }}', 'main', 'refs/heads/main'].includes(st.with?.ref)))
        problems.push('data-write checkout without `ref: ${{ github.ref }}` (a queued run would compute on a stale main)');
    }
    if (PUSHES.test(src)) {
      if (!c?.group) problems.push('pushes to main with no concurrency group');
      else if (c['cancel-in-progress'] === true) problems.push('pushes to main in a group that cancels in-progress runs');
    }
    return problems;
  };
  const wfFixture = (concurrency, run = 'node scripts/x.mjs', checkout = '') =>
    `name: x\non: { workflow_dispatch: {} }\n${concurrency}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n${checkout}      - run: ${run}\n`;
  const DW = 'concurrency: { group: data-write, cancel-in-progress: false, queue: max }';
  const fixtures = [
    ['a data-write job with queue: max passes',
      wfFixture('concurrency: { group: data-write, cancel-in-progress: false, queue: max }', 'git push'), 0],
    ['a data-write job without queue: max fails',
      wfFixture('concurrency: { group: data-write, cancel-in-progress: false }', 'git push'), 1],
    ['a job that pushes with no group fails', wfFixture('', 'git push'), 1],
    ['a job that pushes in a cancel-in-progress group fails',
      wfFixture('concurrency: { group: own, cancel-in-progress: true }', 'git push'), 1],
    ['a job that pushes in its own non-cancelling group passes',
      wfFixture('concurrency: { group: alerts, cancel-in-progress: false }', 'git push'), 0],
    ['a read-only job needs no group', wfFixture(''), 0],
    ['a data-write checkout of the branch tip passes',
      wfFixture(DW, 'git push', '      - uses: actions/checkout@v7\n        with: { ref: "${{ github.ref }}" }\n'), 0],
    ['a data-write checkout of the queued commit fails',
      wfFixture(DW, 'git push', '      - uses: actions/checkout@v7\n'), 1],
  ];
  const wrong = fixtures.filter(([, src, n]) => concurrencyProblems(src).length !== n).map(([label]) => label);
  const wfDir = path.join(ROOT, '.github', 'workflows');
  const offenders = fs.readdirSync(wfDir).filter((n) => n.endsWith('.yml'))
    .flatMap((f) => concurrencyProblems(fs.readFileSync(path.join(wfDir, f), 'utf8')).map((p) => `${f}: ${p}`));
  if (wrong.length || offenders.length) {
    failed = true;
    if (wrong.length) console.log(`✗ the concurrency check misjudges its fixtures: ${wrong.join('; ')}`);
    if (offenders.length) console.log(`✗ workflow(s) that can lose or interrupt a write to main: ${offenders.join('; ')}`);
  } else {
    console.log('✓ every write to main is serialised, and no queued data write is dropped or computed on a stale main');
  }
}

console.log(
  failed
    ? '\nDocs/CI are out of sync. Update the files above, then re-run.'
    : '\nSchema ↔ docs in sync.',
);
process.exit(failed ? 1 : 0);
