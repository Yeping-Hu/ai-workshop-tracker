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

/* --------------------------------------------------------- pages answer --- */
console.log(`— every page answers (${BASE}) —`);
for (const path of ['/', '/about/', '/alerts/', '/saved/', '/changes/']) {
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
// 45s, not 25s. Papers come from a second Pagefind index fetched after the input
// is ready; warm that is ~8s, but run #33 on 2026-08-30 timed out twice against a
// healthy site — live search was serving 156 paper rows while CI called it
// broken. A genuinely broken index does not recover in 45s either, so the extra
// budget costs no signal and saves a false page.
await page.waitForSelector('.pf-paper .pf-ptitle', { timeout: 45000 }).catch(() => { searched = false; });
check('a keyword search returns paper results', searched, 'no .pf-paper appeared within 45s');

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
}
process.exit(fail ? 1 : 0);
