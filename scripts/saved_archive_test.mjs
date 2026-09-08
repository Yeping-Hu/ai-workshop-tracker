#!/usr/bin/env node
/**
 * Where /saved/ cuts its Workshops section in two, and the demo the empty
 * shelf offers. Run: node scripts/saved_archive_test.mjs
 *
 * The saved list used to be one flat list that only grew, so concluded
 * workshops buried the open calls. It now splits: board rows above, book spines
 * below. The split has to agree with the rest of the site about what "past"
 * means — a workshop shelved while its row still reads "Open call" is the
 * failure this file exists to prevent — so the first section asserts, across
 * the whole corpus, that site/src/scripts/archive-split.js and
 * lib/workshops.mjs take the same branch.
 *
 * The second section pins the demo shelf. It is drawn from the live API
 * rather than written down because a hand-authored demo list would be a data
 * artifact no pipeline maintains (standing rule 4).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isArchived, demoShelf } from '../site/src/scripts/archive-split.js';
import { deriveStatusLabel } from '../lib/workshops.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed++;
};

/* ---------------- the corpus ---------------- */
// Built output when it is there (the real shapes the page fetches), and a
// status-only stand-in otherwise, so this suite runs before `npm run build`.
const API = path.join(ROOT, 'site/dist/api/workshops.json');
let corpus;
if (fs.existsSync(API)) {
  corpus = JSON.parse(fs.readFileSync(API, 'utf8')).workshops;
  console.log(`— split rule vs. deriveStatusLabel (${corpus.length} workshops from the built API) —`);
} else {
  corpus = ['past', 'deadline_passed', 'upcoming', 'not_running'].map((status, i) => ({
    slug: `stand-in-${i}`, name: `Stand-in ${i}`, conference: 'icml', year: 2025, status,
  }));
  console.log('— split rule vs. deriveStatusLabel (no built API; every status once) —');
}

/* ---------------- one definition of "past" ---------------- */
const disagreements = corpus.filter((w) => isArchived(w) !== (deriveStatusLabel(w) === 'Past'));
check(
  'isArchived() and deriveStatusLabel() agree on every workshop in the corpus',
  disagreements.length === 0,
  disagreements.slice(0, 5).map((w) => `${w.slug} (${w.status})`).join(', '),
);

// Spelled out as well as compared, so deleting a status from one side cannot
// pass by making both sides wrong in the same way.
check('past is archived', isArchived({ status: 'past' }));
check('deadline_passed is archived', isArchived({ status: 'deadline_passed' }));
check('upcoming is not archived', !isArchived({ status: 'upcoming' }));
check('not_running is not archived', !isArchived({ status: 'not_running' }));

const seen = new Set(corpus.map((w) => w.status));
check('the corpus exercises more than one status', seen.size > 1, [...seen].join(', '));

/* ---------------- the demo shelf ---------------- */
// On its own fixture, not on the corpus above. These assertions are about how
// demoShelf SHAPES a shelf, which is pure — and validate.yml runs this suite
// without building the site, so the ambient corpus there is a stand-in with a
// single conference-year. Hanging group-shape checks off that meant the ones
// that could not run were skipped and the one that could not be skipped failed
// in CI while passing locally, where site/dist happened to exist.
console.log('— the demo shelf (fixture) —');

const FIXTURE = [
  ...['aaa-2030', 'bbb-2030', 'ccc-2029', 'ddd-2029', 'eee-2028', 'fff-2028'].flatMap((key) => {
    const [conference, year] = [key.slice(0, 3), Number(key.slice(4))];
    return Array.from({ length: 8 }, (_, i) => ({
      slug: `${key}-${i}`, name: `${key} ${i}`, conference, year: Number(year), status: 'past',
      deadline_utc: `${year}-0${(i % 9) + 1}-01T00:00:00.000Z`,
    }));
  }),
  // must never reach a shelf
  { slug: 'still-open', conference: 'aaa', year: 2030, status: 'upcoming' },
  { slug: 'cancelled', conference: 'aaa', year: 2030, status: 'not_running' },
];

const byGroup = (list) => {
  const n = new Map();
  for (const w of list) {
    const k = `${w.conference}-${w.year}`;
    n.set(k, (n.get(k) ?? 0) + 1);
  }
  return [...n.values()];
};

const demo = demoShelf(FIXTURE);
check('every demo volume is archived', demo.every(isArchived));
check('the demo is capped at the limit', demoShelf(FIXTURE, { limit: 12 }).length <= 12);
check(
  'the demo is deterministic',
  JSON.stringify(demoShelf(FIXTURE).map((w) => w.slug)) === JSON.stringify(demo.map((w) => w.slug)),
);
check('the demo holds no duplicates', new Set(demo.map((w) => w.slug)).size === demo.length);

// One row on a desktop plank, about 60% full, is the whole point of the
// default: the demo is an invitation, not a backlog. The width that follows
// from 16 is asserted in the browser by ui_test.mjs; the count is asserted here.
check('the default demo stays small enough for one shelf row', demo.length === 16, `${demo.length}`);
check(
  'each conference-year contributes its share of the pattern',
  JSON.stringify(byGroup(demo)) === JSON.stringify([4, 2, 5, 3, 2]),
  byGroup(demo).join(','),
);
// Equal-sized groups read as a generated grid rather than a shelf.
check('the groups are uneven', new Set(byGroup(demo)).size > 1, byGroup(demo).join(','));
// The break captions between groups are half of what the shelf looks like, so
// a demo drawn from one conference-year would demo the wrong thing.
check('the demo spans several conference-years', byGroup(demo).length > 1, `${byGroup(demo).length} group(s)`);
check(
  'a custom pattern is honoured',
  JSON.stringify(byGroup(demoShelf(FIXTURE, { limit: 6, sizes: [1, 5] }))) === JSON.stringify([1, 5]),
  JSON.stringify(byGroup(demoShelf(FIXTURE, { limit: 6, sizes: [1, 5] }))),
);
// Newest year first, then conference A→Z — the order the renderer paints in.
check(
  'groups are taken newest year first, then conference A→Z',
  demo[0].conference === 'aaa' && demo[0].year === 2030,
  `${demo[0].conference} ${demo[0].year}`,
);

// A conference-year too thin to fill its share must not leave the shelf short —
// the loop walks on into older groups. Newest year first, so `thin` is taken up
// first and gives 1 of its 4; the rest has to come from the group behind it.
{
  const thin = [{ slug: 't1', conference: 'aaa', year: 2031, status: 'past', deadline_utc: '2031-01-01T00:00:00.000Z' }];
  const got = demoShelf([...thin, ...FIXTURE], { limit: 6, sizes: [4, 5] });
  check('a thin newest group is made up for by the next one', got.length === 6, `${got.length}`);
  check('the thin group still contributes what it has', got[0].slug === 't1');
}

check('an empty corpus yields an empty demo', demoShelf([]).length === 0);
check('a corpus with nothing archived yields an empty demo', demoShelf([{ status: 'upcoming', conference: 'icml', year: 2026 }]).length === 0);

// And one pass over whatever the real corpus is, when a build has produced it:
// the fixture proves the shaping, this proves the shaping still finds a full
// shelf in the data the page will actually hand it.
if (fs.existsSync(API)) {
  const live = demoShelf(corpus);
  check('the live corpus fills a demo shelf', live.length === 16, `${live.length}`);
  check('every live demo volume is archived', live.every(isArchived));
  check('the live demo spans several conference-years', byGroup(live).length > 1, `${byGroup(live).length}`);
} else {
  console.log('· live-corpus checks skipped (no site/dist; run after a build)');
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
