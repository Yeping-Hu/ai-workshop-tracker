#!/usr/bin/env node
/**
 * Repairing a saved list against the corpus it points at
 * (site/src/scripts/saved-repair.js). Run: node scripts/saved_repair_test.mjs
 *
 * The bug this pins: /saved/ stores slugs, so a workshop whose entry later left
 * the dataset stayed in the list as a slug that could never render. The heading
 * counted it, the nav badge counted it, no row existed to un-star it, and the
 * account synced the same ghost to every other device — a permanent 27 over a
 * list of 26, with a footnote instead of a fix.
 *
 * Three rules, all of them corpus-wide rather than per-workshop:
 *   1. a merged-away slug FOLLOWS the merge, the way its URL already does;
 *   2. a slug with nothing to point at LEAVES the list;
 *   3. neither happens against a corpus that looks truncated — a broken deploy
 *      must not be able to delete anyone's saved list.
 *
 * The last section runs rule 1 against the real data: every slug the site
 * publishes a redirect for has to be repairable, or the two mechanisms have
 * drifted and a reader's star goes somewhere the browser will not.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repairSavedWorkshops, MIN_CORPUS } from '../site/src/scripts/saved-repair.js';
import { loadWorkshops, mergedSlugRedirects } from '../lib/workshops.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed++;
};

/** A corpus big enough to be trusted, holding the given slugs. */
const corpus = (...slugs) => [...slugs, ...Array.from({ length: MIN_CORPUS }, (_, i) => `filler-${i}`)];

console.log('— the three rules —');
{
  const r = repairSavedWorkshops({
    saved: ['icml-2026-a', 'gone-2025-x', 'neurips-2026-b'],
    live: corpus('icml-2026-a', 'neurips-2026-b'),
  });
  check('a slug with nothing to point at leaves the list', r.ws.join() === 'icml-2026-a,neurips-2026-b', r.ws.join());
  check('and is reported, so the reader can be told', r.dropped.join() === 'gone-2025-x', r.dropped.join());
  check('the repaired list is exactly as long as the rows it renders', r.ws.length === 2);
}
{
  const r = repairSavedWorkshops({
    saved: ['iros-2026-sim2real-and-control', 'icml-2026-a'],
    live: corpus('iros-2026-s2rcc', 'icml-2026-a'),
    moved: { 'iros-2026-sim2real-and-control': 'iros-2026-s2rcc' },
  });
  check('a merged-away slug follows the merge', r.ws.includes('iros-2026-s2rcc'), r.ws.join());
  check('the save is kept, not dropped', r.dropped.length === 0 && r.renamed.length === 1);
  check('a rename holds its place in the list', r.ws.join() === 'iros-2026-s2rcc,icml-2026-a', r.ws.join());
}
{
  // The reason renames cannot simply be rewritten in place: someone who starred
  // both OpenReview groups before they were merged has two slugs for one
  // workshop, and two identical rows is a worse bug than the one being fixed.
  const r = repairSavedWorkshops({
    saved: ['old-slug', 'new-slug'],
    live: corpus('new-slug'),
    moved: { 'old-slug': 'new-slug' },
  });
  check('a rename onto an already-saved workshop collapses to one entry', r.ws.join() === 'new-slug', r.ws.join());
}

console.log('\n— a broken build must not delete a saved list —');
{
  const saved = ['icml-2026-a', 'neurips-2026-b', 'colm-2025-c'];
  const r = repairSavedWorkshops({ saved, live: ['icml-2026-a'] });
  check('a truncated corpus is refused outright', r.ran === false);
  check('and the list comes back untouched', r.ws.join() === saved.join(), r.ws.join());
  check('nothing is reported as dropped', r.dropped.length === 0 && r.changed === false);

  const empty = repairSavedWorkshops({ saved, live: [] });
  check('an empty dump is the same refusal', empty.ran === false && empty.ws.length === 3);
  const missing = repairSavedWorkshops({ saved });
  check('so is no dump at all', missing.ran === false && missing.ws.length === 3);
}

console.log('\n— it has to be safe to run on every render —');
{
  const live = corpus('a-1', 'b-2');
  const first = repairSavedWorkshops({ saved: ['a-1', 'b-2'], live });
  check('a list that is already correct reports no change', first.changed === false && first.ws.length === 2);

  const fixed = repairSavedWorkshops({ saved: ['a-1', 'gone', 'b-2'], live });
  const again = repairSavedWorkshops({ saved: fixed.ws, live });
  check('repairing a repaired list does nothing', again.changed === false && again.ws.join() === fixed.ws.join());
}

