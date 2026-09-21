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

console.log('— a rendered but unsolved Turnstile widget —');
// What a visitor who has not ticked "Verify you are human" looks like: the
// widget rendered its hidden field, and it is empty. The page must not send.
await page.evaluate(() => {
  const f = document.createElement('input');
  f.type = 'hidden';
  f.name = 'cf-turnstile-response';
  f.value = '';
  document.getElementById('findForm').append(f);
});
await page.fill('#findTitle', 'Learning dexterous grasps from tactile feedback');
await page.click('#findGo');
await page.waitForFunction(() => /Verify you are human/.test(document.getElementById('findStatus').textContent));
check('an unsolved widget stops the submit and says to tick the box, sending nothing',
  /Tick "Verify you are human"/.test(await page.locator('#findStatus').innerText()) && matchBodies.length === 0);
await page.evaluate(() => { window.__findTurnstile = { state: 'error', code: '110200' }; });
await page.click('#findGo');
await page.waitForFunction(() => /Turnstile error/.test(document.getElementById('findStatus').textContent));
check('...and a widget that reported an error quotes its code',
  /Turnstile error 110200/.test(await page.locator('#findStatus').innerText()) && matchBodies.length === 0);
await page.evaluate(() => { document.querySelector('#findForm [name="cf-turnstile-response"]').remove(); delete window.__findTurnstile; });

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
matchResponse = { status: 503, body: { ok: false, error: 'unavailable', detail: 'the model answered HTTP 401 (invalid api key)' } };
await page.click('#findGo');
await page.waitForFunction(() => /switched off|not available/.test(document.getElementById('findStatus').textContent));
const off = await page.locator('#findStatus').innerText();
check('an unavailable matcher says so plainly, and quotes the cause the Worker gave', /switched off|not available/.test(off) && /HTTP 401/.test(off), off);
await page.fill('#findTitle', 'ab');
await page.click('#findGo');
check('a too-short title is refused on the page, without a request', /three characters/.test(await page.locator('#findStatus').innerText()) && matchBodies.length === 3);

console.log('— the way in —');
// Two doors, and neither is in the hero. The first was: one muted line between
// the lede and the search box, the only link to /find/ on the site, worded
// "Find the open calls it fits" — which, a screen above a list the homepage
// calls "open calls" four times, read as a pointer to that list.
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
check('the hero no longer carries the link', (await page.locator('.hero a[href$="/find/"]').count()) === 0);

// Door one: beside the board's heading, where the question actually comes up.
const boardLink = page.locator('.board-head a[href$="/find/"]');
check('the board heading has the matcher beside it', (await boardLink.count()) === 1);
check('...under a heading that names what the rows are', (await page.locator('.board-head h2').innerText()).trim() === 'Upcoming workshops');
const wayIn = (await boardLink.innerText()).replace(/\s+/g, ' ').trim();
// The one rule about its words, and it is a negative one. The first wording,
// "Find the open calls it fits", read as a pointer to the list underneath: a
// verb for looking, then the homepage's own name for that list. No sentence of
// the link may be that shape. Nothing here requires particular words — this
// line has been reworded four times, and a check that named "paste" and
// "abstract" (then "your paper?") turned each rewording into a test failure
// without protecting anything the shape rule does not.
const readsAsTheList = (t) => t.split(/(?<=[?.!])\s+/).some((sentence) => /^(find|see|browse|view|explore)\b[^?.!]*\bopen calls\b/i.test(sentence.trim()));
check('...and it does not read as the list of open calls under it', !readsAsTheList(wayIn), wayIn);
check('...a rule the first wording fails, alone or behind a lead-in',
  readsAsTheList('Find the open calls it fits →') && readsAsTheList('Have a paper? See the open calls →') &&
  !readsAsTheList('Have a paper? Get the open calls ranked by fit →'));
check('...on the heading\'s row, not buried in the grey note under it',
  (await page.locator('.board-note a[href$="/find/"]').count()) === 0 &&
  (await page.evaluate(() => {
    const h = document.querySelector('.board-head h2').getBoundingClientRect();
    const a = document.querySelector('.board-head a').getBoundingClientRect();
    return a.left > h.right && a.top < h.bottom && a.bottom > h.top;
  })));
const note = (await page.locator('.board-note').innerText()).replace(/\s+/g, ' ').trim();
check('the note under it is the one sentence about main conferences', /^Main-conference paper deadlines/.test(note) && !/Workshop calls for papers/.test(note), note);
check('...and still links the deadlines page by its own query',
  (await page.locator('.board-note a[href$="/conference/"]').innerText()).trim() === 'AI conference deadlines');

// Door two: the header, from every page — a visitor who lands on a workshop
// page never sees the homepage.
const navLabel = async () => (await page.locator('.site-nav a[href$="/find/"]').innerText()).trim();
check('the header has a Match entry', (await navLabel()) === 'Match');
check('...second, after Home', (await page.locator('.site-nav a').nth(1).getAttribute('href')).endsWith('/find/'));
check('...whose title says what the one word cannot', /your paper/i.test((await page.locator('.site-nav a[href$="/find/"]').getAttribute('title')) || ''));
await page.goto(`${BASE}/about/`, { waitUntil: 'domcontentloaded' });
check('...on a page that is not the homepage too', (await navLabel()) === 'Match');
await page.goto(`${BASE}/find/`, { waitUntil: 'domcontentloaded' });
check('...and lit on the matcher\'s own page', (await page.locator('.site-nav a[href$="/find/"]').getAttribute('aria-current')) === 'page');

// A phone. The link has no room beside the heading, so it wraps beneath it —
// and must stay ONE line there. The header likewise has room for one more
// short word and not for two rows.
//
// Lines are counted from a Range over the link's text, not from the link's own
// getClientRects(): the link is a flex item, which makes it a block, and a
// block reports one rectangle however many lines its text runs to. The first
// version of this check asked the element, and so passed for any wording at
// any width. The last check in the loop proves the instrument can see a wrap.
// 320px is deliberately not here: the current wording (48 characters) runs to
// two lines there, without scrolling sideways, and that is accepted — it is
// the width of phones from 2016.
for (const width of [375, 360]) {
  await page.setViewportSize({ width, height: 812 });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  const m = await page.evaluate(() => {
    const a = document.querySelector('.board-head a');
    const h = document.querySelector('.board-head h2').getBoundingClientRect();
    const r = a.getBoundingClientRect();
    const textLines = () => {
      const range = document.createRange();
      range.selectNodeContents(a);
      return new Set([...range.getClientRects()].map((x) => Math.round(x.top))).size;
    };
    const lines = textLines();
    a.style.width = '120px';
    const squeezed = textLines();
    a.style.width = '';
    const navTops = [...document.querySelectorAll('.site-nav a')].map((n) => Math.round(n.getBoundingClientRect().top));
    return {
      lines,
      squeezed,
      under: r.top >= h.bottom - 1,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      navRows: new Set(navTops).size,
    };
  });
  check(`at ${width}px the link sits under the heading, on one line`, m.under && m.lines === 1, JSON.stringify(m));
  check(`at ${width}px the header's entries are still one row`, m.navRows === 1, JSON.stringify(m));
  check(`at ${width}px nothing scrolls sideways`, !m.overflow);
  check(`at ${width}px the line count would have seen a wrap (squeezed to 120px it reads ${m.squeezed})`, m.squeezed > 1, JSON.stringify(m));
}
await page.setViewportSize({ width: 1280, height: 900 });

check('no page/console errors during the whole run', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
