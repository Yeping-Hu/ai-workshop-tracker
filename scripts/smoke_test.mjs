/**
 * Post-deploy smoke test against the *live* site.
 *
 *   node scripts/smoke_test.mjs [https://aiworkshoptracker.com]
 *
 * Distinct from the CI suites in what it can see. Those drive an artefact built
 * inside the job, so they cannot catch anything that goes wrong between `npm run
 * build` and a reader's browser: a half-published Pages deploy, a stale or
 * mis-scoped Pagefind index, a data commit that emptied the board, a redirect
 * rule, an expired certificate. This drives what is actually served.
 *
 * It is deliberately small and phrased as user-visible outcomes rather than
 * implementation detail, because it runs on a schedule against a moving corpus:
 * a check that is specific enough to fail on an ordinary Tuesday's data is worse
 * than no check, since a suite people learn to ignore protects nothing. So it
 * asserts the handful of things that must be true of every edition of the site,
 * and says plainly what it saw when one is not.
 */
import { chromium } from 'playwright';

const BASE = (process.argv[2] || 'https://aiworkshoptracker.com').replace(/\/$/, '');
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${extra ? ` — ${extra}` : ''}`); console.log(`  ✗ ${name} ${extra}`); }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

// Diagnostics. The paper-search check has failed three times against a site that
// was demonstrably serving results minutes earlier, and each report said only
// "no .pf-paper appeared" — which is what sent the last investigation after the
// wrong cause. Search pulls ~520 index chunks, so a single dropped or refused one
// leaves the engine silently short. Record enough to tell those apart.
const consoleErrors = [];
const netProblems = [];
const pagefind = { requests: 0, byStatus: {} };
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });
page.on('response', (r) => {
  const isPf = r.url().includes('pagefind');
  if (isPf) { pagefind.requests += 1; pagefind.byStatus[r.status()] = (pagefind.byStatus[r.status()] || 0) + 1; }
  if (r.status() >= 400) netProblems.push(`${r.status()} ${r.url().slice(0, 120)}`);
});
page.on('requestfailed', (r) => netProblems.push(`FAILED ${r.failure()?.errorText ?? '?'} ${r.url().slice(0, 120)}`));

/**
 * What the PAGE says went wrong.
 *
 * The site writes its own diagnosis into the DOM and then stops: when the engine
 * fails to load, `ensurePagefind`'s catch fills `#searchStatus` and `runSearch`
 * returns without rendering, because `healAttempted` is still false; when a
 * search throws twice, `handleSearchFailure` fills `#results`. Either way the
 * skeleton stays on screen and no `.pf-paper` ever appears — which is exactly
 * this check's failure signature, results never arriving rather than arriving
 * late. Those two strings are the site's own sentence about why, they are on
 * screen at the moment we give up, and they were being thrown away when the
 * browser closed.
 *
 * The counts matter as much. Workshops and papers come from two Pagefind indexes
 * merged into one engine, so "workshop results but no papers" is a different
 * fault from "nothing at all", and only the counts tell them apart.
 */
async function readSearchUi() {
  return page
    .evaluate(() => {
      const clean = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
      const status = document.querySelector('#searchStatus');
      const results = document.querySelector('#results');
      return {
        status: status && !status.hidden ? clean(status).slice(0, 220) : null,
        skeleton: !!results?.querySelector('.pf-skeleton'),
        resultsText: clean(results).slice(0, 220) || null,
        workshops: document.querySelectorAll('.pf-result').length,
        papers: document.querySelectorAll('.pf-paper').length,
      };
    })
    .catch((e) => ({ unreadable: String(e).slice(0, 120) }));
}

/** What the page looked like when search did not produce results. */
function describeSearchState(ui) {
  const statuses = Object.entries(pagefind.byStatus).map(([k, v]) => `${k}×${v}`).join(' ') || 'none';
  const bits = [`pagefind requests: ${pagefind.requests} (${statuses})`];
  if (ui?.unreadable) {
    bits.push(`could not read the page: ${ui.unreadable}`);
  } else if (ui) {
    bits.push(`rendered: ${ui.workshops} workshop result(s), ${ui.papers} paper row(s)`);
    // Ordered by how much each one settles: the site's own error text names the
    // cause outright, a surviving skeleton says search never rendered at all,
    // and any other #results text is the heal path having given up.
    if (ui.status) bits.push(`the page says: “${ui.status}”`);
    else if (ui.skeleton) bits.push('#results is still the loading skeleton — search never rendered');
    else if (ui.resultsText) bits.push(`#results shows: “${ui.resultsText}”`);
    else bits.push('#results is empty and the page reports no error');
  }
  if (netProblems.length) bits.push(`failed requests: ${netProblems.slice(0, 5).join(' | ')}`);
  if (consoleErrors.length) bits.push(`console errors: ${consoleErrors.slice(0, 3).join(' | ')}`);
  if (!netProblems.length && !consoleErrors.length) bits.push('no failed requests and no console errors');
  return bits.join('; ');
}

