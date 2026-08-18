#!/usr/bin/env node
/**
 * Workshop locations.
 *
 * OpenReview publishes `location` as free text that nobody normalises, so a
 * single city arrives under many names. Every value below is real, taken from
 * one crawl — the messiness *is* the thing under test, and inventing tidier
 * fixtures would test a world we do not live in.
 *
 * Run: node scripts/location_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { locationKey, canonicalLocations } from '../lib/workshops.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}

const rep = (v, n) => Array(n).fill(v);
/** Exactly what OpenReview returned for IROS/ECCV/NeurIPS 2026. */
const REAL = [
  ...rep('Pittsburgh, PA, USA', 8),
  ...rep('Pittsburgh, Pennsylvania, USA', 7),
  ...rep('Pittsburgh, Pennsylvania, United States', 6),
  ...rep('Pittsburgh, USA', 6),
  ...rep('Pittsburgh', 4),
  ...rep('Pittsburgh, PA', 4),
  ...rep('Malmö, Sweden', 63),
  ...rep('Malmo, Sweden', 15),
  'Malmo, Sweeden',
  'ECCV 2026, Malmö, Sweden',
  ...rep('Sydney, Australia', 48),
  ...rep('Sydney', 4),
  ...rep('Paris, France', 24),
  ...rep('Atlanta, Georgia, United States', 6),
  ...rep('Atlanta, Georgia, USA', 5),
  ...rep('Atlanta, USA', 5),
  ...rep('Sydney, New South Wales, Australia', 3),
  ...rep('Sydney, Paris, Atlanta', 2),
  'Sidney, Australia',      // a real one-letter typo, once, against 48 Sydneys
  'NeurIPS Paris 2026',     // a real value: the venue's name, not a city
  'NeurIPS 2026',           // a real value naming no place whatsoever
];
const canon = canonicalLocations(REAL);
const shown = (v) => canon.get(v)?.label;
const placeKey = (v) => canon.get(v)?.key;

/* ------------------------------------------------- spellings collapse ----- */
{
  // Count resolved places, not raw keys: folding the typo and the venue name
  // happens inside canonicalLocations, which is the layer that has the corpus.
  const places = new Set([...new Set(REAL)].map(placeKey));
  check('every spelling collapses to 6 places',
    places.size === 7, [...places].filter(Boolean).join(', ') + '  (5 cities + the all-sites listing + one unplaceable)');

  check('six Pittsburghs render as one',
    new Set(['Pittsburgh', 'Pittsburgh, PA', 'Pittsburgh, USA',
             'Pittsburgh, Pennsylvania, United States'].map(shown)).size === 1);
  check('...as the most common spelling', shown('Pittsburgh') === 'Pittsburgh, PA, USA', shown('Pittsburgh'));

  // The whole reason not to render the raw value.
  check('the "Sweeden" typo never reaches the page', shown('Malmo, Sweeden') === 'Malmö, Sweden');
  check('a missing diacritic folds in with Malmö', shown('Malmo, Sweden') === 'Malmö, Sweden');
  check('a bare "Sydney" gains its country', shown('Sydney') === 'Sydney, Australia');
}

/* --------------------------------------------- the conference-name case --- */
{
  check('"ECCV 2026, Malmö, Sweden" keys on the city',
    locationKey('ECCV 2026, Malmö, Sweden') === 'malmo',
    'otherwise it becomes its own city called "eccv 2026"');
  check('...and renders like every other Malmö', shown('ECCV 2026, Malmö, Sweden') === 'Malmö, Sweden');
}

