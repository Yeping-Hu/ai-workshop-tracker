#!/usr/bin/env node
/**
 * How the official-list check TALKS TO the two announcement blogs — the caching
 * and the retry budget, not the extraction (official_list_test.mjs covers that).
 *
 * Why this exists. Both blogs sit on one shared host, and it has twice answered
 * a GitHub runner with a short 200 carrying no list while serving the real page
 * to everyone else — once recovering on its own two and a half minutes later.
 * The check read that as "the URL is probably wrong" and filed a data-health
 * issue against two URLs that were correct, where it stood until the next
 * weekly run. Two things caused that and both are pinned here:
 *
 *   - it re-walked each conference's feed once per unconfigured edition-year,
 *     spending 22 requests on one host in nine seconds, nine of them exact
 *     repeats — the burst that a rationing host answers by rationing;
 *   - it gave an empty parse a single retry five seconds later, which cannot
 *     outlast a refusal measured in minutes.
 *
 * `fetch` is stubbed, so this asserts the request PATTERN — how many, to what,
 * how patiently — which is the thing that was wrong. Nothing here touches the
 * network.
 *
 * Run: node scripts/official_list_fetch_test.mjs
 */
import { readList, get, resetPageCache, EMPTY_RETRY_BACKOFF_MS } from './official_list_check.mjs';
import { MIN_LISTED } from '../lib/official_list.mjs';

let failed = 0;
function check(label, got, expect) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(expect)})`}`);
}

/* ---- stub host ---------------------------------------------------------- */
const LIST_URL = 'https://blog.example.cc/2026/01/01/workshops/';
// Ten single-anchor <li> in an <article>: comfortably above MIN_LISTED, and the
// same shape the NeurIPS fixture has.
const LIST_PAGE =
  '<html><head><title>Workshops at EXAMPLE 2026</title></head><body><article><ul>' +
  Array.from({ length: 10 }, (_, i) => `<li><a href="https://w${i}.example/">Workshop ${i}</a></li>`).join('') +
  '</ul></article></body></html>';
// What the real host actually sent: 200, no list, and short.
const REFUSAL_PAGE = '<html><head><title>Just a moment...</title></head><body>Checking your browser.</body></html>';

/** Serve `bodies` in order; the last one repeats once exhausted. */
function stubHost(bodies) {
  const log = [];
  globalThis.fetch = async (url) => {
    log.push(String(url));
    const body = bodies[Math.min(log.length - 1, bodies.length - 1)];
    return { ok: true, status: 200, text: async () => body };
  };
  resetPageCache();
  return log;
}
const NO_WAIT = [0, 0, 0];

/* ---- the cache: a page is fetched once per run --------------------------- */
// findCandidate walks the same five feed pages for every unconfigured
// edition-year. Nothing changes underneath a run, so the repeats bought nothing
// and spent the budget of a host that visibly rations requests.
{
  const log = stubHost([LIST_PAGE]);
  await get(LIST_URL);
  await get(LIST_URL);
  await get(LIST_URL);
  check('three reads of one url cost one request', log.length, 1);

  await get(LIST_URL, { fresh: true });
  check('...and `fresh` is the one way past it', log.length, 2);

  await get(LIST_URL);
  check('...which also refreshes what the cache holds', log.length, 2);

  await get('https://blog.example.cc/feed/');
  check('a different url is still fetched', log.length, 3);
}

/* ---- the cache holds failures too --------------------------------------- */
// Re-asking a host that just refused us is the behaviour being removed, not a
// fallback to keep.
{
  const log = [];
  globalThis.fetch = async (url) => {
    log.push(String(url));
    return { ok: false, status: 403, text: async () => '' };
  };
  resetPageCache();
  check('a refusal is returned, not thrown', (await get(LIST_URL)).ok, false);
  await get(LIST_URL);
  check('...and is not re-asked', log.length, 1);
}

