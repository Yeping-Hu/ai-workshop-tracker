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
const WORKFLOWS = ['.github/workflows/validate.yml', '.github/workflows/alerts-ci.yml'];
// ui_test.mjs is deliberately out: it drives a real browser against a preview
// server, which is a different shape of job from these. If it is ever wired in,
// drop it from here.
const NOT_IN_CI_ON_PURPOSE = new Set(['ui_test.mjs']);

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

console.log(
  failed
    ? '\nDocs/CI are out of sync. Update the files above, then re-run.'
    : '\nSchema ↔ docs in sync.',
);
process.exit(failed ? 1 : 0);
