#!/usr/bin/env node
/**
 * Wire a new conference through all four touchpoints in one command:
 *   1. data/conferences.yml            (metadata, color, typical month)
 *   2. scripts/discover_openreview.mjs (OpenReview venue-id template)
 *   3. .github/workflows/discover.yml  (weekly auto-discovery loop)
 *   4. .github/ISSUE_TEMPLATE/add-workshop.yml (community form dropdown)
 *
 * Usage:
 *   node scripts/add_conference.mjs \
 *     --id emnlp --name EMNLP \
 *     --full-name "Conference on Empirical Methods in Natural Language Processing" \
 *     --prefix "EMNLP/{year}/Workshop" --color "#0E7490" --month 11 \
 *     [--website https://...] [--dry-run]
 *
 * The command is idempotent: touchpoints already containing the id are
 * skipped with a note. After wiring, it prints the import/verify/ship steps.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--dry-run') args.dryRun = true;
  else if (argv[i].startsWith('--')) args[argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
}

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
const { id, name, fullName, prefix, color, month } = args;
if (!id || !name || !fullName || !prefix || !color || !month)
  fail('required: --id --name --full-name --prefix --color --month  (optional: --website, --dry-run)');
if (!/^[a-z][a-z0-9-]*$/.test(id)) fail(`--id must be lowercase slug-like, got "${id}"`);
if (!prefix.includes('{year}')) fail(`--prefix must contain {year}, got "${prefix}"`);
if (!/^#[0-9A-Fa-f]{6}$/.test(color)) fail(`--color must be a 6-digit hex, got "${color}"`);
const m = Number(month);
if (!Number.isInteger(m) || m < 1 || m > 12) fail(`--month must be 1-12, got "${month}"`);
const domain = prefix.split('/')[0];
const website = args.website ?? (domain.includes('.') ? `https://${domain}` : null);
if (!website) fail(`--website required (prefix "${prefix}" does not start with a domain)`);

const FILES = {
  conf: 'data/conferences.yml',
  discover: 'scripts/discover_openreview.mjs',
  workflow: '.github/workflows/discover.yml',
  form: '.github/ISSUE_TEMPLATE/add-workshop.yml',
};
const src = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, readFileSync(f, 'utf8')]));
const out = { ...src };
const notes = [];

// -- guards on uniqueness ----------------------------------------------------
if (new RegExp(`^- id: ${id}$`, 'm').test(src.conf)) notes.push(`conferences.yml already has id "${id}" — skipped`);
const usedColors = [...src.conf.matchAll(/color: "(#[0-9A-Fa-f]{6})"/g)].map((x) => x[1].toLowerCase());
if (usedColors.includes(color.toLowerCase()) && !notes.length)
  fail(`color ${color} is already used by another conference — pick a distinct hue (in use: ${usedColors.join(', ')})`);

// -- 1. conferences.yml -------------------------------------------------------
if (!notes.some((n) => n.includes('conferences.yml'))) {
  out.conf = src.conf.replace(/\s*$/, '\n') + `- id: ${id}
  name: "${name}"
  full_name: "${fullName}"
  website: "${website}"
  color: "${color}"
  typical_month: ${m}
`;
}

// -- 2. discovery template map ------------------------------------------------
if (new RegExp(`^\\s{2}${id}:`, 'm').test(src.discover)) {
  notes.push(`discovery template already has "${id}" — skipped`);
} else {
  const re = /(const CONF_TEMPLATE = \{[\s\S]*?)(\n\};)/;
  if (!re.test(src.discover)) fail('could not locate CONF_TEMPLATE map in discover_openreview.mjs');
  out.discover = src.discover.replace(re, `$1\n  ${id}: '${prefix}',$2`);
}

// -- 3. weekly workflow loop --------------------------------------------------
{
  const re = /for c in ([a-z0-9 -]+); do/;
  const cur = src.workflow.match(re);
  if (!cur) fail('could not locate the conference loop in discover.yml');
  if (cur[1].split(/\s+/).includes(id)) notes.push(`discover.yml loop already has "${id}" — skipped`);
  else out.workflow = src.workflow.replace(re, `for c in ${cur[1]} ${id}; do`);
}

// -- 4. issue form dropdown ---------------------------------------------------
{
  const re = /options: \[([a-z0-9, -]+)\]/;
  const cur = src.form.match(re);
  if (!cur) fail('could not locate the conference dropdown in add-workshop.yml');
  if (cur[1].split(/,\s*/).includes(id)) notes.push(`issue form already has "${id}" — skipped`);
  else out.form = src.form.replace(re, `options: [${cur[1]}, ${id}]`);
}

// -- report / write -----------------------------------------------------------
for (const n of notes) console.log(`• ${n}`);
const changed = Object.keys(FILES).filter((k) => out[k] !== src[k]);
if (changed.length === 0) { console.log('Nothing to do — already fully wired.'); process.exit(0); }
if (args.dryRun) {
  console.log(`\n[dry-run] would update: ${changed.map((k) => FILES[k]).join(', ')}`);
  console.log(`[dry-run] conferences.yml block:\n${out.conf.slice(src.conf.replace(/\s*$/, '\n').length)}`);
} else {
  for (const k of changed) writeFileSync(FILES[k], out[k]);
  console.log(`✓ wired "${id}" into: ${changed.map((k) => FILES[k]).join(', ')}`);
}

const Y = new Date().getUTCFullYear();
console.log(`
Next steps (see skills/add-conference/SKILL.md for the full procedure):
  for y in ${Y - 1} ${Y} ${Y + 1}; do node scripts/discover_openreview.mjs --conf ${id} --year $y; sleep 1; done
  node scripts/validate.mjs
  # repeat until cache count == workshop count (OpenReview rate-limits; passes resume):
  timeout 140 node scripts/fetch_openreview.mjs
  cd site && npm run build && cd ..
  # gated suite, README sync, then push (only on green)
`);