console.log('\n— junk in storage —');
{
  // localStorage is not a schema: another tab, an old build or a hand-edit can
  // leave anything in there. These entries never rendered, and they were being
  // counted, which is the same mismatch by another route.
  const r = repairSavedWorkshops({ saved: ['a-1', null, '', 42, { slug: 'b-2' }], live: corpus('a-1', 'b-2') });
  check('non-slug entries are removed', r.ws.join() === 'a-1' && r.changed === true, JSON.stringify(r.ws));
  check('but are not reported as workshops the reader lost', r.dropped.length === 0, r.dropped.join());
  check('a corrupt list is not a crash', repairSavedWorkshops({ saved: 'nonsense', live: corpus() }).ws.length === 0);
}

console.log('\n— chains and cycles —');
{
  const twice = repairSavedWorkshops({
    saved: ['one'],
    live: corpus('three'),
    moved: { one: 'two', two: 'three' },
  });
  check('a slug that moved twice still lands', twice.ws.join() === 'three', twice.ws.join());

  const dead = repairSavedWorkshops({ saved: ['one'], live: corpus('other'), moved: { one: 'two' } });
  check('a move to a slug that is also gone drops', dead.ws.length === 0 && dead.dropped.join() === 'one');

  const loop = repairSavedWorkshops({ saved: ['a'], live: corpus('c'), moved: { a: 'b', b: 'a' } });
  check('a cycle terminates and drops', loop.ws.length === 0 && loop.dropped.join() === 'a');
}

console.log('\n— against the real corpus —');
{
  const live = loadWorkshops().map((w) => w.slug);
  const moved = Object.fromEntries(mergedSlugRedirects());
  const movedSlugs = Object.keys(moved);

  check(
    `the guard is far below the real corpus (${live.length} workshops, floor ${MIN_CORPUS})`,
    live.length > MIN_CORPUS * 2,
    'MIN_CORPUS would refuse to repair real lists',
  );

  // Every slug the site redirects a URL for is a slug a reader may have saved.
  // Without `moved_slugs` in the payload this section is what goes red.
  const r = repairSavedWorkshops({ saved: [...movedSlugs, live[0]], live, moved });
  check(
    `every merged-away slug repairs instead of dropping (${movedSlugs.length} of them)`,
    r.dropped.length === 0 && r.renamed.length === movedSlugs.length,
    `dropped: ${r.dropped.join(', ')}`,
  );
  check(
    'and every repaired slug is a workshop that exists',
    r.ws.every((s) => live.includes(s)),
    r.ws.filter((s) => !live.includes(s)).join(', '),
  );
  check(
    'a saved list of live slugs is left alone',
    repairSavedWorkshops({ saved: live.slice(0, 30), live, moved }).changed === false,
  );
}

console.log('\n— the map reaches the browser —');
{
  // The page can only follow a merge if the payload carries the map, so the key
  // is a contract between the endpoint and /saved/. Checked on the built dump
  // when there is one, and on the sources otherwise, so this suite still runs
  // before `npm run build` (validate.yml has no site build).
  const dist = path.join(ROOT, 'site/dist/api/workshops.json');
  if (fs.existsSync(dist)) {
    const payload = JSON.parse(fs.readFileSync(dist, 'utf8'));
    const derived = Object.fromEntries(mergedSlugRedirects());
    check('the built dump publishes moved_slugs', !!payload.moved_slugs, JSON.stringify(payload.moved_slugs));
    check(
      'and it matches the redirects the site serves',
      JSON.stringify(payload.moved_slugs) === JSON.stringify(derived),
      `${JSON.stringify(payload.moved_slugs)} vs ${JSON.stringify(derived)}`,
    );
    check(
      'every moved slug is absent from the dump itself',
      Object.keys(payload.moved_slugs || {}).every((s) => !payload.workshops.some((w) => w.slug === s)),
    );
  } else {
    check('the endpoint publishes moved_slugs', read('site/src/pages/api/workshops.json.ts').includes('moved_slugs:'));
    check('and /saved/ reads it', read('site/src/pages/saved.astro').includes('payload.moved_slugs'));
    console.log('  (no site/dist — source check only; pr-build-check.yml runs this against the build)');
  }
}

console.log(failed === 0 ? '\nSaved-list repair OK.' : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