/* --------------------------------------------------------- pages answer --- */
console.log(`— every page answers (${BASE}) —`);
for (const path of ['/', '/about/', '/alerts/', '/saved/', '/changes/', '/trends/']) {
  const res = await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  check(`${path} responds 200`, res?.status() === 200, `got ${res?.status()}`);
}

/* ------------------------------------------------------ the board has data - */
console.log('— the board is not empty —');
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
const board = await page.evaluate(() => ({
  rows: document.querySelectorAll('.board-row').length,
  stat: document.querySelector('.statline')?.textContent?.trim() ?? '',
}));
check('the deadline board renders rows', board.rows > 0, `${board.rows} rows`);
check('the statline reports a workshop count', /\d/.test(board.stat), board.stat.slice(0, 60));

const api = await page.evaluate(async (base) => {
  try {
    const r = await fetch(base + '/api/workshops.json');
    if (!r.ok) return { ok: false, status: r.status };
    const j = await r.json();
    return { ok: true, n: (j.workshops || []).length };
  } catch (e) { return { ok: false, err: String(e) }; }
}, BASE);
check('/api/workshops.json is valid and non-empty', api.ok && api.n > 0, JSON.stringify(api));

/* ------------------------------------------------------------ search works - */
console.log('— search returns papers, and they link into the page —');
await page.waitForSelector('#q', { timeout: 20000 });
await page.fill('#q', 'learning');
let searched = true;
// 25s. This was briefly raised to 45s on the theory that the failures were slow
// runners; run #34 then failed at 45s twice, and the failure reproduced locally
// once in three runs. It is not slowness — when it fails, results do not appear
// at all, and more time does not help. Reverted rather than left inflated, since
// a budget chosen for a cause that turned out to be wrong only delays the alert.
await page.waitForSelector('.pf-paper .pf-ptitle', { timeout: 25000 }).catch(() => { searched = false; });
// Read the DOM BEFORE reporting. Whatever the page is saying about itself is on
// screen right now and gone the moment the browser closes.
const searchUi = searched ? null : await readSearchUi();
check(
  'a keyword search returns paper results',
  searched,
  searched ? '' : `no .pf-paper within 25s — ${describeSearchState(searchUi)}`,
);

if (searched) {
  const href = await page.$eval('.pf-paper .pf-ptitle', (a) => a.getAttribute('href'));
  check('a paper result carries a #p- anchor', /\/workshop\/[^/]+\/#p-/.test(href), href);

  // The whole point of the anchor. This is the check that would have caught the
  // twelve-day window where a <head> script stripped every fragment.
  await page.click('.pf-paper .pf-ptitle');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1500);
  const landed = await page.evaluate(() => {
    const id = decodeURIComponent(location.hash.slice(1));
    const el = id && document.getElementById(id);
    return { hash: location.hash, scrolled: scrollY > 50, isTarget: el ? el.matches(':target') : false };
  });
  check('clicking it lands on the paper row', landed.scrolled && landed.isTarget, JSON.stringify(landed));
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  // Picked up by the workflow to title the tracking issue.
  console.log('\nFAILED CHECKS:');
  for (const f of failures) console.log(`- ${f}`);
  console.log('\nWHAT THE BROWSER SAW:');
  console.log(`- pagefind requests: ${pagefind.requests} (${Object.entries(pagefind.byStatus).map(([k, v]) => `${k}×${v}`).join(' ') || 'none'})`);
  console.log(`- failed/4xx/5xx requests: ${netProblems.length ? netProblems.slice(0, 8).join(' | ') : 'none'}`);
  console.log(`- console errors: ${consoleErrors.length ? consoleErrors.slice(0, 5).join(' | ') : 'none'}`);
  if (searchUi) console.log(`- the page at the moment search gave up: ${JSON.stringify(searchUi)}`);
}
process.exit(fail ? 1 : 0);
