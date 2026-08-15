#!/usr/bin/env node
/**
 * Tests for alerts/match.mjs — which workshops land in which subscriber's
 * digest.
 *
 * Three rules carry all the weight, and each has an obvious wrong reading:
 *
 *   - **Empty filters mean "everything", not "nothing".** A subscriber who
 *     picks no conference and no topic wants the whole board; reading `[]` as
 *     an empty allowlist would silently send them nothing forever, and an
 *     empty digest is skipped, so the bug would be invisible.
 *   - **Topics are an intersection, conferences a membership test**, and the
 *     two are ANDed.
 *   - **Starring bypasses the filter entirely.** If you starred it, you hear
 *     about it, whatever your facets say.
 *
 * Pure logic — no network. Run: node scripts/alerts_match_test.mjs
 */
import {
  matchesSubscriber,
  wantsStarredChanges,
  wantsWeekly,
  matchingWorkshops,
  matchingEvents,
  normalizeSubscriber,
  isMailable,
  wantsUrgent,
} from '../alerts/match.mjs';

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}
const eq = (label, got, want) =>
  check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);

// Keyed by slug, exactly like the live projection the pipeline passes in.
const NLP = { slug: 'neurips-2026-nlp', conference: 'neurips', topics: ['nlp', 'llms'] };
const VISION = { slug: 'cvpr-2026-vision', conference: 'cvpr', topics: ['vision'] };
const ROBOTS = { slug: 'icra-2026-robots', conference: 'icra', topics: ['robotics', 'vision'] };
const UNTAGGED = { slug: 'iclr-2026-misc', conference: 'iclr', topics: [] };
const W = Object.fromEntries([NLP, VISION, ROBOTS, UNTAGGED].map((w) => [w.slug, w]));

const sub = (over = {}) =>
  normalizeSubscriber({
    email: 'A@Example.com',
    nonce: 'n',
    conferences: '[]',
    topics: '[]',
    starred_ws: '[]',
    starred_papers: '[]',
    cadence: 'weekly',
    confirmed_at: '2026-08-01T00:00:00Z',
    ...over,
  });

/* ------------------------------------------------------- normalizeSubscriber */
{
  const s = sub({ conferences: '["neurips"]', topics: '["llms","nlp"]', starred_ws: '["a"]' });
  check('email is normalized to lowercase', s.email === 'a@example.com', s.email);
  eq('JSON columns are parsed to arrays', s.topics, ['llms', 'nlp']);
  eq('already-parsed arrays pass through', normalizeSubscriber({ conferences: ['x'] }).conferences, ['x']);
  eq('corrupt JSON degrades to an empty array', normalizeSubscriber({ topics: '{not json' }).topics, []);
  eq('a JSON non-array degrades to an empty array', normalizeSubscriber({ topics: '"llms"' }).topics, []);
  check('cadence defaults to weekly', normalizeSubscriber({}).cadence === 'weekly');
}

/* --------------------------------------------------- empty filters mean "all" */
{
  const all = sub();
  check('no conferences + no topics matches anything', matchesSubscriber(NLP, all));
  check('...including an untagged workshop', matchesSubscriber(UNTAGGED, all));
  eq('matchingWorkshops returns everything for an empty filter',
    matchingWorkshops(W, all).map((w) => w.slug).sort(),
    Object.values(W).map((w) => w.slug).sort());
}

/* -------------------------------------------------------------- conferences */
{
  const s = sub({ conferences: '["neurips","cvpr"]' });
  check('a listed conference matches', matchesSubscriber(NLP, s));
  check('a second listed conference matches', matchesSubscriber(VISION, s));
  check('an unlisted conference does not', !matchesSubscriber(ROBOTS, s));
}

/* ------------------------------------------------------------------- topics */
{
  const s = sub({ topics: '["vision"]' });
  check('a workshop sharing the topic matches', matchesSubscriber(VISION, s));
  check('a workshop sharing one of several topics matches', matchesSubscriber(ROBOTS, s));
  check('a workshop with no shared topic does not', !matchesSubscriber(NLP, s));
  check('a workshop with no topics at all does not match a topic filter',
    !matchesSubscriber(UNTAGGED, s));
}

/* ------------------------------------------------------- conference AND topic */
{
  const s = sub({ conferences: '["icra"]', topics: '["vision"]' });
  check('both facets satisfied -> match', matchesSubscriber(ROBOTS, s));
  check('right topic, wrong conference -> no match', !matchesSubscriber(VISION, s));
  const s2 = sub({ conferences: '["icra"]', topics: '["nlp"]' });
  check('right conference, wrong topic -> no match', !matchesSubscriber(ROBOTS, s2));
}

/* -------------------------------------------------------- starred bypasses all */
{
  const s = sub({ conferences: '["neurips"]', topics: '["nlp"]', starred_ws: '["icra-2026-robots"]' });
  check('a starred workshop matches despite both filters excluding it',
    matchesSubscriber(ROBOTS, s));
  check('an unstarred, unmatched workshop still does not', !matchesSubscriber(VISION, s));

  // The narrowest possible filter still cannot hide a starred entry.
  const s2 = sub({ conferences: '["nonexistent"]', topics: '["nonexistent"]', starred_ws: '["cvpr-2026-vision"]' });
  check('starring wins even when no facet can ever match', matchesSubscriber(VISION, s2));
}

