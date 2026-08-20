#!/usr/bin/env node
/**
 * The naming contract, enforced at the point of entry rather than after the fact.
 * Run: node scripts/entry_normalization_test.mjs
 *
 * stripVenueFromName() and cleanAcronym() have their own unit tests. This one
 * exists for a different failure: the functions staying correct while a CALL
 * SITE quietly disappears. A pure-function test cannot notice that, and the
 * corpus-level guard in acronym_identity_test.mjs only notices afterwards — on
 * whatever pull request happens to come next, blaming whoever opened it.
 *
 * So drive the real bot through its ISSUE_BODY contract, the same way
 * issue_tz_test.mjs does, and assert on what it actually writes to disk.
 *
 * Why the issue form matters as much as the OpenReview importer: it is the
 * contribution path CONTRIBUTING.md recommends first ("no Git needed"), and
 * contributors paste the workshop's own CFP heading, which routinely leads with
 * the venue — "NeurIPS 2026 Workshop on Machine Learning for Health" — and
 * write acronyms like "ML4H @ NeurIPS 2026". Before this was wired up the bot
 * stored both verbatim, replied "validation passed" on the issue, and then CI
 * failed the PR with an instruction to run a maintainer-only sweep script.
 *
 * The slug is checked too, and is the reason normalising in CI would not have
 * been enough: it is derived from these values, and unlike a name it is
 * permanent — it is the file name and the public URL, and fixing the name later
 * does not fix it.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOT = path.join(ROOT, 'scripts', 'issue_to_yaml.mjs');

let failed = 0;
function check(label, cond, detail = '') {
  if (!cond) failed++;
  console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : `  ${detail}`}`);
}

const body = ({ name, acronym }) => `### Workshop name

${name}

### Acronym

${acronym}

### Conference

neurips

### Year

2026

### Workshop website

https://example.org/ws

### Topics

other

### Deadline year

2026

### Deadline month

09

### Deadline day

01

### Timezone

AoE

### Submission portal

openreview`;

/** Run the real bot, read what it wrote, delete it, return name/acronym/slug. */
function run(fields) {
  let abs = null;
  try {
    const created = execFileSync('node', [BOT], {
      env: { ...process.env, ISSUE_BODY: body(fields) },
      encoding: 'utf8',
    }).trim().split('\n').pop();
    abs = path.isAbsolute(created) ? created : path.join(ROOT, created);
    const text = fs.readFileSync(abs, 'utf8');
    return {
      name: text.match(/^name:\s*(.+)$/m)?.[1].trim().replace(/^['"]|['"]$/g, '') ?? null,
      acronym: text.match(/^acronym:\s*(.*)$/m)?.[1].trim().replace(/^['"]|['"]$/g, '') ?? null,
      slug: path.basename(abs, '.yml'),
    };
  } finally {
    // Always remove the entry, even if an assertion above threw — this writes
    // into the real data/workshops/, so a leaked file would fail validate.mjs
    // for everyone afterwards.
    if (abs && fs.existsSync(abs)) fs.unlinkSync(abs);
  }
}

// --- the venue-prefixed CFP heading, the common real-world case -------------
let r = run({
  name: 'NeurIPS 2026 Workshop on Machine Learning for Health',
  acronym: 'ML4H @ NeurIPS 2026',
});
check('name loses its conference-year prefix', r.name === 'Machine Learning for Health', JSON.stringify(r));
check('acronym loses its trailing venue', r.acronym === 'ML4H', JSON.stringify(r));
check('slug is built from the cleaned values', r.slug === 'neurips-2026-ml4h', JSON.stringify(r));

// --- an "acronym" that is only the venue is dropped, not stored -------------
r = run({ name: 'NeurIPS 2026 Workshop on Agent Behavior', acronym: 'NeurIPS 2026' });
check('venue-only acronym is dropped', r.acronym === '' || r.acronym === null, JSON.stringify(r));
check('slug falls back to the cleaned name', r.slug === 'neurips-2026-agent-behavior', JSON.stringify(r));

// --- a clean submission must pass through untouched -------------------------
// The normalisation is anchored; it must not chew on a name that merely
// mentions a workshop or contains digits.
r = run({
  name: 'MATH-AI: The 4th Workshop on Mathematical Reasoning and AI',
  acronym: 'MATH-AI',
});
check('a clean name is left exactly as submitted', r.name === 'MATH-AI: The 4th Workshop on Mathematical Reasoning and AI', JSON.stringify(r));
check('a clean acronym is left exactly as submitted', r.acronym === 'MATH-AI', JSON.stringify(r));

console.log(failed ? `\n${failed} check(s) failed` : '\nEntry normalization is wired into the issue-form bot');
process.exit(failed ? 1 : 0);
