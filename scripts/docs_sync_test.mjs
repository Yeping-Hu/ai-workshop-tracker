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

console.log(
  failed
    ? '\nDocs/CI are out of sync. Update the files above, then re-run.'
    : '\nSchema ↔ docs in sync.',
);
process.exit(failed ? 1 : 0);
