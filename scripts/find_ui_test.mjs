#!/usr/bin/env node
/**
 * Headless UI tests for /find/, the paper matcher's page. Needs the
 * alerts-configured build (PUBLIC_ALERTS_API set), served:
 *
 *   node scripts/find_ui_test.mjs [http://localhost:4321]
 *
 * The Worker is stubbed: /match answers a fixed result, doi.org a fixed
 * record, and the Turnstile script is aborted (an ad blocker eats it in real
 * life; the page must cope). What this guards is the rendering contract —
 * every sentence on the page is a template over the response's fields, so the
 * fields, the fit labels, the "what it stood on" line and the error copy are
 * things only a browser can check. ui_test.mjs covers the fork build, where
 * the page must say the matcher is off.
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:4321';
let pass = 0;
let fail = 0;
const errors = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

const RESULT = {
  ok: true,
  model: 'jev-1.13.0',
  paper_topics: [{ id: 'robotics', label: 'Robotics', p: 0.92 }, { id: 'vision', label: 'Computer vision', p: 0.55 }],
  considered: 23,
  open_calls: 31,
  partial: false,
  matches: [
    { slug: 'corl-2026-grasp', url: '/workshop/corl-2026-grasp/', name: 'Workshop on Dexterous Grasping', short_name: 'DexGrasp', conference: { id: 'corl', name: 'CoRL' }, year: 2026, deadline_utc: '2026-10-01T12:00:00.000Z', deadline_wall_clock: 'Oct 1, 2026, 12:00 UTC', website: 'https://dexgrasp.example.org/', topics: ['Robotics'], fit: 'strong', score: 0.83, basis: 'past_papers', past_paper_count: 57 },
    { slug: 'neurips-2026-newrob', url: '/workshop/neurips-2026-newrob/', name: 'First Workshop on Robots in the Wild', short_name: 'RobWild', conference: { id: 'neurips', name: 'NeurIPS' }, year: 2026, deadline_utc: null, deadline_wall_clock: null, website: null, topics: ['Robotics', 'Computer vision'], fit: 'possible', score: 0.41, basis: 'name_topics', past_paper_count: 0 },
  ],
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  const t = m.text();
  // The 429 and 503 below are this harness's own stubs; the browser logs each
  // as a failed resource, which is the page handling an error, not making one.
  if (m.type() === 'error' && !t.includes('net::ERR_FAILED') && !/status of (429|503)/.test(t)) errors.push(`console: ${t}`);
});
await page.route('**challenges.cloudflare.com**', (r) => r.abort());
let matchBodies = [];
let matchResponse = { status: 200, body: RESULT };
await page.route('**/match', async (r) => {
  matchBodies.push(JSON.parse(r.request().postData() || '{}'));
  r.fulfill({ status: matchResponse.status, contentType: 'application/json', body: JSON.stringify(matchResponse.body) });
});

// doi.org, stubbed: the DataCite CSL-JSON record the prefill reads.
const doiRequests = [];
await page.route('**doi.org/**', (r) => {
  doiRequests.push({ url: r.request().url(), accept: r.request().headers().accept });
  r.fulfill({
    status: 200,
    contentType: 'application/vnd.citationstyles.csl+json',
    body: JSON.stringify({ type: 'article', title: 'LoRA: Low-Rank Adaptation of Large Language Models', abstract: 'An important paradigm of natural language processing consists of large-scale pre-training.' }),
  });
});

console.log('— the page —');
const res = await page.goto(`${BASE}/find/`, { waitUntil: 'domcontentloaded' });
check('the page exists', res.status() === 200);
check('the title carries the query', /^Find Workshops for Your Paper/.test(await page.title()), await page.title());
check('the form is there', await page.locator('#findForm').isVisible());
const privacy = await page.locator('.find-privacy').innerText();
check('the privacy line says what happens to the text', /nothing is stored/.test(privacy) && /TypeSafe/.test(privacy), privacy);