/* ------------------------------------------------------------ matchingEvents */
{
  const events = [
    { slug: 'neurips-2026-nlp', kind: 'extended', days: 3 },
    { slug: 'cvpr-2026-vision', kind: 'announced' },
    { slug: 'deleted-workshop', kind: 'extended', days: 1 },
  ];
  const s = sub({ conferences: '["neurips"]' });
  eq('events are filtered through their workshop',
    matchingEvents(events, W, s).map((e) => e.slug), ['neurips-2026-nlp']);
  // An event whose workshop has since vanished can't be rendered (no name, no
  // link), so it is dropped rather than emitted half-blank.
  eq('an event for a workshop no longer in the dataset is dropped',
    matchingEvents(events, W, sub()).map((e) => e.slug),
    ['neurips-2026-nlp', 'cvpr-2026-vision']);
}

/* ------------------------------------------------------ mailability + cadence */
{
  check('confirmed weekly subscriber is mailable', isMailable(sub()));
  check('unconfirmed subscriber is not mailable', !isMailable(sub({ confirmed_at: null })));
  check('suppressed subscriber is not mailable',
    !isMailable(sub({ suppressed_at: '2026-08-02T00:00:00Z' })));
  check('paused (cadence off) subscriber is not mailable', !isMailable(sub({ cadence: 'off' })));

  check('weekly_urgent opts into urgent alerts', wantsUrgent(sub({ cadence: 'weekly_urgent' })));
  check('plain weekly does not', !wantsUrgent(sub()));
  check('an unconfirmed weekly_urgent subscriber gets nothing',
    !wantsUrgent(sub({ cadence: 'weekly_urgent', confirmed_at: null })));
  check('a suppressed weekly_urgent subscriber gets nothing',
    !wantsUrgent(sub({ cadence: 'weekly_urgent', suppressed_at: '2026-08-02T00:00:00Z' })));
}

/* -------------------------------------------------- scope: saved-only ------
 * Empty facets mean "everything", so there was previously no way to ask for
 * nothing-but-my-saved-list. `scope: 'starred'` is that request.
 */
{
  const s = sub({ scope: 'starred', starred_ws: '["neurips-2026-nlp"]' });
  check('saved-only matches a starred workshop', matchesSubscriber(NLP, s));
  check('saved-only ignores everything else', !matchesSubscriber(VISION, s));

  // Facets are irrelevant in this mode — they must not widen it back out.
  const withFacets = sub({
    scope: 'starred',
    starred_ws: '["neurips-2026-nlp"]',
    conferences: '["cvpr","icra"]',
    topics: '["vision","robotics"]',
  });
  check('saved-only ignores conference facets', !matchesSubscriber(VISION, withFacets));
  check('saved-only ignores topic facets', !matchesSubscriber(ROBOTS, withFacets));
  check('...while still matching the saved one', matchesSubscriber(NLP, withFacets));

  // Empty facets under saved-only must mean "nothing", not "everything".
  const bare = sub({ scope: 'starred' });
  check('saved-only with nothing saved matches nothing', !matchesSubscriber(NLP, bare));
}

/* ------------------------------------- scope defaults protect existing rows */
{
  // Rows created before the column existed have no value at all.
  check('a missing scope behaves as "all"', matchesSubscriber(VISION, sub()));
  check('an unknown scope value falls back to "all"',
    matchesSubscriber(VISION, normalizeSubscriber({ scope: 'nonsense' })));
  check('scope "all" keeps the starred bypass (guards the pre-existing promise)',
    matchesSubscriber(ROBOTS, sub({ conferences: '["neurips"]', starred_ws: '["icra-2026-robots"]' })));
}

/* ---------------------------------------------------- the new cadence -------- */
{
  const changes = sub({ cadence: 'starred_changes' });
  check('starred_changes opts into same-day change mail', wantsStarredChanges(changes));
  check('starred_changes also gets the 72h imminent alert', wantsUrgent(changes));
  check('starred_changes gets NO weekly digest', !wantsWeekly(changes));

  check('weekly still gets the digest', wantsWeekly(sub()));
  check('weekly does not get same-day change mail', !wantsStarredChanges(sub()));
  check('weekly_urgent still gets the digest', wantsWeekly(sub({ cadence: 'weekly_urgent' })));
  check('paused gets nothing at all',
    !wantsWeekly(sub({ cadence: 'off' })) && !wantsStarredChanges(sub({ cadence: 'off' })) && !wantsUrgent(sub({ cadence: 'off' })));
  check('an unconfirmed starred_changes subscriber gets nothing',
    !wantsStarredChanges(sub({ cadence: 'starred_changes', confirmed_at: null })));
}

console.log(failed === 0 ? '\nMatching logic OK.' : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