/* ---- the retry budget: minutes, not seconds ----------------------------- */
{
  check('a configured list gets more than one re-read', EMPTY_RETRY_BACKOFF_MS.length > 1, true);
  // The one observed self-healing refusal cleared after ~2.5 minutes. A budget
  // that expires before then is a budget that files the false alarm anyway.
  const spanS = EMPTY_RETRY_BACKOFF_MS.reduce((a, b) => a + b, 0) / 1000;
  check('...spanning longer than the 150s refusal actually seen', spanS > 150, true);
  check('...and the gaps grow rather than repeat', EMPTY_RETRY_BACKOFF_MS.every((ms, i, a) => i === 0 || ms > a[i - 1]), true);
}

/* ---- an empty read is re-read, and a recovery is believed --------------- */
// The 2026-08-29 shape exactly: refused, refused, then the real page. The old
// single retry stopped one attempt short of this and filed the issue.
{
  const log = stubHost([REFUSAL_PAGE, REFUSAL_PAGE, LIST_PAGE]);
  const r = await readList(LIST_URL, [], { backoff: NO_WAIT });
  check('a host that recovers on the third read is believed', r.ok, true);
  check('...having actually re-fetched, not re-read the cache', log.length, 3);
  check('...and the list is the recovered one', r.items.length, 10);
}

/* ---- a genuine failure still reports, and says what arrived ------------- */
{
  const log = stubHost([REFUSAL_PAGE]);
  const r = await readList(LIST_URL, [], { backoff: NO_WAIT });
  check('a host that never recovers is reported', r.ok, false);
  check('...after the whole budget', log.length, NO_WAIT.length + 1);
  check('...saying how many attempts it took', /after 4 attempts/.test(r.reason), true);
  check('...and that nothing was extracted', new RegExp(`0 items found, expected at least ${MIN_LISTED}`).test(r.reason), true);

  // The detail lines are the entire point: whoever reads the issue must be able
  // to tell a wall from a wrong URL without re-running the fetch by hand.
  const detail = (r.detail ?? []).join('\n');
  check('...names what came back as a refusal', /challenge or refusal page/.test(detail), true);
  check('...quotes the page title it got', /Just a moment/.test(detail), true);
  check('...and says to re-run before editing config', /Re-run \*Official workshop list check\*/.test(detail), true);
}

/* ---- a real page we failed to parse is the OPPOSITE diagnosis ----------- */
// Same symptom, zero items, but here the fix is the extractor and telling the
// reader to wait would waste a week.
{
  stubHost(['<html><head><title>Workshops at EXAMPLE 2026</title></head><body><article><p>' + 'The workshops are listed below. '.repeat(40) + '</p></article></body></html>']);
  const r = await readList(LIST_URL, [], { backoff: [] });
  const detail = (r.detail ?? []).join('\n');
  check('a real page reads as an extractor problem', /the extractor, not the URL/.test(detail), true);
  check('...and is NOT told to just wait', /Re-run \*Official/.test(detail), false);
}

/* ---- a candidate probe buys one attempt -------------------------------- */
// Most posts in a feed are not the list. A probe that reads empty proposes
// nothing, so patience there buys only a slower job and a bigger burst against
// the host that is already rationing.
{
  const log = stubHost([REFUSAL_PAGE]);
  const r = await readList(LIST_URL, [], { backoff: [] });
  check('an empty budget means exactly one request', log.length, 1);
  check('...and it still reports rather than throwing', r.ok, false);
  check('...saying it was a single attempt', /after 1 attempt\b/.test(r.reason), true);
}

/* ---- the corpus guard is untouched ------------------------------------- */
// A page that parses fine but matches nothing we track must still be refused —
// this is the guard that stops a reformat being read as "all rejected".
{
  stubHost([LIST_PAGE]);
  const entries = Array.from({ length: 10 }, (_, i) => ({
    slug: `s${i}`, name: `Something Else ${i}`, conference: 'example', year: 2026,
    website: `https://unrelated${i}.example/`, status: 'active',
  }));
  const r = await readList(LIST_URL, entries, { backoff: [] });
  check('a list matching nothing we track is refused', r.ok, false);
  check('...for that reason, not as unreadable', /does not look like/.test(r.reason), true);
}

console.log(failed === 0 ? '\nOfficial-list fetch behaviour OK.' : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
