#!/usr/bin/env node
/**
 * Two rules that keep URLs and <title>s honest after an import.
 *
 * 1. mergedSlugRedirects(): every venue recorded in `merged_venue_ids` maps
 *    back to the slug the importer would have given it, so the URL Google
 *    already knows keeps resolving after a merge. The IROS 2026 S2RCC merge is
 *    the live case — its old URL returned 404 with impressions still accruing.
 *
 * 2. workshopShortName(): an OpenReview venue tail used as an acronym arrives
 *    underscore-joined and often ends in the track it belongs to; the short
 *    name must not stutter ("GenAI4Health_Demonstration_Paper_Track
 *    (Demonstration Paper Track)") because that is a 100-character <title>.
 *
 * Run: node scripts/slug_redirects_test.mjs
 */
import { mergedSlugRedirects, slugify, workshopShortName, acronymInName, loadWorkshops, loadConferences } from '../lib/workshops.mjs';

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}

// --- slugify is the importer's rule, verbatim -------------------------------
check('slugify lowercases and hyphenates', slugify('Sim2Real-and-Control') === 'sim2real-and-control');
check('slugify trims to 40 chars', slugify('x'.repeat(60)).length === 40);
check('slugify never yields an empty slug', slugify('***') === 'workshop');

// --- redirects come from data, not from a list ------------------------------
const redirects = mergedSlugRedirects();
const workshops = loadWorkshops();
const live = new Set(workshops.map((w) => w.slug));
check(
  'every redirect source is a slug that no longer exists',
  [...redirects.keys()].every((k) => !live.has(k)),
  [...redirects.keys()].filter((k) => live.has(k)).join(', '),
);
check(
  'every redirect target is a live workshop',
  [...redirects.values()].every((v) => live.has(v)),
  [...redirects.values()].filter((v) => !live.has(v)).join(', '),
);
check(
  'a redirect is reconstructed for every merged venue whose slug is gone',
  workshops
    .flatMap((w) => (w.merged_venue_ids ?? []).map((id) => [w, id]))
    .every(([w, id]) => {
      const old = `${w.conference}-${w.year}-${slugify(String(id).split('/').pop())}`;
      return old === w.slug || live.has(old) || redirects.get(old) === w.slug;
    }),
);
// The case that motivated this: pinned so a data edit cannot quietly drop it.
check(
  'iros-2026-sim2real-and-control → iros-2026-s2rcc (if that entry still carries the merge)',
  !live.has('iros-2026-s2rcc') ||
    !workshops.find((w) => w.slug === 'iros-2026-s2rcc')?.merged_venue_ids?.length ||
    redirects.get('iros-2026-sim2real-and-control') === 'iros-2026-s2rcc',
);

// --- short names do not stutter ---------------------------------------------
const conf = (id) => loadConferences().find((c) => c.id === id)?.name ?? id;
const name = (w) => workshopShortName(w, conf(w.conference)).full;
const fake = (acronym, trackLabel, extra = {}) => ({
  conference: 'neurips', year: 2026, name: 'A Workshop', acronym, trackLabel, ...extra,
});
check('underscores in a venue-tail acronym read as spaces',
  name(fake('Scalable_Tactile_Manipulation', null)) === 'Scalable Tactile Manipulation');
check('a track already ending the stem is said once',
  name(fake('GenAI4Health_Demonstration_Paper_Track', 'Demonstration Paper Track')) === 'GenAI4Health (Demonstration Paper Track)');
check('a bracketed partial track is the same stutter',
  name(fake('ML4RS (Main)', 'Main Track')) === 'ML4RS (Main Track)');
check('a stem carrying only the front of the track is trimmed too',
  name(fake('DexHAND Non-Proceedings', 'Non Proceedings Track')) === 'DexHAND (Non Proceedings Track)');
check('a stem that merely contains the track word mid-string is untouched',
  name(fake('Findings in Robotics', 'Findings')) === 'Findings in Robotics (Findings)');
check('an acronym with no track is untouched',
  name(fake('AIWILD', null)) === 'AIWILD');
check('nothing is ever stripped to an empty stem',
  name(fake('Main', 'Main Track')).startsWith('Main'));
// --- a name that states its own acronym uses it ------------------------------
check('"ACRO: subtitle" yields ACRO', acronymInName('OPT: Optimization for Machine Learning') === 'OPT');
check('"… - ACRO" yields ACRO', acronymInName('New Frontiers in Game-Theoretic Learning - NExT-Game') === 'NExT-Game');
check('"… (ACRO)" yields ACRO', acronymInName('Learning Effective Abstractions for Planning (LEAP)') === 'LEAP');
check('a plain word after a dash is not an acronym', acronymInName('Robot Learning - Overview') === null);
check('a bare number is not an acronym', acronymInName('Robot Learning - 2') === null);
check('a stored acronym always wins over one embedded in the name',
  name(fake('AIWILD', null, { name: 'Agents in the Wild - WILD' })) === 'AIWILD');
check('with no stored acronym the embedded one becomes the short name',
  name(fake(undefined, null, { name: 'OPT 2026: Optimization for Machine Learning' })) === 'OPT');

// Across the real corpus: no short name repeats its own track label twice.
const stutters = workshops.filter((w) => {
  if (!w.trackLabel) return false;
  const full = name(w).toLowerCase();
  const t = String(w.trackLabel).toLowerCase();
  return full.indexOf(t) !== full.lastIndexOf(t);
});
check('no live entry repeats its track label in its short name', stutters.length === 0,
  stutters.map((w) => w.slug).slice(0, 5).join(', '));

console.log(failed ? `\n${failed} check(s) failed` : '\nRedirects and short names are consistent');
process.exit(failed ? 1 : 0);