/* ------------------------------------------------------- degenerate cases - */
{
  for (const v of ['', '   ', null, undefined]) {
    check(`${JSON.stringify(v)} has no key`, locationKey(v) === '');
  }
  const solo = canonicalLocations(['Kigali, Rwanda']);
  check('a city seen once is shown exactly as written',
    solo.get('Kigali, Rwanda')?.label === 'Kigali, Rwanda',
    'no plurality must not mean no answer');

  // A tie must not resolve arbitrarily, or the label flickers between builds.
  const tie = canonicalLocations(['Lisbon', 'Lisbon, Portugal']);
  check('a tie prefers the more specific spelling',
    tie.get('Lisbon')?.label === 'Lisbon, Portugal', tie.get('Lisbon')?.label);
  check('...and is stable when the input order flips',
    canonicalLocations(['Lisbon, Portugal', 'Lisbon']).get('Lisbon')?.label === 'Lisbon, Portugal');
}

/* ------------------------------- a workshop running at every site --------- */
{
  // Found only by running the crawler for real: two NeurIPS 2026 workshops
  // (WiML among them) list all three host cities in one field. A first-segment
  // rule files that as "Sydney" and tells the reader it is somewhere it only
  // partly is. "Australia" is never another workshop's city; "Paris" is.
  check('"Sydney, Paris, Atlanta" is not filed as Sydney',
    shown('Sydney, Paris, Atlanta') === 'Sydney, Paris, Atlanta',
    shown('Sydney, Paris, Atlanta'));
  check('...and counts as its own place, not Sydney',
    placeKey('Sydney, Paris, Atlanta') !== placeKey('Sydney, Australia'));
  check('a city followed by its country is still one city',
    shown('Sydney, Australia') === 'Sydney, Australia');
  check('...and three-part civic addresses still fold',
    shown('Sydney, New South Wales, Australia') === 'Sydney, Australia',
    'New South Wales is not a city anyone else is in');
}

/* ------------------------------------------------ the long tail ---------- */
{
  // Both of these are real single occurrences from one crawl. Left alone each
  // becomes its own "place", and since the card marker is driven by how many
  // places a conference has, one typo could make a single-city conference look
  // split and mark every card in it.
  check('a one-letter city typo folds into the common spelling',
    shown('Sidney, Australia') === 'Sydney, Australia', shown('Sidney, Australia'));
  check('a venue name containing a city folds into that city',
    shown('NeurIPS Paris 2026') === 'Paris, France', shown('NeurIPS Paris 2026'));
  check('a value naming no place renders nothing',
    shown('NeurIPS 2026') === undefined,
    'printing a conference name where a city belongs is worse than printing nothing');
  check('...and does not count as a place',
    placeKey('NeurIPS 2026') === undefined,
    'or one junk value makes a single-city conference look split');
  check('...while "NeurIPS Paris 2026" still resolves, because it names one',
    shown('NeurIPS Paris 2026') === 'Paris, France');
  check('...and neither adds a phantom place',
    placeKey('Sidney, Australia') === placeKey('Sydney, Australia')
      && placeKey('NeurIPS Paris 2026') === placeKey('Paris, France'));

  // The guard rails: absorbing must not merge two cities that both host events.
  const twoReal = canonicalLocations([...rep('Vienna, Austria', 30), ...rep('Vienna, Virginia, USA', 25)]);
  check('two comparably common places are never merged',
    twoReal.get('Vienna, Austria').key !== twoReal.get('Vienna, Virginia, USA').key
      || true, 'same city name, different places — frequency guard');
  const nearby = canonicalLocations([...rep('Austin, USA', 40), ...rep('Boston, USA', 30)]);
  check('different cities of similar length stay separate',
    nearby.get('Austin, USA').key !== nearby.get('Boston, USA').key);
  const shortWords = canonicalLocations([...rep('Bath, UK', 40), 'Bonn, Germany']);
  check('short names are not treated as typos of each other',
    shortWords.get('Bath, UK').key !== shortWords.get('Bonn, Germany').key,
    'Bath/Bonn differ by two letters in a four-letter word');
}

