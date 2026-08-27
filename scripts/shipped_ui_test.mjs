/**
 * Headless UI tests for behaviour that only exists in the *configured* build.
 *
 * Run the alerts-configured build, serve it, then:
 *   node scripts/shipped_ui_test.mjs [http://localhost:4321]
 *
 * Why a third suite. ui_test.mjs is written against the fork build, where
 * PUBLIC_ALERTS_API is empty — and Base.astro emits the session module only
 * when it is set. So every script that ships to aiworkshoptracker.com but not
 * to a fork is, from ui_test's point of view, absent: it can assert whatever it
 * likes about anchors and pass, because the code that could break them was
 * never in the artefact it drove.
 *
 * That is not hypothetical. alerts-session.js cleared the URL fragment with a
 * blanket `if (location.hash)` for twelve days (527c480 → 942dd16). It runs in
 * <head> on every page, so it wiped #p-<paper> and #papers before the browser
 * could scroll to them: every deep link into a paper, and every link a
 * subscriber had been sent, silently landed at the top of the page instead.
 * ui_test.mjs has asserted `:target` highlighting the whole time and stayed
 * green throughout, because in its build the module does not exist.
 *
 * So this suite exists to drive the artefact that actually ships, and the rule
 * for what belongs here is that shape of bug: anything a head-script running on
 * every page could break, and anything whose only failure mode is the presence
 * of the alerts scripts. It reuses the workflow's alerts build rather than
 * adding a third one.
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:4321';
let pass = 0, fail = 0;
const errors = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  const t = m.text();
  // Noise this harness creates rather than finds: in CI PUBLIC_ALERTS_API points
  // at a domain that does not resolve, and the deliberate junk token below is
  // answered with a 401 when the suite is pointed at a real deployment.
  if (m.type() === 'error' && !/net::ERR_|Failed to fetch|status of 401/.test(t)) errors.push(`console: ${t}`);
});

// Third-party, and would make the suite depend on a live CDN. Aborting it also
// silences the widget's own console chatter, which is not this site's output.
await page.route('**challenges.cloudflare.com**', (r) => r.abort());

/* ---------------------------------------------- the fragment must survive -- */
// Driven the way a reader actually arrives: search, click a paper, land on the
// row. Discovering the slug from the search index rather than hard-coding one
// keeps the suite honest when the corpus changes.
console.log('— a search result lands on the paper, not the top of the page —');
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#q', { timeout: 20000 });
await page.fill('#q', 'learning');
await page.waitForSelector('.pf-paper .pf-ptitle', { timeout: 25000 });

const href = await page.$eval('.pf-paper .pf-ptitle', (a) => a.getAttribute('href'));
check('a paper result carries a #p- anchor', /\/workshop\/[^/]+\/#p-/.test(href), href);

await page.click('.pf-paper .pf-ptitle');
await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(1200);

const landed = await page.evaluate(() => {
  const id = decodeURIComponent(location.hash.slice(1));
  const el = id && document.getElementById(id);
  return {
    hash: location.hash,
    scrolled: scrollY > 50,
    isTarget: el ? el.matches(':target') : false,
    found: !!el,
  };
});
check('the fragment survives the page load', landed.hash.startsWith('#p-'), JSON.stringify(landed));
check('the anchored row exists', landed.found, landed.hash);
check('the browser scrolled to it', landed.scrolled, `scrollY stayed at 0 with hash ${landed.hash}`);
check('and it matches :target', landed.isTarget, landed.hash);

/* ------------------------------------------------- in-page anchors too ----- */
console.log('— an in-page anchor still works —');
const wsUrl = new URL(page.url());
await page.goto(`${wsUrl.origin}${wsUrl.pathname}#papers`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1000);
const papers = await page.evaluate(() => ({ hash: location.hash, scrolled: scrollY > 50 }));
check('#papers survives and scrolls', papers.hash === '#papers' && papers.scrolled, JSON.stringify(papers));

/* ------------------------------------------- but a sign-in token must not -- */
// The other half of the same rule. The session module has to strip `#t=` before
// any await, so a token never sits in the address bar while the network is
// slow — pinning both directions is what stops a fix for one becoming a
// regression in the other.
console.log('— a sign-in fragment is still consumed —');
await page.goto(`${BASE}/saved/#t=notarealtoken&e=someone%40example.com`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
const tok = await page.evaluate(() => ({ hash: location.hash, href: location.href }));
check('a #t= token is cleared from the address bar', tok.hash === '', tok.href);

check('no page/console errors during the whole run', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