console.log('— the arXiv prefill —');
await page.fill('#findArxiv', 'https://arxiv.org/abs/2106.09685v2');
await page.click('#findPrefill');
await page.waitForFunction(() => document.getElementById('findTitle').value.length > 0);
check('an arXiv link fills the title and abstract from the doi.org record',
  (await page.locator('#findTitle').inputValue()) === 'LoRA: Low-Rank Adaptation of Large Language Models'
    && (await page.locator('#findAbstract').inputValue()).startsWith('An important paradigm'));
check('...asked doi.org for the DataCite DOI as CSL-JSON, version stripped',
  doiRequests.length === 1 && /10\.48550\/arXiv\.2106\.09685$/.test(doiRequests[0].url) && /csl\+json/.test(doiRequests[0].accept), JSON.stringify(doiRequests));
check('...and says so', /Filled in from arXiv/.test(await page.locator('#findStatus').innerText()));
await page.fill('#findArxiv', 'not an id');
await page.click('#findPrefill');
check('something that is not an arXiv id is refused without a request',
  /does not look like an arXiv/.test(await page.locator('#findStatus').innerText()) && doiRequests.length === 1);

console.log('— a result —');
await page.fill('#findTitle', 'Learning dexterous grasps from tactile feedback');
await page.fill('#findAbstract', 'We train a policy on a real robot.');
await page.click('#findGo');
await page.waitForSelector('.find-match');
check('the request carried the title and abstract, no more', matchBodies.length === 1 && matchBodies[0].title.startsWith('Learning dexterous') && matchBodies[0].abstract.startsWith('We train') && 'turnstile_token' in matchBodies[0] && Object.keys(matchBodies[0]).length === 3, JSON.stringify(matchBodies[0]));
const items = page.locator('.find-match');
check('one row per match', (await items.count()) === 2);
const first = items.nth(0);
check('the strongest fit is first, labelled', (await first.getAttribute('data-fit')) === 'strong' && /strong fit/i.test(await first.locator('.find-fit').innerText()));
check('...links the workshop page', (await first.locator('a.find-title').getAttribute('href')).endsWith('/workshop/corl-2026-grasp/') && (await first.locator('a.find-title').innerText()).trim() === 'DexGrasp');
const meta1 = await first.locator('.find-meta').innerText();
check('...names its deadline and what the judgment stood on', /Oct 1, 2026/.test(meta1) && /57 past papers/.test(meta1) && /Website/.test(meta1), meta1);
const second = items.nth(1);
const meta2 = await second.locator('.find-meta').innerText();
check('a first edition says it was judged from the name and topics, with no deadline yet', /name and topics/.test(meta2) && /not announced/.test(meta2), meta2);
check('...and no website link when there is none', (await second.locator('.find-meta a').count()) === 0);
const summary = await page.locator('#findSummary').innerText();
check('the summary counts the calls judged and names the paper\'s topics', /23 of 31/.test(summary) && /Robotics/.test(summary), summary);
check('the status line is clear after a result', (await page.locator('#findStatus').innerText()).trim() === '');

console.log('— errors the Worker can answer with —');
matchResponse = { status: 429, body: { ok: false, error: 'busy' } };
await page.click('#findGo');
await page.waitForFunction(() => /today/.test(document.getElementById('findStatus').textContent));
check('the daily brake reads as "try tomorrow", and the earlier results stay', /today/.test(await page.locator('#findStatus').innerText()) && (await items.count()) === 2);
matchResponse = { status: 503, body: { ok: false, error: 'unavailable' } };
await page.click('#findGo');
await page.waitForFunction(() => /switched off|not available/.test(document.getElementById('findStatus').textContent));
check('an unavailable matcher says so plainly', /switched off|not available/.test(await page.locator('#findStatus').innerText()));
await page.fill('#findTitle', 'ab');
await page.click('#findGo');
check('a too-short title is refused on the page, without a request', /three characters/.test(await page.locator('#findStatus').innerText()) && matchBodies.length === 3);

console.log('— the way in —');
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
check('the homepage links the matcher', (await page.locator('a[href$="/find/"]').count()) >= 1);

check('no page/console errors during the whole run', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