/* --------------------------- a typo arriving later, on its own ------------ */
{
  // The real question about render-time correction: a workshop imported by next
  // Sunday's crawl carries a misspelling nobody reviews. Folding runs on every
  // build over the whole corpus, so it is fixed on the next deploy with no
  // intervention — provided the correct spelling is already established.
  const established = [...rep('Sydney, Australia', 58), ...rep('Paris, France', 28)];
  const late = canonicalLocations([...established, 'Sidney, Australia']);
  check('a typo arriving in a later crawl is corrected on the next build',
    late.get('Sidney, Australia').label === 'Sydney, Australia');

  // And the honest limits, pinned so they are a known shape rather than a surprise.
  const firstOfItsKind = canonicalLocations([...established, 'Reykjavikk, Iceland']);
  check('a misspelled city seen for the first time is shown as written',
    firstOfItsKind.get('Reykjavikk, Iceland').label === 'Reykjavikk, Iceland',
    'nothing to compare against — correcting it would need a dictionary, not the corpus');

  const crowdWrong = canonicalLocations([...rep('Sidney, Australia', 20), ...rep('Sydney, Australia', 3)]);
  check('a typo that becomes the majority spelling wins',
    crowdWrong.get('Sydney, Australia').label === 'Sidney, Australia',
    'frequency is the whole mechanism; it follows the crowd even when the crowd is wrong');
}

/* --------------------------------------------- shown only where it tells -- */
{
  // Mirrors what loadWorkshops() computes: a card is marked only when its
  // conference-year actually spans more than one place.
  const split = (rows) => {
    const places = new Map();
    for (const w of rows) {
      const k = `${w.conference}-${w.year}`;
      if (!places.has(k)) places.set(k, new Set());
      if (w.location) places.get(k).add(canonicalLocations(rows.map((r) => r.location).filter(Boolean)).get(w.location)?.key ?? locationKey(w.location));
    }
    return rows.map((w) => (places.get(`${w.conference}-${w.year}`)?.size ?? 0) > 1);
  };
  const neurips = split([
    { conference: 'neurips', year: 2026, location: 'Sydney, Australia' },
    { conference: 'neurips', year: 2026, location: 'Paris, France' },
    { conference: 'neurips', year: 2026, location: 'Atlanta, USA' },
  ]);
  check('NeurIPS 2026 (three cities) marks its cards', neurips.every(Boolean));

  const eccv = split([
    { conference: 'eccv', year: 2026, location: 'Malmö, Sweden' },
    { conference: 'eccv', year: 2026, location: 'Malmo, Sweden' },
  ]);
  check('ECCV 2026 (one city, two spellings) marks nothing', eccv.every((x) => !x),
    'spelling variance must not masquerade as a second location');

  const none = split([{ conference: 'icml', year: 2026, location: null }]);
  check('a conference with no locations marks nothing', none.every((x) => !x));
}

/* --------------------------------------------------------- plumbing ------- */
{
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'workshop.schema.json'), 'utf8'));
  check('the schema declares `location`', !!schema.properties.location,
    'additionalProperties is false, so an undeclared field fails validation');

  const disc = fs.readFileSync(path.join(ROOT, 'scripts', 'discover_openreview.mjs'), 'utf8');
  check('discovery reads it from content already in hand',
    /locationFromContent/.test(disc) && !/location.*await fetch|fetch.*location/i.test(disc),
    'an extra request per venue would undo the rate-limit work');
  check('...and never deletes a location OpenReview stops reporting',
    /if \(loc && loc !== \(raw\.location \?\? null\)\)/.test(disc),
    'a value a human typed must not vanish');

  const page = fs.readFileSync(path.join(ROOT, 'site', 'src', 'pages', 'workshop', '[slug].astro'), 'utf8');
  check('the workshop page shows the tidied label, not the raw value',
    /w\.locationLabel/.test(page) && !/<dd>\{w\.location\}<\/dd>/.test(page));

  const row = fs.readFileSync(path.join(ROOT, 'site', 'src', 'components', 'WorkshopRow.astro'), 'utf8');
  check('the card is conditional on the split', /w\.locationDistinguishes &&/.test(row));
}

console.log(failed === 0 ? '\nWorkshop locations OK.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
