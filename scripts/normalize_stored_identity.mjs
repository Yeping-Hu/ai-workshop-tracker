#!/usr/bin/env node
/**
 * Apply the import-time identity rules to every stored entry.
 *
 * The importer normalises `name` and `acronym` on the way in (28f39be), but
 * entries written before that kept whatever upstream supplied — "CVPR 2025
 * Workshop PVUW", "Re-Data-COLM2026", "MELT Workshop @ COLM 2025". That is a
 * stored-data problem, not a display one: the site strips venue noise at render
 * time, so pages already read correctly. It shows up instead in the weekly
 * data-health report, where a stored value that merely predates the normalizer
 * is indistinguishable from a real rename.
 *
 * This sweep runs the SAME functions the importer uses — no separate rule set,
 * nothing keyed to a slug — so re-running it is a no-op once the corpus is
 * clean.
 *
 *   node scripts/normalize_stored_identity.mjs --dry-run
 *   node scripts/normalize_stored_identity.mjs
 */
import fs from 'node:fs';
import * as yaml from 'js-yaml';
import {
  listWorkshopFiles,
  readWorkshopFile,
  loadConferences,
  stripVenueFromName,
  normalizeAcronym,
} from '../lib/workshops.mjs';

const dryRun = process.argv.includes('--dry-run');
const confs = Object.fromEntries(loadConferences().map((c) => [c.id, c]));

let changed = 0;
const rows = [];
for (const file of listWorkshopFiles()) {
  const { slug, raw } = readWorkshopFile(file);
  if (!raw) continue;
  const meta = confs[raw.conference] ?? {};
  const ctx = { confName: meta.name ?? raw.conference, confFullName: meta.full_name, year: raw.year };

  const nextName = raw.name ? stripVenueFromName(raw.name, ctx) : raw.name;
  const nextAcro = raw.acronym ? normalizeAcronym(raw.acronym, { ...ctx, conf: raw.conference }) : raw.acronym;

  const nameChanged = raw.name && nextName !== raw.name;
  const acroChanged = raw.acronym != null && nextAcro !== raw.acronym;
  if (!nameChanged && !acroChanged) continue;

  rows.push({
    slug,
    name: nameChanged ? [raw.name, nextName] : null,
    acronym: acroChanged ? [raw.acronym, nextAcro] : null,
  });
  changed += 1;
  if (dryRun) continue;

  if (nameChanged) raw.name = nextName;
  if (acroChanged) {
    // An acronym that normalises to nothing was only ever naming the venue.
    if (nextAcro) raw.acronym = nextAcro;
    else delete raw.acronym;
  }
  fs.writeFileSync(file, yaml.dump(raw, { lineWidth: 200, quotingType: '"' }));
}

for (const r of rows) {
  console.log(`  ${r.slug}`);
  if (r.name) console.log(`     name    ${JSON.stringify(r.name[0])} -> ${JSON.stringify(r.name[1])}`);
  if (r.acronym) console.log(`     acronym ${JSON.stringify(r.acronym[0])} -> ${JSON.stringify(r.acronym[1])}`);
}
console.log(`\n${changed} entr${changed === 1 ? 'y' : 'ies'} ${dryRun ? 'would be' : ''} normalised${dryRun ? ' (dry run)' : ''}.`);
