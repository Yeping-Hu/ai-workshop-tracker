#!/usr/bin/env node
/**
 * One-time sweep: take the conference and year back out of workshop names.
 *
 * The importer now strips them on arrival (see stripVenueFromName in
 * lib/workshops.mjs), but ~350 entries were imported before it did, and the
 * artifact shows wherever the full name is rendered — the workshop page's H1,
 * the conference hub's caption line, the RSS feed, /api/workshops.json.
 *
 * Rewrites only the `name:` line, leaving every other line and the file's key
 * order untouched, so the diff is exactly the names and nothing else. Prints
 * the change set and exits without writing unless --write is passed.
 *
 * Run:  node scripts/strip_venue_names.mjs            # preview
 *       node scripts/strip_venue_names.mjs --write    # apply
 *
 * This should be a no-op on a clean tree; acronym_identity_test.mjs fails if a
 * prefixed name ever lands again, which is the signal to re-run it (and to ask
 * how it got past the importer).
 */
import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { WORKSHOPS_DIR, listWorkshopFiles, loadConferences, stripVenueFromName } from '../lib/workshops.mjs';

const write = process.argv.includes('--write');
const confById = new Map(loadConferences().map((c) => [c.id, c]));

/** Re-emit just the `name:` scalar, preserving the rest of the file verbatim. */
function replaceNameLine(text, next) {
  // yaml.dump of a lone string gives a correctly quoted scalar (+ trailing \n).
  const scalar = yaml.dump(next, { lineWidth: -1 }).trimEnd();
  // A name may be written as a plain, single- or double-quoted scalar, and may
  // wrap onto continuation lines; replace through to the next top-level key.
  const re = /^name:[ \t]*(?:.*(?:\n[ \t]+.*)*)$/m;
  if (!re.test(text)) return null;
  return text.replace(re, `name: ${scalar}`);
}

const changes = [];
const skipped = [];
for (const file of listWorkshopFiles()) {
  const text = fs.readFileSync(file, 'utf8');
  const raw = yaml.load(text);
  if (!raw?.name) continue;
  const conf = confById.get(raw.conference) ?? {};
  const next = stripVenueFromName(raw.name, {
    confName: conf.name ?? raw.conference,
    confFullName: conf.full_name,
    year: raw.year,
  });
  if (next === String(raw.name).trim()) continue;

  const updated = replaceNameLine(text, next);
  if (updated === null) { skipped.push(path.basename(file)); continue; }
  // Re-parse and compare every OTHER field, so a botched line edit can't slip
  // through: only `name` may differ.
  const after = yaml.load(updated);
  const before = { ...raw }, cmp = { ...after };
  delete before.name; delete cmp.name;
  if (JSON.stringify(before) !== JSON.stringify(cmp) || after.name !== next) {
    skipped.push(`${path.basename(file)} (rewrite changed more than the name)`);
    continue;
  }
  changes.push({ file, text: updated, from: String(raw.name).trim(), to: next });
}

for (const c of changes) {
  console.log(path.basename(c.file, '.yml'));
  console.log(`   -  ${c.from}`);
  console.log(`   +  ${c.to}`);
}
for (const s of skipped) console.log(`!  skipped ${s}`);

console.log(`\n${changes.length} name(s) to rewrite, ${skipped.length} skipped, out of ${listWorkshopFiles().length} files`);
if (!write) {
  console.log('Preview only — pass --write to apply.');
  process.exit(0);
}
for (const c of changes) fs.writeFileSync(c.file, c.text);
console.log(`Wrote ${changes.length} file(s) under ${path.relative(process.cwd(), WORKSHOPS_DIR)}/`);
