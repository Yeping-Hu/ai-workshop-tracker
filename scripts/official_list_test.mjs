#!/usr/bin/env node
/**
 * The official-list EXTRACTOR (lib/official_list.mjs), against committed
 * fixtures of real announcement pages.
 *
 * Why fixtures and not the live web: the failure this guards is a page reformat
 * silently yielding zero items, which the caller would otherwise be free to read
 * as "every workshop in the corpus was rejected". That must surface as a red
 * test, not as one bad Sunday.
 *
 * Capturing a new fixture:
 *   curl -sL <url> > scripts/fixtures/<conf>-<year>-workshops.html
 * Trim by hand if it is large, but KEEP THE CHROME — the nav and footer are
 * precisely what the content-narrowing has to survive.
 *
 * Run: node scripts/official_list_test.mjs
 */
import fs from 'node:fs';
import {
  extractListedWorkshops,
  statedWorkshopCount,
  selectAnnouncementCandidates,
  MIN_LISTED,
} from '../lib/official_list.mjs';

let failed = 0;
function check(label, got, expect) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(expect)})`}`);
}
const fixture = (f) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');

/* ---- NeurIPS 2026: a <ul> of 102 <li>, one <a> each ---------------------- */
{
  const url = 'https://blog.neurips.cc/2026/08/10/announcing-the-neurips-2026-workshops/';
  const html = fixture('neurips-2026-workshops.html');
  const { items, warnings } = extractListedWorkshops(html, { baseUrl: url });

  check('neurips 2026: 102 workshops extracted', items.length, 102);
  check('...with no warnings (the <li> tier is the first one tried)', warnings, []);
  check('...and the page agrees with itself', statedWorkshopCount(html), 102);
  check('first item title', items[0].title, 'Workshop on the Linguistic Principles for Foundation Models');
  check('first item url', items[0].url, 'https://lp4fm.github.io/');

  // Sections come from the nearest preceding heading and are for the report
  // only — never for matching, since a location mismatch is a different bug.
  const cities = [...new Set(items.map((i) => (i.section ?? '').split(' ')[0]))];
  check('grouped by host city, in document order', cities, ['Sydney', 'Paris', 'Atlanta']);
  check('city split matches the announcement', cities.map((c) => items.filter((i) => i.section?.startsWith(c)).length), [48, 28, 26]);

  // Chrome leaks are the failure mode that would look like data.
  const hosts = new Set(items.map((i) => new URL(i.url).host));
  check('no link to the blog itself leaked in', hosts.has('blog.neurips.cc'), false);
  check('no nav/footer neurips.cc links leaked in', hosts.has('neurips.cc'), false);
  check('every url is absolute http(s)', items.every((i) => /^https?:\/\//.test(i.url)), true);
  check('every item has a non-empty title', items.every((i) => i.title.length > 3), true);
  check('urls are unique', new Set(items.map((i) => i.url)).size, 102);

  // Entities: the list carries "I Can’t Believe It’s Not Better" and "AI & Science".
  check('html entities decoded', items.some((i) => i.title.includes("Can’t Believe")), true);
  check('&amp; decoded', items.some((i) => i.title.includes('AI & Science')), true);
  check('no tags survive in a title', items.every((i) => !/[<>]/.test(i.title)), true);
}

/* ---- ICLR 2026: a 40-row <table>, one <a> per <tr> ---------------------- */
// A different shape entirely, and neither is "the" convention. This fixture is
// what stops the extractor being quietly fitted to one blog theme.
{
  const html = fixture('iclr-2026-workshops.html');
  const { items, warnings } = extractListedWorkshops(html, {
    baseUrl: 'https://blog.iclr.cc/2026/01/13/iclr2026-workshops/',
  });
  check('iclr 2026: 40 workshops extracted from <tr> rows', items.length, 40);
  check('...and the page agrees with itself', statedWorkshopCount(html), 40);
  check('a non-first tier raises a warning', warnings.length, 1);
  check('...naming the tag it fell back to', /<tr>/.test(warnings[0]), true);
  check('titles came from the row, not the cell markup', items[0].title, 'ICLR 2026 Workshop on AI with Recursive Self-Improvement');
  // AI for Peace runs at BOTH ICLR 2026 and NeurIPS 2026 under one URL — a
  // useful reminder that a listed workshop is not owned by one conference.
  check('AI for Peace is on this list too', items.some((i) => i.url.startsWith('https://aiforpeaceworkshop.github.io')), true);
}

/* ---- A JS-rendered schedule page: must yield NOTHING -------------------- */
// This is the fixture that justifies refusing to template a list URL from
// data/conferences.yml's `workshop_list_url_pattern`-style pattern. The page
// exists, returns 200, and contains no server-rendered list at all. Yielding a
// handful of nav links here would mean reporting the whole corpus as rejected.
{
  const { items, warnings } = extractListedWorkshops(fixture('js-shell-schedule.html'), {
    baseUrl: 'https://neurips.cc/Conferences/2026/Schedule?type=Workshop',
  });
  check('a JS shell yields no workshops at all', items.length, 0);
  check('...below MIN_LISTED, so the caller must refuse it', items.length < MIN_LISTED, true);
  check('...and says why', /no workshop list found/.test(warnings[0]), true);
}

/* ---- degenerate input --------------------------------------------------- */
{
  check('empty string', extractListedWorkshops('').items, []);
  check('null', extractListedWorkshops(null).items, []);
  check('a block with TWO anchors is prose, not a list entry',
    extractListedWorkshops('<main><ul>' + '<li><a href="https://a.example">A</a> and <a href="https://b.example">B</a></li>'.repeat(9) + '</ul></main>').items,
    []);
  // The stated count is a cross-check, so a wrong number is worse than none.
  // Every phrasing below appears verbatim on a real announcement page.
  check('a year is never read as a stated count', statedWorkshopCount('the NeurIPS 2026 accepted workshops'), null);
  check('"we have accepted 102 workshops" (NeurIPS word order)',
    statedWorkshopCount('After reviewing, we have accepted 102 workshops: 48, 28, and 26.'), 102);
  check('"40: accepted workshops" (ICLR word order)',
    statedWorkshopCount('ICLR 2025 Workshops in Numbers 122: workshop proposal submissions 40: accepted workshops'), 40);
  check('a PROPOSAL count is never mistaken for an accepted count',
    statedWorkshopCount('TL;DR 151 (135 valid) workshop proposal submissions'), null);
  check('a per-city subtotal is not a stated total',
    statedWorkshopCount('ordered by location. Sydney (48 workshops) Paris (28 workshops)'), null);
}

/* ---- finding the list in a conference's announcement feed --------------- */
// This is what makes the reconciliation self-starting: a conference that
// publishes a feed does not need its list URL pasted in by hand. The rule stays
// deliberately general — a post about workshops, for this year — because it has
// to work for a conference nobody has looked at yet.
{
  const feed = fixture('neurips-blog-feed.xml');
  const found = selectAnnouncementCandidates(feed, 2026);
  check('exactly one candidate out of ten posts', found.length, 1);
  check('...and it is the announcement', found[0].title, 'Announcing the NeurIPS 2026 Workshops');
  check('...with its url', found[0].url, 'https://blog.neurips.cc/2026/08/10/announcing-the-neurips-2026-workshops/');

  // The same feed carries the posts that must NOT be picked up.
  const titles = [...feed.matchAll(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/g)].map((m) => m[1]);
  check('the competitions post is in this feed', titles.some((t) => /Competitions Announced/.test(t)), true);
  check('...and is not proposed', found.some((f) => /Competition/i.test(f.title)), false);
  check('a newsletter is not proposed', found.some((f) => /Newsletter/i.test(f.title)), false);

  check('a different year finds nothing', selectAnnouncementCandidates(feed, 2025).length, 0);
  check('an empty feed finds nothing', selectAnnouncementCandidates('', 2026).length, 0);

  // Explicit rejections, so the exclusions are pinned rather than incidental.
  const synth = (t) => `<rss><channel><item><title>${t}</title><link>https://x.example/p/</link></item></channel></rss>`;
  check('"Call for Workshop Proposals 2026" is not the accepted list',
    selectAnnouncementCandidates(synth('Call for Workshop Proposals 2026'), 2026).length, 0);
  check('"Workshops at ICLR 2026" is', selectAnnouncementCandidates(synth('Workshops at ICLR 2026'), 2026).length, 1);
  check('a workshops post for the WRONG year is not', selectAnnouncementCandidates(synth('Workshops at ICLR 2025'), 2026).length, 0);
}

console.log(failed === 0 ? '\nOfficial-list extraction OK.' : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
