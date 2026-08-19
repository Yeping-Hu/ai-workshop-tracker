#!/usr/bin/env node
/**
 * The invariant behind workshopShortName: within one conference-year, no two
 * entries may share a `full` short name. Runs against the real corpus.
 * Run: node scripts/acronym_identity_test.mjs
 *
 * Why this is a test and not a rule in a doc: the short name is what the page
 * <title> and the saved-list label are built from, so a collision is not
 * cosmetic. Two tracks of one workshop that share a name produce two pages with
 * the same <title> (search engines pick one and drop the other) and, worse, one
 * merged group on /saved/ — a reader who starred papers from both tracks can no
 * longer tell which track any of them came from.
 *
 * Collisions arrive from upstream, not from us: OpenReview gives sibling tracks
 * the same `subtitle`, so CVEU and CVEU_Extended_Abstract_Track both stored
 * "CVEU". The disambiguation is derived from the venue id via venueFamily(), so
 * a newly imported track is handled without anyone editing YAML — but only for
 * suffixes TRACK_SUFFIX recognises. When this test fails on a fresh import, the
 * fix is almost always to teach TRACK_SUFFIX the new suffix, not to hand-edit
 * the acronym.
 */
import { loadWorkshops, loadConferences, workshopShortName, venueFamily } from '../lib/workshops.mjs';

let failed = 0;
const fail = (msg) => { failed++; console.log(`✗ ${msg}`); };

const workshops = loadWorkshops();
const confName = new Map(loadConferences().map((c) => [c.id, c.name]));

// --- the invariant ---------------------------------------------------------
const byKey = new Map();
for (const w of workshops) {
  const cn = confName.get(w.conference) ?? w.conference;
  const key = `${w.conference}|${w.year}|${workshopShortName(w, cn).full.toLowerCase()}`;
  if (!byKey.has(key)) byKey.set(key, []);
  byKey.get(key).push(w);
}
const collisions = [...byKey.entries()].filter(([, g]) => g.length > 1);
for (const [key, group] of collisions) {
  const tails = group.map((w) => (w.openreview_venue_id || '').split('/').pop() || '(no venue id)');
  fail(
    `${group.length} entries share the short name "${key.split('|').pop()}" in ${key.split('|').slice(0, 2).join(' ')}\n` +
      group.map((w, i) => `      ${w.slug}  (venue tail: ${tails[i]})`).join('\n') +
      `\n      -> teach TRACK_SUFFIX in lib/workshops.mjs the distinguishing suffix`,
  );
}
if (!collisions.length) {
  console.log(`✓ short names unique within every conference-year (${workshops.length} entries)`);
}

// --- latent risk, reported but not enforced ------------------------------
// A sibling group needs at most one unlabelled member for its entries to be
// distinguishable *by label*. Some venue ids carry suffixes nothing can read
// ("AUTOPILOT-AT" vs "AUTOPILOT-NA"), leaving two unlabelled siblings that are
// today told apart only by having different names. That is fine — the check
// above is what actually has to hold — but it is one upstream rename away from
// becoming a collision, so it is worth seeing. Not a failure: labelling these
// would mean inventing meanings for two-letter suffixes, and widening
// TRACK_SUFFIX far enough to catch them would start eating real workshop names.
const groups = new Map();
for (const w of workshops) {
  if (!(w.relatedTracks ?? []).length || w.trackLabel) continue;
  const k = [w.slug, ...(w.relatedTracks ?? []).map((t) => t.slug)].sort().join(',');
  groups.set(k, [...(groups.get(k) ?? []), w]);
}
const fragile = [...groups.values()].filter((g) => g.length > 1);
for (const g of fragile) {
  console.log(
    `! ${g.length} unlabelled siblings, distinct only by name: ` +
      g.map((w) => `${w.slug} (${(w.openreview_venue_id || '').split('/').pop()})`).join('  vs  '),
  );
}
console.log(
  fragile.length
    ? `  (${fragile.length} such group(s) — informational, see the note above)`
    : '✓ every sibling group has at most one unlabelled (main) track',
);

// --- unit cases for the derivation itself ----------------------------------
const check = (label, got, expect) => {
  const ok = got === expect;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(expect)})`}`);
};
const at = (slug) => {
  const w = workshops.find((x) => x.slug === slug);
  if (!w) { fail(`fixture ${slug} not in corpus`); return { full: null }; }
  return workshopShortName(w, confName.get(w.conference) ?? w.conference);
};
// Sibling tracks are told apart by a label derived from the venue id, never by
// a parenthetical typed into the YAML.
check('base track keeps a bare name', at('cvpr-2026-cveu').full, 'CVEU');
check('sibling track gains its label', at('cvpr-2026-cveu-extended-abstract-track').full, 'CVEU (Extended Abstract Track)');
check('competition track labelled', at('colm-2026-aims-competition-track').full, 'AIMS (Competition Track)');
check('shared task labelled', at('colm-2026-social-sim-shared-task').full, "Social Sim'26 (Shared Task)");
// Venue noise in the stored acronym is stripped, not repeated.
check('acronym that is only the venue', at('neurips-2025-aiforanimalcomms').full, 'AI for Non-Human Animal Communication');
// TRACK_SUFFIX is the mechanism the failure message points at; keep it honest.
check('venueFamily reads the suffix', venueFamily('colmweb.org/COLM/2026/Workshop/Social_Sim_Shared_Task').suffixLabel, 'Shared Task');

console.log(failed ? `\n${failed} check(s) failed` : '\nAll short-name identity checks passed');
process.exit(failed ? 1 : 0);
