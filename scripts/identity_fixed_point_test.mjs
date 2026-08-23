#!/usr/bin/env node
/**
 * Every stored `name` and `acronym` must already be what the importer would
 * write — a fixed point of the normalizer.
 *
 * Two things this buys:
 *
 *  - A value that skips the import rules (a hand-edited entry, a new import
 *    path) fails here with the slug and the clean value, instead of surfacing
 *    weeks later as a phantom "rename" in the weekly data-health report. That is
 *    what 349 pre-normalizer acronyms did.
 *  - Improving the normalizer immediately lists exactly which stored rows the
 *    improvement now touches, so the re-sweep is a mechanical follow-up rather
 *    than a hunt.
 *
 * Run: node scripts/identity_fixed_point_test.mjs
 */
import {
  listWorkshopFiles,
  readWorkshopFile,
  loadConferences,
  stripVenueFromName,
  normalizeAcronym,
} from '../lib/workshops.mjs';

const confs = Object.fromEntries(loadConferences().map((c) => [c.id, c]));
const violations = [];

for (const file of listWorkshopFiles()) {
  const { slug, raw } = readWorkshopFile(file);
  if (!raw) continue;
  const meta = confs[raw.conference] ?? {};
  const venue = { confName: meta.name ?? raw.conference, confFullName: meta.full_name, year: raw.year };

  if (raw.acronym) {
    const clean = normalizeAcronym(raw.acronym, { ...venue, conf: raw.conference });
    if (clean !== raw.acronym) violations.push({ slug, field: 'acronym', stored: raw.acronym, clean });
  }
  if (raw.name) {
    const clean = stripVenueFromName(raw.name, venue);
    if (clean !== raw.name) violations.push({ slug, field: 'name', stored: raw.name, clean });
  }
}

for (const v of violations) {
  console.log(`✗ ${v.slug} — ${v.field} is not normalised`);
  console.log(`     stored:   ${JSON.stringify(v.stored)}`);
  console.log(`     expected: ${JSON.stringify(v.clean)}`);
}

if (violations.length) {
  console.log(
    `\n${violations.length} stored value(s) are not what the importer would write.\n` +
      `Run \`node scripts/normalize_stored_identity.mjs\` to bring the corpus back to a fixed point\n` +
      `(add --dry-run first to see the full list). Never hand-edit one entry to pass this — if the\n` +
      `expected value above is wrong, the normalizer rule is what needs changing.`,
  );
  process.exit(1);
}
console.log(`Checked ${listWorkshopFiles().length} entries: every stored name and acronym is already normalised.`);
