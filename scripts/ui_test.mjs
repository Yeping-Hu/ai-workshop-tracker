/**
 * Headless UI tests for the search-first homepage.
 * Run a build first, then:  node scripts/ui_test.mjs [http://localhost:4321]
 */
import { chromium } from 'playwright';
import { loadEditions, loadAcceptanceRates } from '../lib/editions.mjs';
import { resolveDeadlineUtcMs } from '../lib/dates.mjs';

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
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

await page.goto(BASE, { waitUntil: 'networkidle' });

console.log('— facet panels populate on idle (no typing) —');
await page.waitForFunction(() => document.querySelector('[data-facet="conference"]')?.children.length >= 5, null, { timeout: 8000 });
const confOptions = () => page.$$eval('[data-facet="conference"] input[data-f]', (els) => els.map((e) => e.value));
import { readFileSync as rfTop } from 'node:fs';
const expectedConfs = new Set(JSON.parse(rfTop('site/dist/api/workshops.json', 'utf8')).workshops.map((w) => w.conference)).size;
let opts = await confOptions();
check(`conference panel lists all ${expectedConfs} conferences`, opts.length === expectedConfs, `got ${opts}`);
const eyebrow = await page.$eval('.hero .eyebrow', (el) => el.textContent.trim().replace(/ workshops\s*$/, '').split(' · '));
check('eyebrow order matches conference dropdown', JSON.stringify(eyebrow) === JSON.stringify(opts), `${eyebrow} vs ${opts}`);
// The open-calls line: one item per conference that has an open call, in the
// eyebrow's order, each a single link to its hub. Which conferences those are
// comes from the API (the statline's definition of "open"), never a literal.
const apiTop = JSON.parse(rfTop('site/dist/api/workshops.json', 'utf8')).workshops;
const openConfIds = new Set(apiTop.filter((w) => w.status === 'upcoming' && w.deadline_utc).map((w) => w.conference));
const lineItems = await page.$$eval('.conf-line .conf-tick', (els) =>
  els.map((e) => ({
    name: e.querySelector('.conf-tick-name')?.textContent.trim(),
    href: e.getAttribute('href'),
    count: e.querySelector('.conf-tick-open')?.textContent.trim(),
  })),
);
check(`open-calls line lists the ${openConfIds.size} conferences with an open call`, lineItems.length === openConfIds.size, `got ${lineItems.length}`);
check('line order matches the eyebrow', JSON.stringify(lineItems.map((c) => c.name)) === JSON.stringify(eyebrow.filter((n) => lineItems.some((c) => c.name === n))), lineItems.map((c) => c.name).join(','));
check('every item links to its conference hub', lineItems.every((c) => /\/conference\/[a-z0-9-]+\/$/.test(c.href)), lineItems.map((c) => c.href).join(' '));
check('every item is a count of open calls', lineItems.every((c) => /^\d+ open calls?$/.test(c.count)), lineItems.map((c) => c.count).join(' | '));
check('the line fits in one row', await page.$$eval('.conf-line .conf-tick', (els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().top))).size <= 1));
const initialIclrCount = await page.$eval('[data-count="conference:ICLR"]', (el) => el.textContent);
check('counts rendered', /\(\d+\)/.test(initialIclrCount), initialIclrCount);

console.log('— facet bar centering —');
const centering = await page.$eval('.hero .facetbar', (el) => {
  const cs = getComputedStyle(el);
  const rc = el.querySelector('.resultcount');
  return { jc: cs.justifyContent, rcMargin: rc ? getComputedStyle(rc).marginLeft : null };
});
check('justify-content is center', centering.jc === 'center', centering.jc);
check('resultcount auto-margin removed', centering.rcMargin !== 'auto', String(centering.rcMargin));
const box = await page.$eval('.hero .facetbar details.dd', (el) => el.getBoundingClientRect().left);
check('dropdowns visually not flush-left', box > 150, `left=${box}`);

console.log('— EXACT USER REPRO: check ICML, uncheck, reopen panel —');
await page.click('summary[data-facet-summary="conference"]');
await page.check('[data-facet="conference"] input[value="ICML"]');
await page.waitForSelector('#searchPanel:not([hidden])');
await page.waitForFunction(() => document.querySelectorAll('#results .pf-result').length > 0);
check('selecting ICML shows results', true);
check('board hidden in search mode', await page.$eval('#homeDefault', (el) => el.hidden));
check('URL carries facet', (await page.url()).includes('conference=ICML'));
await page.uncheck('[data-facet="conference"] input[value="ICML"]');
await page.waitForSelector('#homeDefault:not([hidden])');
check('unchecking returns to default mode', true);
await page.click('summary[data-facet-summary="conference"]'); // close
await page.click('summary[data-facet-summary="conference"]'); // reopen
opts = await confOptions();
check('REPRO FIXED: all conferences still listed after uncheck', opts.length === expectedConfs, `got ${opts}`);
check('ICLR count restored to initial', (await page.$eval('[data-count="conference:ICLR"]', (el) => el.textContent)) === initialIclrCount);

console.log('— cross-facet count consistency (select ICML) —');
import { readFileSync as rf } from 'node:fs';
const apiAll = JSON.parse(rf('site/dist/api/workshops.json', 'utf8')).workshops;
await page.check('[data-facet="conference"] input[value="ICML"]');
await page.waitForFunction(() => document.querySelectorAll('#results .pf-result').length > 0);
const numOf = async (f, v) => Number((await page.$eval(`[data-count="${f}:${v}"]`, (el) => el.textContent)).replace(/[()]/g, ''));
const icmlTotal = apiAll.filter((w) => w.conference === 'icml').length;
const icml2026 = apiAll.filter((w) => w.conference === 'icml' && w.year === 2026).length;
check('year counts reflect ICML selection', (await numOf('year', '2026')) === icml2026, `got ${await numOf('year', '2026')} want ${icml2026}`);
const statusSum = await page.$$eval('[data-facet="status"] [data-count]', (els) => els.reduce((n, e) => n + Number(e.textContent.replace(/[()]/g, '')), 0));
check('status counts sum to ICML total', statusSum === icmlTotal, `sum ${statusSum} want ${icmlTotal}`);
check("conference's own counts stay global (any-semantics)", (await numOf('conference', 'ICLR')) === Number(initialIclrCount.replace(/[()]/g, '')));
await page.uncheck('[data-facet="conference"] input[value="ICML"]');
await page.waitForSelector('#homeDefault:not([hidden])');
check('counts restore when cleared', (await numOf('year', '2026')) !== icml2026 || icml2026 === apiAll.filter((w) => w.year === 2026).length);

console.log('— keyword chips + nested paper sublists —');
await page.fill('#q', 'diffusion');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.querySelectorAll('#results .pf-result').length > 0);
check('chip created', (await page.$$eval('.kw-chip', (els) => els.length)) === 1);
check('nested papers sublist rendered', (await page.$$('.pf-papers')).length > 0);
check('paper rows have attribution anchors', (await page.$$eval('.pf-papers .pf-ptitle', (els) => els.length)) > 0);
const hrefs = await page.$$eval('#results .pf-title', (els) => els.map((e) => e.getAttribute('href')));
check('no duplicate workshop entries (single merge)', new Set(hrefs).size === hrefs.length, `dupes in ${hrefs.length}`);
await page.waitForFunction(() => /workshop/.test(document.querySelector('#searchCount')?.textContent || ''), null, { timeout: 15000 });
const count = await page.$eval('#searchCount', (el) => el.textContent);
check('combined count format', /^\d+ workshops? · \d+ matching papers? · by relevance( · page \d+\/\d+)?$/.test(count), count);
{
  const headlineN = Number(count.match(/^(\d+) workshop/)[1]);
  let seen = (await page.$$('#results > .pf-result')).length;
  const pages = await page.$$eval('#results .pager button[data-page]', (els) => els.map((b) => Number(b.dataset.page)));
  for (const n of pages.slice(1)) {
    await page.click(`#results .pager button[data-page="${n}"]`);
    await page.waitForFunction((m) => document.querySelector('.pager button.is-on')?.dataset.page === String(m), n);
    seen += (await page.$$('#results > .pf-result')).length;
  }
  check('headline workshops == total entries across pages', seen === headlineN, `saw ${seen}, headline ${headlineN}`);
  if (pages.length > 1) {
    await page.click('#results .pager button[data-page="1"]');
    await page.waitForFunction(() => document.querySelector('.pager button.is-on')?.dataset.page === '1');
  }
}
check('workshop title links are internal (same tab)', await page.$eval('#results .pf-title', (a) => a.target !== '_blank' && a.host === location.host));
check('paper title links are internal (same tab)', await page.$eval('.pf-papers .pf-ptitle', (a) => a.target !== '_blank' && a.host === location.host));
await page.click('.kw-chip .kw-x');
await page.waitForSelector('#homeDefault:not([hidden])');
check('removing chip restores default mode', true);

console.log('— multi-keyword AND is consistent at both levels —');
const parseCount = (s) => {
  const m = s.match(/^(\d+) workshops?(?: · (\d+) matching papers?)?/);
  return { ws: Number(m[1]), papers: Number(m[2] || 0) };
};
await page.fill('#q', 'robot');
await page.keyboard.press('Enter');
await page.waitForFunction(() => /workshop/.test(document.querySelector('#searchCount')?.textContent || ''));
const c1 = parseCount(await page.$eval('#searchCount', (el) => el.textContent));
await page.fill('#q', 'llm');
await page.keyboard.press('Enter');
// URL syncs only when the new render completes — deterministic wait
await page.waitForFunction(() => new URL(location.href).searchParams.get('q') === 'robot,llm');
await page.waitForFunction(() => /workshop/.test(document.querySelector('#searchCount')?.textContent || ''));
const c2 = parseCount(await page.$eval('#searchCount', (el) => el.textContent));
check('adding a keyword narrows workshops', c2.ws <= c1.ws, `${c1.ws} -> ${c2.ws}`);
check('adding a keyword narrows papers too', c2.papers <= c1.papers, `${c1.papers} -> ${c2.papers}`);
const dual = await page.$$eval('.pf-papers li:not(.pf-subhead):not(.pf-more):not(.pf-xfall)', (els) =>
  els.slice(0, 10).map((li) => {
    // Excerpts are authors-only now, so a keyword may live on the title line
    // instead — both lines together must show both keywords.
    const hay = (
      (li.querySelector('.pf-ptitle')?.textContent ?? '') +
      ' ' +
      [...li.querySelectorAll('.pf-excerpt mark')].map((m) => m.textContent).join(' ')
    ).toLowerCase();
    return hay.includes('robot') && hay.includes('llm');
  }),
);
check('every listed paper carries both keywords (title + excerpt)', dual.length > 0 && dual.every(Boolean), JSON.stringify(dual));
await page.click('#clearSearch');
await page.waitForSelector('#homeDefault:not([hidden])');

console.log('— facet-only browse: clean headline, no paper sublists —');
await page.click('summary[data-facet-summary="status"]');
await page.check('[data-facet="status"] input[value="Open call"]');
await page.waitForFunction(() => document.querySelectorAll('#results .pf-result').length > 0);
await page.waitForFunction(() => /workshop/.test(document.querySelector('#searchCount')?.textContent || ''), null, { timeout: 15000 });
const browseCount = await page.$eval('#searchCount', (el) => el.textContent);
check('browse headline omits papers segment', /^\d+ workshops? · newest first( · page \d+\/\d+)?$/.test(browseCount), browseCount);
check('browse entries have no paper sublists', (await page.$$('.pf-papers')).length === 0);
await page.uncheck('[data-facet="status"] input[value="Open call"]');
await page.waitForSelector('#homeDefault:not([hidden])');

console.log('— facet counts mean workshops (vs API ground truth) —');
import { readFileSync } from 'node:fs';
const api = JSON.parse(readFileSync('site/dist/api/workshops.json', 'utf8')).workshops;
const apiCount = (c) => api.filter((w) => w.conference === c).length;
const facetNum = async (v) => Number((await page.$eval(`[data-count="conference:${v}"]`, (el) => el.textContent)).replace(/[()]/g, ''));
await page.click('#clearSearch');
await page.waitForSelector('#homeDefault:not([hidden])');
check('ICML facet count == ICML editions in API', (await facetNum('ICML')) === apiCount('icml'), `facet ${await facetNum('ICML')} vs api ${apiCount('icml')}`);
check('ICRA facet count == ICRA editions in API', (await facetNum('ICRA')) === apiCount('icra'), `facet ${await facetNum('ICRA')} vs api ${apiCount('icra')}`);
await page.click('summary[data-facet-summary="conference"]');
await page.check('[data-facet="conference"] input[value="ICML"]');
await page.waitForFunction(() => /workshops/.test(document.querySelector('#searchCount')?.textContent || ''));
const icmlHead = await page.$eval('#searchCount', (el) => el.textContent);
check('ICML headline matches facet count', icmlHead.startsWith(`${apiCount('icml')} workshop`), icmlHead);
console.log('— pagination —');
const expPages = Math.ceil(apiCount('icml') / 50);
await page.waitForFunction((n) => document.querySelectorAll('#results .pager button').length === n, expPages);
check('pager shows all pages', true);
check('page 1 renders at most 50 entries', (await page.$$('#results > .pf-result')).length <= 50);
await page.click(`#results .pager button[data-page="${expPages}"]`);
await page.waitForFunction((n) => new URL(location.href).searchParams.get('page') === String(n), expPages);
check('URL carries page param', true);
const lastCount = (await page.$$('#results > .pf-result')).length;
check('last page renders the remainder', lastCount === apiCount('icml') % 50 || lastCount === 50, `got ${lastCount}`);
check('headline shows page position', /page \d+\/\d+/.test(await page.$eval('#searchCount', (el) => el.textContent)));
await page.click('#results .pager button[data-page="1"]');
await page.waitForFunction(() => !new URL(location.href).searchParams.get('page'));
// pager click sits outside the dropdown, so click-away closed it — reopen
await page.click('summary[data-facet-summary="conference"]');
await page.uncheck('[data-facet="conference"] input[value="ICML"]');
await page.waitForSelector('#homeDefault:not([hidden])');

console.log('— topic options left-aligned —');
await page.click('summary[data-facet-summary="topic"]');
const align = await page.$eval('[data-facet="topic"] label.check', (el) => {
  const cs = getComputedStyle(el);
  return { ta: cs.textAlign, js: cs.justifySelf };
});
check('topic labels left-aligned', align.ta !== 'center' && align.js === 'start', JSON.stringify(align));
const tw = await page.$eval('[data-facet="topic"]', (el) => el.getBoundingClientRect().width);
check('topic panel wide enough for one-line options', tw >= 330, `width ${tw}`);
const oneLine = await page.$$eval('[data-facet="topic"] label.check', (els) => els.every((el) => el.getBoundingClientRect().height < 2 * parseFloat(getComputedStyle(el).lineHeight || '20')));
check('every topic fits on one line', oneLine);
await page.click('h2');

console.log('— deep-linked paper highlight —');
// Paper anchors are now stable ids (p-<forum id>), not positions — grab a
// real one from the page, then deep-link to it.
await page.goto(`${BASE}/workshop/icml-2025-taig/`, { waitUntil: 'networkidle' });
const anchorId = await page.$eval('.paper h3[id^="p-"]', (el) => el.id);
await page.goto(`${BASE}/workshop/icml-2025-taig/#${anchorId}`, { waitUntil: 'networkidle' });
const hl = await page.$eval(`[id="${anchorId}"]`, (el) => getComputedStyle(el).backgroundColor);
check('clicked paper is highlighted via :target', hl !== 'rgba(0, 0, 0, 0)', `${anchorId}: ${hl}`);
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.querySelector('[data-facet="conference"]')?.children.length >= 5);

console.log('— Clear all —');
await page.fill('#q', 'robot');
await page.click('summary[data-facet-summary="year"]');
await page.check('[data-facet="year"] input[value="2026"]');
await page.waitForSelector('#searchPanel:not([hidden])');
await page.click('#clearSearch');
await page.waitForSelector('#homeDefault:not([hidden])');
check('Clear all resets query + facets', (await page.url()).split('?')[1] === undefined);
check('Clear all unchecks boxes', (await page.$$eval('input[data-f]:checked', (els) => els.length)) === 0);

console.log('— dropdown exclusivity + click-away —');
await page.click('summary[data-facet-summary="conference"]');
await page.click('summary[data-facet-summary="topic"]');
check('opening Topic closes Conference', !(await page.$eval('summary[data-facet-summary="conference"]', (s) => s.parentElement.open)));
check('Topic is open', await page.$eval('summary[data-facet-summary="topic"]', (s) => s.parentElement.open));
await page.click('h2');
check('click-away closes all dropdowns', (await page.$$eval('.facetbar details.dd', (els) => els.filter((d) => d.open).length)) === 0);

console.log('— countdown timers tick live —');
await page.evaluate(() => {
  const s = document.createElement('span');
  s.id = 'cd-test';
  s.dataset.deadlineMs = String(Date.now() + 95_000);
  document.body.append(s);
});
await page.waitForTimeout(1300);
const t1 = await page.$eval('#cd-test', (el) => el.textContent);
await page.waitForTimeout(1300);
const t2 = await page.$eval('#cd-test', (el) => el.textContent);
check('countdown format', /^\d+m \d{2}s$/.test(t1), t1);
check('countdown advances every second', t1 !== t2, `${t1} -> ${t2}`);

console.log('— URL state round-trip —');
await page.goto(`${BASE}/?q=diffusion&conference=ICML`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.querySelectorAll('#results .pf-result').length > 0, null, { timeout: 8000 });
check('deep link hydrates chips', (await page.$$eval('.kw-chip', (els) => els.length)) === 1);
check('deep link hydrates facet checkbox', await page.$eval('[data-facet="conference"] input[value="ICML"]', (el) => el.checked));

console.log('— browse order (filters only) vs relevance order (keywords) —');
// Browse = no keywords: open calls first, soonest deadline on top, papers
// index excluded (it has no sort keys and would interleave unsorted).
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.querySelector('[data-facet="conference"]')?.children.length >= 5, null, { timeout: 8000 });
await page.click('summary[data-facet-summary="conference"]');
await page.check('[data-facet="conference"] input[value="IROS"]');
await page.waitForFunction(() => document.querySelectorAll('#results .pf-result').length > 0, null, { timeout: 8000 });
await page.waitForFunction(() => /workshop/.test(document.querySelector('#searchCount')?.textContent || ''), null, { timeout: 15000 });
const ordBrowseCount = await page.$eval('#searchCount', (el) => el.textContent);
check('browse count line says "newest first"', /newest first/.test(ordBrowseCount), ordBrowseCount);
const ordPills = await page.$$eval('#results .pf-result .pill', (els) => els.map((e) => e.textContent.trim()));
check('first browse result is an Open call', ordPills[0] === 'Open call', ordPills.slice(0, 3).join(','));
const ordLastOpen = ordPills.lastIndexOf('Open call');
check('open calls form a contiguous leading band', ordPills.slice(0, ordLastOpen + 1).every((p) => p === 'Open call'), ordPills.join(','));
// Result rows are the board's rows: the paper deadline is the browse sort key
// and sits in the row's local-time element as an ISO instant (the countdown
// may target an abstract stage instead, so it is not the thing to sort by).
const ordDues = await page.$$eval('#results .pf-result', (els) =>
  els
    .filter((e) => e.querySelector('.pill')?.textContent.trim() === 'Open call')
    .map((e) => e.querySelector('.ws-deadline .local[data-iso]')?.getAttribute('data-iso'))
    .filter(Boolean));
const ordDueMs = ordDues.map((d) => Date.parse(d));
check('open-call deadlines ascend', ordDueMs.every((v, i) => i === 0 || !(v < ordDueMs[i - 1])), ordDues.slice(0, 4).join(' | '));
check('due dates shown on open-call rows', ordDues.length >= 2, `got ${ordDues.length}`);
// Rows rendered after load are hydrated like the board: a live countdown that
// has already been given a value, not the "—" placeholder.
let ordTicks = false;
try {
  await page.waitForFunction(() => /\d+[dhm]/.test(document.querySelector('#results .pf-result .countdown[data-deadline-ms]')?.textContent || ''), null, { timeout: 3000 });
  ordTicks = true;
} catch {}
check('browse rows carry a live countdown', ordTicks);
check('browse rows show the local time', (await page.$$eval('#results .pf-result .ws-deadline .local', (els) => els.filter((e) => /Your time:/.test(e.textContent)).length)) >= 2);
await page.uncheck('[data-facet="conference"] input[value="IROS"]');

// Keywords = relevance: count line says so; ordering is Pagefind's, not the bands.
await page.fill('#q', 'surgical robotics');
await page.waitForFunction(() => document.querySelectorAll('#results .pf-result').length > 0, null, { timeout: 8000 });
await page.waitForFunction(() => /workshop/.test(document.querySelector('#searchCount')?.textContent || ''), null, { timeout: 15000 });
const ordKwCount = await page.$eval('#searchCount', (el) => el.textContent);
check('keyword count line says "by relevance"', /by relevance/.test(ordKwCount), ordKwCount);
const ordKwTitle = await page.$eval('#results .pf-result .pf-title', (el) => el.textContent);
check('top relevance hit matches the query topic', /surgical/i.test(ordKwTitle), ordKwTitle);
await page.fill('#q', '');

console.log('— sort picker —');
// Hidden on the board, shown with results; the options are result-sort.js's.
// The query needs a few open calls (fewer than a page) and plenty of closed
// ones and papers, so every order has something to show on page one.
const SORT_Q = 'robot';
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.querySelector('[data-facet="conference"]')?.children.length >= 5, null, { timeout: 8000 });
check('sort picker hidden in default mode', await page.$eval('#sortPick', (el) => el.hidden));
const countSettled = () => page.waitForFunction(() => /workshop/.test(document.querySelector('#searchCount')?.textContent || ''), null, { timeout: 20000 });
const sortInUrl = (v) => page.waitForFunction((want) => new URL(location.href).searchParams.get('sort') === want, v);
const sortValue = () => page.$eval('#sortBy', (s) => s.value);
const countLine = () => page.$eval('#searchCount', (el) => el.textContent);
const titlesOnPage = () => page.$$eval('#results .pf-result .pf-title', (els) => els.map((e) => e.textContent.trim()));
const nameCmp = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const nonDecreasing = (xs) => xs.length > 1 && xs.every((x, i) => i === 0 || x >= xs[i - 1]);
const nonIncreasing = (xs) => xs.length > 1 && xs.every((x, i) => i === 0 || x <= xs[i - 1]);
await page.fill('#q', SORT_Q);
await page.keyboard.press('Enter');
await countSettled();
check('sort picker shown with results', !(await page.$eval('#sortPick', (el) => el.hidden)));
const sortLabels = await page.$$eval('#sortBy option', (os) => os.map((o) => o.textContent));
check('picker lists the four orders', JSON.stringify(sortLabels) === JSON.stringify(['Best match', 'Newest first', 'Paper first', 'Name A–Z']), sortLabels.join(' | '));
check('keywords default to Best match', (await sortValue()) === 'relevance');
check('the default writes no sort to the URL', !new URL(await page.url()).searchParams.has('sort'));
const relOrder = await titlesOnPage();

// Newest first: open calls first, ascending; then closed, most recent first.
await page.selectOption('#sortBy', 'newest');
await sortInUrl('newest');
check('count line states the order', /newest first/.test(await countLine()), await countLine());
const soonRows = await page.$$eval('#results .pf-result', (els) => els.map((e) => ({
  pill: e.querySelector('.pill')?.textContent.trim(),
  iso: e.querySelector('.ws-deadline .local[data-iso]')?.getAttribute('data-iso') || null,
})));
const lastOpen = soonRows.map((r) => r.pill).lastIndexOf('Open call');
check('open calls lead as one band', lastOpen >= 0 && soonRows.slice(0, lastOpen + 1).every((r) => r.pill === 'Open call'), soonRows.slice(0, 6).map((r) => r.pill).join(','));
const openMs = soonRows.slice(0, lastOpen + 1).map((r) => Date.parse(r.iso)).filter(Number.isFinite);
check('open-call deadlines ascend', nonDecreasing(openMs), `${openMs.length} open`);
const closedMs = soonRows.slice(lastOpen + 1).filter((r) => r.pill === 'Past' && r.iso).map((r) => Date.parse(r.iso));
check('closed calls most recent first', nonIncreasing(closedMs), closedMs.slice(0, 4).map((v) => new Date(v).toISOString().slice(0, 10)).join(' | '));

// Name A–Z, the same collation the module uses.
await page.selectOption('#sortBy', 'name');
await sortInUrl('name');
const names = await titlesOnPage();
check('name A–Z: titles ascend', names.length > 1 && names.every((n, i) => i === 0 || nameCmp(names[i - 1], n) <= 0), names.slice(0, 4).join(' | '));
check('count line says "by name"', /by name/.test(await countLine()), await countLine());

// Paper first: what each row lists (five, plus "…N more") never
// increases down the page.
await page.selectOption('#sortBy', 'papers');
await sortInUrl('papers');
const matched = await page.$$eval('#results .pf-result', (els) => els.map((e) =>
  e.querySelectorAll('.pf-papers .pf-paper').length + Number((e.querySelector('.pf-more')?.textContent.match(/(\d+) more/) || [])[1] || 0)));
check('paper first: counts never increase', nonIncreasing(matched), matched.slice(0, 10).join(','));
check('the top result has matching papers', matched[0] > 0, String(matched[0]));
check('count line says "most paper matches first"', /most paper matches first/.test(await countLine()), await countLine());

// Back to Best match: the engine's order again, untouched by the detour.
await page.selectOption('#sortBy', 'relevance');
await sortInUrl('relevance');
check('Best match restores the relevance order', JSON.stringify(await titlesOnPage()) === JSON.stringify(relOrder));

// A choice outlives the keyword it was made with: remove the keyword with a
// filter on and "Name A–Z" still orders the browse, while the two
// keyword-only orders are greyed until a keyword returns.
await page.selectOption('#sortBy', 'name');
await sortInUrl('name');
await page.click('summary[data-facet-summary="conference"]');
await page.check('[data-facet="conference"] input[value="ICML"]');
await page.click('.kw-chip .kw-x');
await page.waitForFunction(() => !new URL(location.href).searchParams.has('q'));
await countSettled();
check('an explicit sort survives removing the keyword', (await sortValue()) === 'name' && /by name/.test(await countLine()), await countLine());
check('Best match is greyed without keywords', await page.$eval('#sortBy option[value="relevance"]', (o) => o.disabled));
check('Paper first is greyed without keywords', await page.$eval('#sortBy option[value="papers"]', (o) => o.disabled));
check('Newest first is not', !(await page.$eval('#sortBy option[value="newest"]', (o) => o.disabled)));
const browseNames = await titlesOnPage();
check('the browse obeys the sort', browseNames.length > 1 && browseNames.every((n, i) => i === 0 || nameCmp(browseNames[i - 1], n) <= 0), browseNames.slice(0, 4).join(' | '));
await page.fill('#q', SORT_Q);
await page.keyboard.press('Enter');
await page.waitForFunction((q) => new URL(location.href).searchParams.get('q') === q, SORT_Q);
await countSettled();
check('an explicit sort survives a new keyword', (await sortValue()) === 'name' && new URL(await page.url()).searchParams.get('sort') === 'name');

// Clear all forgets the sort; the next keyword search is Best match again.
await page.click('#clearSearch');
await page.waitForSelector('#homeDefault:not([hidden])');
check('Clear all drops the sort from the URL', !(await page.url()).includes('sort='));
await page.fill('#q', SORT_Q);
await page.keyboard.press('Enter');
await countSettled();
check('after Clear all, keywords are Best match again', (await sortValue()) === 'relevance' && /by relevance/.test(await countLine()), await countLine());

// Deep links: a known sort hydrates the picker and the order; an unknown one
// is the default and leaves the URL.
await page.goto(`${BASE}/?q=${SORT_Q}&sort=name`, { waitUntil: 'networkidle' });
await countSettled();
const dlNames = await titlesOnPage();
check('deep link hydrates the picker', (await sortValue()) === 'name');
check('deep link applies the order', dlNames.length > 1 && dlNames.every((n, i) => i === 0 || nameCmp(dlNames[i - 1], n) <= 0), dlNames.slice(0, 4).join(' | '));
await page.goto(`${BASE}/?q=${SORT_Q}&sort=bogus`, { waitUntil: 'networkidle' });
await countSettled();
check('an unknown sort is the default', (await sortValue()) === 'relevance');
check('and is dropped from the URL', !new URL(await page.url()).searchParams.has('sort'));

// Changing the sort returns to page one of a paginated set.
await page.goto(`${BASE}/?conference=ICML&page=2`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.querySelector('#results .pager button.is-on')?.dataset.page === '2', null, { timeout: 20000 });
await page.selectOption('#sortBy', 'name');
await page.waitForFunction(() => new URL(location.href).searchParams.get('sort') === 'name' && !new URL(location.href).searchParams.has('page'));
check('changing the sort returns to page 1', (await page.$eval('#results .pager button.is-on', (b) => b.dataset.page)) === '1');

console.log('— deadline board pagination —');
await page.goto(BASE, { waitUntil: 'networkidle' });
const bRows = await page.$$eval('.board [data-ws-row]', (els) => els.length);
if (bRows > 25) {
  const expPages = Math.ceil(bRows / 25);
  check(`board pager rendered with ${expPages} pages`, (await page.$$('.board-pager button')).length === expPages);
  const vis1 = await page.$$eval('.board [data-ws-row]:not(.pg-off)', (els) => els.map((e) => e.dataset.search));
  check('board page 1 shows 25 rows', vis1.length === 25, String(vis1.length));
  await page.click('.board-pager button[data-page="2"]');
  const vis2 = await page.$$eval('.board [data-ws-row]:not(.pg-off)', (els) => els.map((e) => e.dataset.search));
  check('board page 2 swaps in different rows', vis2.length > 0 && vis2[0] !== vis1[0], `n=${vis2.length}`);
  check('board pager marks page 2 active', (await page.$eval('.board-pager button.is-on', (el) => el.dataset.page)) === '2');
  check('board page survives in URL as bpage', (await page.url()).includes('bpage=2'));
  await page.goto(`${BASE}/?bpage=2`, { waitUntil: 'networkidle' });
  check('deep link ?bpage=2 lands on page 2', (await page.$eval('.board-pager button.is-on', (el) => el.dataset.page)) === '2');
  await page.click('.board-pager button[data-page="1"]');
  check('returning to page 1 cleans the URL', !(await page.url()).includes('bpage'));
} else {
  check(`board has ${bRows} rows (≤25) — pager correctly absent`, (await page.$$('.board-pager')).length === 0);
}

console.log('— device-local favorites (star → /saved/ → unstar) —');
await page.goto(BASE, { waitUntil: 'networkidle' });
check('nav badge hidden when nothing saved', await page.$eval('#navSavedCount', (el) => el.hidden));
const firstStar = await page.$('.board [data-star-ws]');
if (firstStar) {
  const starredSlug = await firstStar.getAttribute('data-star-ws');
  await firstStar.click();
  check('star fills on click', (await firstStar.textContent()) === '★');
  check('aria-pressed flips true', (await firstStar.getAttribute('aria-pressed')) === 'true');
  check('nav badge shows 1', (await page.$eval('#navSavedCount', (el) => el.textContent)) === '1');

  // detail page: header Save button reflects board star; star one paper there or elsewhere
  await page.goto(`${BASE}/workshop/${starredSlug}/`, { waitUntil: 'networkidle' });
  check('detail Save button hydrates as saved', await page.$eval('[data-star-ws]', (el) => el.classList.contains('is-on')));

  // find any workshop page with papers and star the first paper
  const { readFileSync } = await import('node:fs');
  const { readdirSync } = await import('node:fs');
  const paperWs = readdirSync('site/dist/workshop').find((d) => {
    try { return readFileSync(`site/dist/workshop/${d}/index.html`, 'utf8').includes('data-star-paper'); } catch { return false; }
  });
  let paperTitle = null;
  if (paperWs) {
    await page.goto(`${BASE}/workshop/${paperWs}/`, { waitUntil: 'networkidle' });
    const pBtn = (await page.$('[data-star-paper][data-pdf^="http"]')) || (await page.$('[data-star-paper]'));
    paperTitle = await pBtn.getAttribute('data-title');
    await pBtn.click();
    check('paper star fills on click', (await pBtn.textContent()) === '★');
    check('nav badge counts workshop + paper', (await page.$eval('#navSavedCount', (el) => el.textContent)) === '2');
  }

  // saved page: live workshop row + paper snapshot, both removable
  await page.goto(`${BASE}/saved/`, { waitUntil: 'networkidle' });
  await page.waitForSelector(`[data-saved-ws="${starredSlug}"]`, { timeout: 8000 });
  check('saved page lists the starred workshop', true);
  // The saved list deliberately has no status pill — the countdown column and the
  // greyed row already say it. What matters is that status is still legible, so
  // assert the countdown carries it rather than asserting the pill is gone.
  check('saved row shows no status pill', (await page.$(`[data-saved-ws="${starredSlug}"] .pill`)) === null);
  check(
    'saved row still states its status via the countdown',
    /^(T−|T-)?\s*[\d]|^(passed|TBA)$/i.test(
      (await page.$eval(`[data-saved-ws="${starredSlug}"] .countdown`, (el) => el.textContent.trim())) || '',
    ),
    await page.$eval(`[data-saved-ws="${starredSlug}"] .countdown`, (el) => el.textContent.trim()),
  );
  if (paperWs) {
    const savedPaper = await page.$eval('.saved-papers li a, .saved-papers li', (el) => el.textContent.trim());
    check('saved page lists the starred paper by title', savedPaper.includes(paperTitle.slice(0, 30)), savedPaper);
    const lnk = await page.$eval('.saved-papers li', (li) => ({
      title: li.querySelector('a')?.getAttribute('href') ?? '',
      pdf: li.querySelector('.pdf-link')?.getAttribute('href') ?? '',
    }));
    check('saved paper title routes to the workshop page anchor', new RegExp(`/workshop/${paperWs}/#p-`).test(lnk.title), lnk.title);
    check('saved paper carries a direct PDF link', /openreview\.net\/pdf\?id=/.test(lnk.pdf), lnk.pdf);
    await page.click('.saved-papers li [data-star-paper]');
    await page.waitForSelector('#savedPaperList .empty-state', { timeout: 4000 });
    check('unstarring last paper shows the empty state', true);
  }
  await page.click(`[data-saved-ws="${starredSlug}"] [data-star-ws]`);
  await page.waitForSelector('#savedWsList .empty-state', { timeout: 4000 });
  check('unstarring last workshop shows the empty state', true);
  check('nav badge hides again at zero', await page.$eval('#navSavedCount', (el) => el.hidden));

  // persistence: re-star, reload, still starred
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('.board [data-star-ws]');
  await page.reload({ waitUntil: 'networkidle' });
  check('star survives a reload (localStorage)', await page.$eval('.board [data-star-ws]', (el) => el.classList.contains('is-on')));
  await page.click('.board [data-star-ws]'); // leave storage clean
} else {
  check('board empty — favorites flow skipped (no open calls to star)', true);
}

console.log('— favorites in search & filter results (issues: save any workshop / any filter / clean paper lines) —');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.fill('#q', 'language');
await page.waitForSelector('#results .pf-papers li > [data-star-paper]', { timeout: 10000 });
check('keyword results: workshop rows have star buttons', (await page.$('#results .pf-result [data-star-ws]')) !== null);
const pap = await page.$eval('#results .pf-papers li:has(.pf-ptitle)', (li) => ({
  hasStar: !!li.querySelector(':scope > [data-star-paper]'),
  title: li.querySelector('.pf-ptitle')?.textContent.trim() ?? '',
  excerpt: li.querySelector('.pf-excerpt')?.textContent.trim() ?? '',
  href: li.querySelector('.pf-ptitle')?.getAttribute('href') ?? '',
  emptyMarks: [...li.querySelectorAll('.pf-excerpt mark')].filter((m) => !m.textContent).length,
  // Left edges of the title and the author line: the star sits in its own grid
  // column so the two start together, as they do on a workshop page.
  titleLeft: Math.round(li.querySelector('.pf-ptitle').getBoundingClientRect().left),
  excerptLeft: Math.round(li.querySelector('.pf-excerpt').getBoundingClientRect().left),
}));
check('paper line 1 has a real star button', pap.hasStar);
check('paper line 1 carries no leaked star glyph', !/[☆★]/.test(pap.title), pap.title.slice(0, 40));
check('paper line 2 no longer repeats the title', !pap.excerpt.toLowerCase().startsWith(pap.title.slice(0, 25).toLowerCase()), pap.excerpt.slice(0, 60));
check('paper line 2 carries no star glyphs', !/[☆★]/.test(pap.excerpt), pap.excerpt.slice(0, 60));
// Pagefind writes "Title. Authors · PDF." for a paper region. Stripping the
// title used to leave all three of these behind on screen.
check('paper line 2 does not open on the block separator', !/^[·.]/.test(pap.excerpt), pap.excerpt.slice(0, 60));
check('paper line 2 drops the trailing PDF link text', !/·?\s*PDF\.?$/.test(pap.excerpt), pap.excerpt.slice(-30));
check('paper line 2 leaves no empty <mark> behind', pap.emptyMarks === 0, `${pap.emptyMarks} empty mark(s)`);
check('a paper result links to its anchor on the workshop page', /\/workshop\/[^/]+\/#p-/.test(pap.href), pap.href);
check('paper line 2 starts where line 1 does', pap.titleLeft === pap.excerptLeft, `title ${pap.titleLeft} vs excerpt ${pap.excerptLeft}`);
// The title line carries the engine's highlights. Pagefind's sub-result title
// is plain text; the marks live only in the excerpt's own copy of the title,
// which the page cuts off and shows as the title line rather than discarding.
// The star's data-title is the plain title, so the two must read the same.
const titled = await page.$$eval('#results .pf-papers li:has(.pf-ptitle)', (lis) => lis.map((li) => ({
  text: li.querySelector('.pf-ptitle').textContent.replace(/\s+/g, ' ').trim(),
  plain: (li.querySelector(':scope > [data-star-paper]')?.dataset.title ?? '').replace(/\s+/g, ' ').trim(),
  marks: [...li.querySelectorAll('.pf-ptitle mark')].map((m) => m.textContent),
})));
check('a matched word in a paper title is highlighted', titled.some((t) => t.marks.length > 0), `${titled.filter((t) => t.marks.length).length} of ${titled.length} titles`);
// Pagefind marks whole tokens, hyphens included ("Vision-Language" is one
// mark), so the keyword is inside the marked word, not necessarily its start.
check('every highlighted title word contains the keyword', titled.every((t) => t.marks.every((m) => /langu/i.test(m))), JSON.stringify(titled.flatMap((t) => t.marks).filter((m) => !/langu/i.test(m)).slice(0, 8)));
check('no empty <mark> in a title', titled.every((t) => t.marks.every((m) => m.trim())));
check('the highlighted title reads exactly as the plain title', titled.every((t) => !t.plain || t.text === t.plain), JSON.stringify(titled.find((t) => t.plain && t.text !== t.plain) ?? null));

// Star one paper from the results, then a second paper of the SAME workshop
// from its page — both must land in one group on /saved/.
const resPaperBtn = await page.$('#results .pf-papers li > [data-star-paper]');
const mergeWs = await resPaperBtn.getAttribute('data-ws');
await resPaperBtn.click();
check('starring a paper from results fills it', (await resPaperBtn.textContent()) === '★');
await page.goto(`${BASE}/workshop/${mergeWs}/`, { waitUntil: 'networkidle' });
for (const b of await page.$$('[data-star-paper][data-pdf^="http"], [data-star-paper]')) {
  if ((await b.textContent()) === '☆') { await b.click(); break; }
}
await page.goto(`${BASE}/saved/`, { waitUntil: 'networkidle' });
await page.waitForSelector('.saved-papers li', { timeout: 8000 });
check('search-saved + page-saved papers merge into one workshop group', (await page.$$('.saved-paper-group')).length === 1);
check('merged group holds both papers', (await page.$$('.saved-papers li')).length === 2);
const mergedLinks = await page.$$eval('.saved-papers li', (lis) => lis.map((li) => ({
  t: li.querySelector('a')?.getAttribute('href') || '',
  pdf: !!li.querySelector('.pdf-link'),
})));
check('search-saved AND page-saved titles BOTH route to workshop pages', mergedLinks.every((h) => /\/workshop\/[^/]+\/#p-/.test(h.t)), JSON.stringify(mergedLinks));
check('page-saved paper shows its PDF link', mergedLinks.some((h) => h.pdf), JSON.stringify(mergedLinks));

// Facet-only filtering (no keyword): every listed workshop must be starrable.
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.click('summary[data-facet-summary="year"]');
await page.check('[data-facet="year"] input[data-f]'); // whatever the first year is
await page.waitForSelector('#results .pf-result [data-star-ws]', { timeout: 10000 });
const yearStars = await page.$$eval('#results .pf-result', (els) => els.filter((e) => e.querySelector('[data-star-ws]')).length);
const yearRows = (await page.$$('#results .pf-result')).length;
check(`year-filtered results all starrable (${yearStars}/${yearRows})`, yearRows > 0 && yearStars === yearRows);
const yBtn = await page.$('#results .pf-result [data-star-ws]');
await yBtn.click();
check('starring from filtered results works', (await yBtn.textContent()) === '★');
check('state survives a re-render (pagination/hydrate)', await page.$eval('#results .pf-result [data-star-ws]', (el) => el.classList.contains('is-on')));
await page.evaluate(() => localStorage.clear());

console.log('— saved-paper link consistency (legacy + no-PDF snapshots) —');
const { readFileSync: rfL, readdirSync: rdL } = await import('node:fs');
const noPdf = JSON.parse(rfL('site/dist/api/papers-without-pdf.json', 'utf8'));
check('papers-without-pdf endpoint built', noPdf.count > 0 && noPdf.ids.length === noPdf.count, String(noPdf.count));
let legacy = null;
for (const f of rdL('cache/openreview')) {
  const c = JSON.parse(rfL(`cache/openreview/${f}`, 'utf8'));
  const hit = (c.papers || []).find((q) => q.pdf_url && q.forum_url);
  if (hit) { legacy = { id: hit.forum_url.match(/id=([^&#]+)/)[1], ws: f.replace(/\.json$/, '') }; break; }
}
await page.evaluate(([leg, noId]) => {
  localStorage.setItem('awt-fav-papers', JSON.stringify([
    { id: leg.id, title: 'Legacy snapshot', url: 'https://openreview.net/forum?id=' + leg.id, ws: leg.ws, wsName: 'Legacy WS' },
    { id: noId, title: 'PDF-less from search', ws: leg.ws, wsName: 'Legacy WS' },
    { id: 'abc123', title: 'Known no-PDF page save', ws: leg.ws, wsName: 'Legacy WS', pdf: '' },
  ]));
}, [legacy, noPdf.ids[0]]);
await page.goto(`${BASE}/saved/`, { waitUntil: 'networkidle' });
await page.waitForSelector('.saved-papers li', { timeout: 8000 });
const rows = await page.$$eval('.saved-papers li', (lis) => lis.map((li) => ({
  title: li.querySelector('a')?.textContent.trim(),
  href: li.querySelector('a')?.getAttribute('href') || '',
  pdf: li.querySelector('.pdf-link')?.getAttribute('href') || null,
})));
const byTitle = Object.fromEntries(rows.map((x) => [x.title, x]));
check('legacy snapshot: title rerouted to the workshop page', new RegExp(`/workshop/${legacy.ws}/#p-${legacy.id}`).test(byTitle['Legacy snapshot']?.href || ''), JSON.stringify(byTitle['Legacy snapshot']));
check('legacy snapshot: PDF link derived from forum id', byTitle['Legacy snapshot']?.pdf === `https://openreview.net/pdf?id=${legacy.id}`, String(byTitle['Legacy snapshot']?.pdf));
check('derived PDF suppressed for papers without one', byTitle['PDF-less from search']?.pdf === null, String(byTitle['PDF-less from search']?.pdf));
check('stored empty pdf renders no PDF link', byTitle['Known no-PDF page save']?.pdf === null, String(byTitle['Known no-PDF page save']?.pdf));
await page.evaluate(() => localStorage.clear());

console.log('— a saved slug that left the dataset (merged away, or removed) —');
// The list stores slugs, so an entry that leaves the corpus used to stay in it
// as a save nothing could render: counted by the heading and the nav badge,
// with no row to un-star. Seed one of each kind and assert the page comes back
// consistent — a merged slug followed, a removed one gone, and the count equal
// to what is on screen.
{
  const dump = JSON.parse(rfL('site/dist/api/workshops.json', 'utf8'));
  const moved = Object.entries(dump.moved_slugs || {});
  const liveTwo = dump.workshops.slice(0, 2).map((w) => w.slug);
  const ghost = 'icml-2019-a-workshop-that-no-longer-exists';
  const seed = [liveTwo[0], ghost, liveTwo[1], ...moved.map(([from]) => from)];
  const volumes = async () =>
    (await page.$$('#savedWsList [data-saved-ws]')).length + (await page.$$('#savedArcMount [data-slug]')).length;
  await page.evaluate((list) => {
    localStorage.setItem('awt-fav-workshops', JSON.stringify(list));
    // Otherwise an empty archive opens the 16-volume demo, whose books carry
    // the same data-slug and would be counted as the reader's own.
    localStorage.setItem('awt-shelf-demo', 'hidden');
  }, seed);
  await page.goto(`${BASE}/saved/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#savedWsList [data-saved-ws], #savedArcMount [data-slug]', { timeout: 8000 });

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('awt-fav-workshops') || '[]'));
  check('a slug that left the dataset is cleared from storage', !stored.includes(ghost), JSON.stringify(stored));
  check('saves that still exist are untouched', liveTwo.every((s) => stored.includes(s)), JSON.stringify(stored));
  // The account holds the same stale slug, and the merge rule adopts anything
  // the server has that this device did not explicitly remove — so a repair
  // that only wrote localStorage would be undone on the next reconcile.
  const outbox = await page.evaluate(() => JSON.parse(localStorage.getItem('awt-fav-pending') || '{}'));
  check('the removal is recorded for the account, not just done locally', (outbox.removeWs || []).includes(ghost), JSON.stringify(outbox));
  const shown = await volumes();
  // Two headings now partition the list, so it is their SUM that must equal
  // what the page renders — either alone would be a half-truth.
  const headSum = async () =>
    Number((await page.$eval('#savedWsCount', (el) => el.textContent)).replace(/\D/g, '')) +
    Number((await page.$eval('#savedArcHeadCount', (el) => el.textContent)).replace(/\D/g, ''));
  check(
    'the two headings together count exactly what the page renders',
    (await headSum()) === shown,
    `${await headSum()} vs ${shown} rendered`,
  );
  check(
    'the reader is told what was taken off the list',
    /taken off your list/.test(await page.$eval('#savedWsList', (el) => el.textContent)),
  );
  if (moved.length) {
    check(
      'a merged-away slug follows the merge instead of vanishing',
      stored.includes(moved[0][1]) && !stored.includes(moved[0][0]),
      `${moved[0][0]} -> ${moved[0][1]}: ${JSON.stringify(stored)}`,
    );
  }

  // Second visit: the repair is done, so there is nothing to fix and nothing to
  // say — the note is a one-off, not a permanent footnote like the count was.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#savedWsList [data-saved-ws], #savedArcMount [data-slug]', { timeout: 8000 });
  const second = await page.$eval('#savedWsList', (el) => el.textContent);
  check('the note does not return on the next visit', !/taken off your list|no longer in the dataset/.test(second), second.slice(0, 120));
  check(
    'and the counts still match the rows',
    (await headSum()) === (await volumes()),
  );
  await page.evaluate(() => localStorage.clear());
}

console.log('— external links open a new tab; internal links navigate in place —');
const ctx = page.context();
const popupOn = async (sel) => {
  const [pop] = await Promise.all([ctx.waitForEvent('page', { timeout: 8000 }), page.click(sel)]);
  await pop.waitForLoadState('domcontentloaded');
  const u = pop.url();
  await pop.close();
  return u;
};
// An internal link must NOT open a popup — it navigates the same tab.
const navsInPlace = async (sel) => {
  const before = ctx.pages().length;
  const popup = ctx.waitForEvent('page', { timeout: 1500 }).then(() => true).catch(() => false);
  await page.click(sel);
  const openedPopup = await popup;
  return !openedPopup && ctx.pages().length === before;
};
await page.goto(BASE, { waitUntil: 'networkidle' });
// Internal: board workshop name -> same tab, navigates to the workshop page.
check('board workshop name navigates in the SAME tab', await navsInPlace('.board .ws-name a') && page.url().includes('/workshop/'));
// External: a workshop's own website (different host) -> new tab.
await page.goto(BASE, { waitUntil: 'networkidle' });
const extSel = '.board .ws-row a[href^="http"]:not([href*="' + new URL(BASE).host + '"])';
if (await page.$(extSel)) {
  const u = await popupOn(extSel);
  check('external workshop website opens a NEW tab', !u.includes(new URL(BASE).host));
} else {
  check('external workshop website opens a NEW tab', true, '(no external link on first board page — skipped)');
}
// Search-result workshop title is internal -> same tab.
await page.fill('#q', 'language');
await page.waitForSelector('#results .pf-papers li > [data-star-paper]', { timeout: 10000 });
check('search-result workshop title navigates in the SAME tab', await navsInPlace('#results .pf-result .pf-title') && page.url().includes('/workshop/'));
// Header nav: same tab (unchanged).
await page.goto(BASE, { waitUntil: 'networkidle' });
const tabsBefore = ctx.pages().length;
await page.click('.site-nav a[href$="/about/"]');
await page.waitForURL('**/about/');
check('header nav navigates in the SAME tab', ctx.pages().length === tabsBefore && page.url().includes('/about/'));
await page.evaluate(() => localStorage.clear());

console.log('— back-navigation restores results and keeps internal links in-tab —');
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.fill('#q', 'language');
await page.keyboard.press('Enter');
await page.waitForSelector('#results .pf-result .pf-title', { timeout: 10000 });
const bnResultsBefore = (await page.$$('#results .pf-result')).length;
const bnTabs0 = ctx.pages().length;
await page.click('#results .pf-result .pf-title');
await page.waitForURL('**/workshop/**', { timeout: 8000 }).catch(() => {});
check('result click navigates in the SAME tab', ctx.pages().length === bnTabs0 && page.url().includes('/workshop/'));
await page.goBack();
// the fix: results must repopulate on back (was empty — debounced search swallowed)
await page.waitForFunction(() => document.querySelectorAll('#results .pf-result').length > 0, { timeout: 8000 }).catch(() => {});
const bnResultsAfter = (await page.$$('#results .pf-result')).length;
check('search results restore after Back', bnResultsAfter > 0 && bnResultsAfter === bnResultsBefore, `${bnResultsBefore} -> ${bnResultsAfter}`);
// clicking another internal link after Back must NOT open a new tab
const bnTabs1 = ctx.pages().length;
const bnPopup = ctx.waitForEvent('page', { timeout: 1500 }).then(() => true).catch(() => false);
await page.click('#results .pf-result .pf-title');
const bnOpenedTab = await bnPopup;
check('internal link after Back stays in the SAME tab', bnOpenedTab === false && ctx.pages().length === bnTabs1);
await page.evaluate(() => localStorage.clear());

console.log('— the same keyword search returns a deterministic order —');
async function searchOrder(term) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.fill('#q', term);
  await page.keyboard.press('Enter');
  await page.waitForSelector('#results .pf-result .pf-title', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll('#results .pf-result').length > 1, { timeout: 8000 }).catch(() => {});
  return page.$$eval('#results .pf-result .pf-title', (els) => els.slice(0, 10).map((e) => e.textContent.trim()));
}
const ord1 = await searchOrder('learning');
const ord2 = await searchOrder('learning');
const ord3 = await searchOrder('learning');
check('identical keyword search → identical order (run 1 vs 2)', JSON.stringify(ord1) === JSON.stringify(ord2), `${ord1[0]} | ${ord2[0]}`);
check('identical keyword search → identical order (run 2 vs 3)', JSON.stringify(ord2) === JSON.stringify(ord3));
await page.evaluate(() => localStorage.clear());

// The papers index must be merged into the engine EXACTLY ONCE per worker.
// Pagefind's init()/mergeIndex() are NOT idempotent — they append — and a
// dynamic import of the same URL reuses one cached module backed by one Web
// Worker, so any code path that re-runs init+merge on it stacks the papers
// index as duplicate documents. Locally those duplicates share URLs, so the
// app's URL de-dup hides them in the headline; asserting on the headline alone
// would pass even with a doubly-loaded worker. So probe the worker directly —
// total paper documents vs distinct paper pages — which catches a regression
// HERE rather than only on the live CDN, where the duplicates pick up slightly
// different URLs, defeat de-dup, and inflate the visible counts (the reported
// symptom: the same 'llm' query climbing 260/2325 → 513/7894 over a warm,
// repeatedly-loaded or back/forward-restored session). Each load uses a FRESH
// context so it is genuinely cold (its own HTTP cache, module registry, worker).
console.log('— the papers index is merged exactly once per worker (no stacking) —');
async function coldWorkerLoad() {
  const ctx = await browser.newContext();
  const jsUrls = [];
  const p = await ctx.newPage();
  p.on('request', (req) => { if (/\/pagefind\/pagefind\.js(\?|$)/.test(req.url())) jsUrls.push(req.url()); });
  await p.goto(`${BASE}/?q=llm`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => /\d+ workshop/.test(document.querySelector('#searchCount')?.textContent || ''), { timeout: 15000 });
  const headline = await p.$eval('#searchCount', (el) => el.textContent.replace(/· page \d+\/\d+/, '').trim());
  // Read the worker the app actually settled on by importing the SAME engine
  // URL it loaded (plain on a clean load; cache-busted after a heal) — search
  // only, never init/merge, so we observe the worker rather than mutate it.
  const probeUrl = jsUrls[jsUrls.length - 1] || `${BASE}/pagefind/pagefind.js`;
  const w = await p.evaluate(async (url) => {
    const pf = await import(url);
    const res = await pf.search('llm');
    const data = await Promise.all(res.results.map((x) => x.data()));
    let docs = 0; const distinct = new Set();
    const slug = (u) => (u.match(/\/workshop\/([^/]+)\//) || [])[1] || u;
    for (const d of data) if ((d.filters?.type ?? []).includes('Papers')) { docs++; distinct.add(slug(d.url)); }
    return { docs, distinct: distinct.size, raw: res.results.length };
  }, probeUrl);
  await ctx.close();
  return { headline, ...w };
}
const r1 = await coldWorkerLoad();
const r2 = await coldWorkerLoad();
check('cold-load counts identical (run 1 vs 2)', r1.headline === r2.headline, `${r1.headline} | ${r2.headline}`);
check('papers index merged once — docs == distinct (run 1)', r1.docs === r1.distinct, JSON.stringify(r1));
check('papers index merged once — docs == distinct (run 2)', r2.docs === r2.distinct, JSON.stringify(r2));

// Engine-level guard: lock in the mechanism the fix depends on. Re-running
// init+merge on the SAME module stacks the papers index (the hazard); guarding
// on module identity, and re-importing under a fresh URL, each keep it single.
console.log('— engine guard: a reused module must not re-merge (the fix mechanism) —');
{
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(`${BASE}/about/`, { waitUntil: 'domcontentloaded' }); // a page that does NOT run the search
  const g = await p.evaluate(async () => {
    const papers = async (pf) => {
      const res = await pf.search('llm');
      const data = await Promise.all(res.results.map((x) => x.data()));
      let n = 0; for (const d of data) if ((d.filters?.type ?? []).includes('Papers')) n++; return n;
    };
    const m0 = await import('/pagefind/pagefind.js?v=guard0');
    await m0.options({ baseUrl: '/' }); await m0.init(); await m0.mergeIndex('/pagefind-papers/', { baseUrl: '/' });
    const single = await papers(m0);
    await m0.mergeIndex('/pagefind-papers/', { baseUrl: '/' }); // second merge on the same module
    const stacked = await papers(m0);
    // guarded body (mirrors ensurePagefind): a no-op on an already-inited module
    let inited = null;
    const m1 = await import('/pagefind/pagefind.js?v=guard1');
    const guarded = async (pf) => { if (inited !== pf) { await pf.options({ baseUrl: '/' }); await pf.init(); await pf.mergeIndex('/pagefind-papers/', { baseUrl: '/' }); inited = pf; } };
    await guarded(m1); await guarded(m1); await guarded(m1);
    const guardedN = await papers(m1);
    return { single, stacked, guardedN };
  });
  await ctx.close();
  check('second merge on same module stacks (hazard present)', g.stacked === g.single * 2, JSON.stringify(g));
  check('guarded re-init stays single-loaded (fix mechanism)', g.guardedN === g.single, JSON.stringify(g));
}
await page.evaluate(() => localStorage.clear());

// The headline must survive the engine returning the SAME workshop under
// DIFFERENT URLs — the real-world inflation (one "llm" query reading 513
// workshops instead of 260 in some browsers). Counting is keyed on the
// workshop slug, not the raw URL, so duplicate-URL copies collapse. Reproduce
// the failure shape directly: merge the papers index a second time under an
// absolute baseUrl into the worker the app uses, then make the app recount.
console.log('— duplicate-URL documents must not inflate the headline —');
{
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const readCount = () => p.$eval('#searchCount', (el) => el.textContent.trim());
  const waitForCount = () => p.waitForFunction(() => /\d+ workshop/.test(document.querySelector('#searchCount')?.textContent || ''), { timeout: 15000 });
  await p.goto(`${BASE}/?q=llm`, { waitUntil: 'domcontentloaded' });
  await waitForCount();
  const clean = await readCount();
  // force the engine to return each page under two distinct URL bases
  const dup = await p.evaluate(async () => {
    const pf = await import('/pagefind/pagefind.js'); // the app's cached module/worker
    await pf.mergeIndex('/pagefind-papers/', { baseUrl: 'https://example.com/' });
    const r = await pf.search('llm'); const data = await Promise.all(r.results.map((x) => x.data()));
    const slug = (u) => (u.match(/workshop\/([^/?#]+)/) || [])[1] || u;
    return { distinctBase: new Set(data.map((d) => d.url.split('#')[0])).size, distinctSlug: new Set(data.map((d) => slug(d.url))).size };
  });
  // recount in the app (clear + re-search busts the per-query cache)
  await p.evaluate(() => document.querySelector('#clearSearch')?.click());
  await p.waitForSelector('#homeDefault:not([hidden])', { timeout: 8000 });
  await p.fill('#q', 'llm'); await p.keyboard.press('Enter');
  await waitForCount();
  const afterDup = await readCount();
  check('engine returns duplicate-URL docs when provoked', dup.distinctBase > dup.distinctSlug, JSON.stringify(dup));
  check('headline unchanged despite duplicate-URL docs', afterDup === clean, `clean="${clean}" afterDup="${afterDup}"`);
  await ctx.close();
}
await page.evaluate(() => localStorage.clear());

const apiWs = JSON.parse(rfL('site/dist/api/workshops.json', 'utf8')).workshops;
const byConfT = {};
for (const w of apiWs) (byConfT[w.conference] ||= []).push(w);
const multiYear = Object.entries(byConfT).find(([, ws]) => new Set(ws.map((w) => w.year)).size >= 2);
const conf1 = multiYear[0];
const ws1 = [...multiYear[1]].sort((a, b) => b.year - a.year);
const wsHi = ws1[0], wsLo = ws1.find((w) => w.year < wsHi.year);
const conf2 = Object.keys(byConfT).find((c) => c !== conf1);
const wsC = byConfT[conf2][0];
const expectedOrder = [conf1, conf2].sort((a, b) => a.localeCompare(b));
await page.evaluate(([a, b, c]) => {
  const snap = (w, n) => ({ id: 'order' + n, title: 'Ordering test ' + n, ws: w.slug, wsName: w.acronym || w.name, pdf: '' });
  localStorage.setItem('awt-fav-papers', JSON.stringify([snap(c, 1), snap(b, 2), snap(a, 3)]));
}, [wsHi, wsLo, wsC]);
await page.goto(`${BASE}/saved/`, { waitUntil: 'networkidle' });
await page.waitForSelector('.saved-conf', { timeout: 8000 });
const confOrder = await page.$$eval('.saved-conf', (els) => els.map((e) => e.dataset.conf));
check('two conference clusters render', confOrder.length === 2, JSON.stringify(confOrder));
check('clusters ranked alphabetically by conference', JSON.stringify(confOrder) === JSON.stringify(expectedOrder), `got ${confOrder}, expected ${expectedOrder}`);
const yearsInC1 = await page.$eval(`.saved-conf[data-conf="${conf1}"]`, (el) => [...el.querySelectorAll('.saved-paper-group')].map((g) => Number(g.dataset.year)));
check('workshop groups inside a conference sort latest-year-first', yearsInC1.length === 2 && yearsInC1[0] > yearsInC1[1], JSON.stringify(yearsInC1));
check('each group still displays its year', await page.$eval(`.saved-conf[data-conf="${conf1}"]`, (el) => [...el.querySelectorAll('.saved-paper-group .g-year')].length === 2));
check('conference heading shows its badge', (await page.$$('.saved-conf-head .badge')).length === 2);
await page.evaluate(() => localStorage.clear());

console.log('— stale search index after a deploy: detect, heal, honest message —');
const errsBefore0 = errors.length;
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.querySelector('[data-facet="year"]')?.children.length > 0, null, { timeout: 8000 });
await page.waitForTimeout(1200); // idle prefetch: the engine memorizes the current data files

// Simulate the deploy by serving 404 for every pagefind file the page would
// re-fetch. This used to move the real files out of site/dist and move them
// back afterwards, which meant a failing assertion aborted the run and left
// the build broken, with 74 files stranded in /tmp. Interception cannot leak:
// the route dies with the page.
let outage = true;
await page.route('**/pagefind*/**', (route) =>
  outage ? route.fulfill({ status: 404, contentType: 'text/plain', body: '' }) : route.continue());

await page.click('summary[data-facet-summary="year"]');
await page.check('[data-facet="year"] input[data-f]');
await page.waitForFunction(() => /Reload the page/.test(document.querySelector('#results')?.textContent || ''), null, { timeout: 15000 });
const staleMsg = await page.$eval('#results', (el) => el.textContent.trim());
check('stale index shows an honest message, not "No matches"', /couldn't be refreshed/.test(staleMsg) && !/No matches/.test(staleMsg), staleMsg.slice(0, 90));
check('message offers a reload button', (await page.$('#results .btn-quiet')) !== null);
// the new deploy's files become reachable — search must recover IN PLACE
outage = false;
await page.uncheck('[data-facet="year"] input[data-f]');
await page.check('[data-facet="year"] input[data-f]');
await page.waitForSelector('#results .pf-result', { timeout: 15000 });
check('search recovers without a page reload once files are back', (await page.$$('#results .pf-result')).length > 0);
await page.unroute('**/pagefind*/**');
// chunk 404s during the simulated outage are expected noise, not regressions
const addedErrs = errors.splice(errsBefore0);
for (const e of addedErrs) if (!/pagefind|fetch|404|load/i.test(e)) errors.push(e);

console.log('— one refused fragment does not empty a search —');
// A keyword search pulls one data fragment per matched result, hundreds at
// once for a common word, and the host occasionally answers one of them with
// a 503: the live smoke test caught exactly one among 527, a different
// fragment on each attempt (#67). Promise.all turned that into a rejected
// search, a heal that refetched everything, and "Reload the page" for a
// search that was 99.8% loaded. The rule now: settle each fragment, drop the
// refused one, render the rest, count it in the diagnostic, and never throw
// the engine away for it.
{
  const errsBefore = errors.length;
  let refused = 0, reimports = 0;
  const onReq = (r) => { if (/\/pagefind\/pagefind\.js\?v=/.test(r.url())) reimports++; };
  page.on('request', onReq);
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.route('**/pagefind*/fragment/**', (route) =>
    refused++ === 0 ? route.fulfill({ status: 503, contentType: 'text/html', body: '503 Service Unavailable' }) : route.continue());
  await page.fill('#q', 'diffusion');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('#results .pf-paper').length > 0, null, { timeout: 15000 }).catch(() => {});
  // The diagnostic is written by the full grouping pass, which for a big
  // result set runs after the first page has already painted.
  await page.waitForFunction(() => window.__aiwtSearchDiag?.query === 'diffusion', null, { timeout: 20000 }).catch(() => {});
  const shown = await page.evaluate(() => ({
    ws: document.querySelectorAll('#results .pf-result').length,
    papers: document.querySelectorAll('#results .pf-paper').length,
    diag: window.__aiwtSearchDiag,
    text: (document.querySelector('#results')?.textContent || '').replace(/\s+/g, ' ').slice(0, 80),
  }));
  check('one 503 fragment: the search still renders workshops and papers', refused >= 1 && shown.ws > 0 && shown.papers > 0, JSON.stringify({ refused, ws: shown.ws, papers: shown.papers, text: shown.text }));
  check('the dropped fragment is counted in the diagnostic', shown.diag?.fragmentsFailed >= 1, JSON.stringify(shown.diag));
  check('and the engine was not thrown away for it', reimports === 0, `${reimports} cache-busted re-import(s)`);
  page.off('request', onReq);
  await page.unroute('**/pagefind*/fragment/**');
  // the refused fragment's 503 is the point of the block, not a regression
  const added = errors.splice(errsBefore);
  for (const e of added) if (!/pagefind|fetch|503|load|decompress/i.test(e)) errors.push(e);
}

/* ------------------------------------------------------------- /changes/ ---
 * The public weekly-changes page. It filters by the board's OWN facet URL
 * contract, so a link built on the board — or by the digest's "and N more →" —
 * has to work here unchanged. Saved rows are highlighted from the same
 * localStorage key the board reads.
 *
 * Tolerant of an empty feed on purpose: data/changes.json is rewritten by the
 * alerts Action, and a genuinely quiet week is a valid state that must render
 * the empty message rather than fail this suite.
 */
console.log('— /changes/: the public weekly changes page —');
await page.goto(`${BASE}/changes/`, { waitUntil: 'domcontentloaded' });
const allRows = await page.$$eval('[data-changes-row]', (els) =>
  els.map((e) => ({ slug: e.getAttribute('data-slug'), conf: e.getAttribute('data-conference') })));
check('the page renders', (await page.title()).length > 0);

if (allRows.length === 0) {
  check('an empty week renders the quiet-week message, not an error',
    await page.locator('text=Nothing has changed').count() > 0);
} else {
  check(`the page lists this week's changes (${allRows.length} rows)`, allRows.length > 0);

  // Facet filtering via the board's param format.
  const conf = allRows[0].conf;
  await page.goto(`${BASE}/changes/?conference=${encodeURIComponent(conf)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(250);
  const visible = await page.$$eval('[data-changes-row]', (els) =>
    els.filter((e) => !e.hidden).map((e) => e.getAttribute('data-conference')));
  check('?conference= filters the rows', visible.length > 0 && visible.every((c) => c === conf),
    JSON.stringify(visible.slice(0, 4)));
  check('rows from other conferences are hidden', visible.length <= allRows.length);
  check('a filtered page says what it is filtered by',
    await page.locator('[data-changes-count]').innerText().then((t) => t.includes(conf)));

  // A conference subheading with every row filtered out must go too.
  const emptyGroups = await page.$$eval('[data-changes-group]', (els) =>
    els.filter((g) => !g.hidden && [...g.querySelectorAll('[data-changes-row]')].every((r) => r.hidden)).length);
  check('no subheading is left over an empty group', emptyGroups === 0, String(emptyGroups));

  // A facet that matches nothing hides everything without breaking the page.
  await page.goto(`${BASE}/changes/?conference=NoSuchConference`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(250);
  const none = await page.$$eval('[data-changes-row]', (els) => els.filter((e) => !e.hidden).length);
  check('an unmatched facet hides every row', none === 0, String(none));

  // Saved state comes from the board's own star button — favorites.js, loaded
  // site-wide, hydrates [data-star-ws] from localStorage through one delegated
  // listener. The page reads nothing itself, so these assert the shared
  // mechanism rather than a copy of it.
  check('every row carries a star, so the column never shifts',
    (await page.$$eval('[data-changes-row] [data-star-ws]', (e) => e.length)) === allRows.length);

  const savedSlug = allRows[0].slug;
  await page.evaluate((sl) => localStorage.setItem('awt-fav-workshops', JSON.stringify([sl])), savedSlug);
  await page.goto(`${BASE}/changes/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  const pressed = await page.$$eval('[data-star-ws][aria-pressed="true"]', (els) => els.map((e) => e.dataset.starWs));
  check('a saved workshop shows a pressed star', pressed.includes(savedSlug), JSON.stringify(pressed));
  check('unsaved workshops do not', pressed.length === 1, String(pressed.length));

  // Starring from THIS page must work, and must work signed out — the whole
  // point is that saving needs no account.
  const other = allRows.find((r) => r.slug !== savedSlug)?.slug;
  if (other) {
    await page.click(`[data-star-ws="${other}"]`);
    await page.waitForTimeout(200);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('awt-fav-workshops') || '[]'));
    check('starring on /changes/ saves it, with no account', stored.includes(other), JSON.stringify(stored));
    check('the clicked star reports itself pressed',
      (await page.getAttribute(`[data-star-ws="${other}"]`, 'aria-pressed')) === 'true');
    await page.click(`[data-star-ws="${other}"]`);
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => JSON.parse(localStorage.getItem('awt-fav-workshops') || '[]'));
    check('clicking again unsaves it', !after.includes(other), JSON.stringify(after));
  }
  await page.evaluate(() => localStorage.removeItem('awt-fav-workshops'));

  // A corrupt value must not blank the page.
  await page.evaluate(() => localStorage.setItem('awt-fav-workshops', '{not json'));
  await page.goto(`${BASE}/changes/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(250);
  check('a corrupt saved list still renders the rows',
    (await page.$$eval('[data-changes-row]', (els) => els.length)) === allRows.length);
  await page.evaluate(() => localStorage.removeItem('awt-fav-workshops'));
}

/* ---------------------------------------------------------------------------
 * /saved/ splits its Workshops section in two: what can still be acted on stays
 * a board row, and everything the site calls Past becomes a book spine on the
 * archive shelf. The split rule itself is pinned corpus-wide by
 * scripts/saved_archive_test.mjs; what only a browser can show is that the two
 * halves receive the right workshops, that the shelf's own controls work, and
 * that its star reaches storage while the demo's star never does.
 * ------------------------------------------------------------------------- */
console.log('— /saved/ archive shelf (past → spines, open calls → rows) —');
await page.evaluate(() => localStorage.clear());
{
  // `api` is the workshops.json already read at the top of this file.
  const pastSlugs = api.filter((w) => w.status === 'past').slice(0, 4).map((w) => w.slug);
  const openSlugs = api.filter((w) => w.status === 'upcoming').slice(0, 2).map((w) => w.slug);

  // An empty shelf opens the demo by itself, so someone who has saved nothing
  // sees the shelf working without having to ask for it.
  await page.goto(`${BASE}/saved/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.awt-book', { timeout: 8000 });
  check('an empty archive opens the demo on its own', true);
  check('the demo says how to work it',
    /Hover a book|Drag a finger/.test(await page.$eval('#savedArcTryNote', (el) => el.textContent)));
  // Exactly one, never both. The two spans are written at runtime, so they carry
  // no data-astro-cid and a scoped rule would match neither — which printed both
  // sentences run together. They are :global() for that reason.
  check('only the hint for this pointer type is shown',
    (await page.$$eval('#savedArcTryNote .hint-hover, #savedArcTryNote .hint-tap',
      (els) => els.filter((e) => getComputedStyle(e).display !== 'none').length)) === 1);
  check('demo paints volumes', (await page.$$('.awt-book')).length > 1);
  // The break captions between conference-years are half of what a shelf looks
  // like, so a demo drawn from one group would demo the wrong thing.
  check('demo spans several conference-years', (await page.$$('.awt-brk')).length > 1);
  // The shelf's own count carried a 'demo' label; with that count gone the
  // note under the shelf is what tells the reader these are not their saves,
  // so that is what gets asserted — same property, different carrier.
  check('demo does not claim the volumes are saved',
    /none of them yours/.test(await page.$eval('#savedArcTryNote', (el) => el.textContent)));
  // The demo is an invitation, not a backlog: one row on a desktop plank,
  // filled well short of the end so it reads as "room for yours".
  const shelfFit = await page.evaluate(() => {
    const rack = document.querySelector('.awt-shelf__rack');
    const kids = [...rack.children];
    const top = kids[0].offsetTop;
    const row = kids.filter((k) => k.offsetTop === top);
    const r = rack.getBoundingClientRect();
    return { rows: new Set(kids.map((k) => k.offsetTop)).size,
             pct: Math.round(((row[row.length - 1].getBoundingClientRect().right - r.left) / r.width) * 100) };
  });
  check('the demo fits one shelf row', shelfFit.rows === 1, `${shelfFit.rows} rows`);
  check('the demo leaves the row visibly unfilled', shelfFit.pct > 35 && shelfFit.pct < 80, `${shelfFit.pct}% full`);

  // A cover is exactly as tall as its own book and its content fills that to
  // within a pixel or two. The location line was the only flex item able to
  // give, so every shortfall was taken out of it and it rendered as a band of
  // letters cut through the middle. Measured with transitions off: a cover
  // caught mid-swing reports its 3D projection, not its layout.
  await page.addStyleTag({ content: '*{transition:none !important;animation:none !important}' });
  const coverFit = await page.evaluate(() => {
    let sliced = 0, spilling = 0;
    for (const bk of document.querySelectorAll('.awt-book')) {
      bk.classList.add('is-open');
      const cov = bk.querySelector('.awt-face--cover');
      const w = cov.querySelector('.awt-cover__where');
      if (w && getComputedStyle(w).display !== 'none' &&
          w.offsetHeight + 0.5 < parseFloat(getComputedStyle(w).lineHeight)) sliced++;
      if (cov.scrollHeight > cov.clientHeight + 1) spilling++;
      bk.classList.remove('is-open');
    }
    return { sliced, spilling, n: document.querySelectorAll('.awt-book').length };
  });
  check('no cover slices its location line', coverFit.sliced === 0, `${coverFit.sliced}/${coverFit.n}`);
  check('no cover overflows its book', coverFit.spilling === 0, `${coverFit.spilling}/${coverFit.n}`);
  // A closing date that has already passed is the one fact about an archived
  // workshop nobody can act on, so neither view carries it.
  check('no cover carries a closing date', (await page.$('.awt-cover__when')) === null);

  check('demo reveals the find box and view toggle',
    (await page.$eval('.awt-arc__tools', (el) => getComputedStyle(el).display)) !== 'none');
  // Every repaint rewrites the count, so switching view must not relabel the
  // demo as volumes the reader saved.
  await page.click('#savedArcListBtn');
  check('the demo is still labelled a demo after a view change',
    /none of them yours/.test(await page.$eval('#savedArcTryNote', (el) => el.textContent)));
  await page.click('#savedArcShelfBtn');
  check('demo leaves the board list empty', (await page.$('#savedWsList .empty-state')) !== null);

  // The point of the guard: playing with the demo must not save anything.
  await page.click('#savedArcListBtn');
  await page.click('.awt-list li:first-child .awt-list__unstar');
  check('a star pressed on the demo never reaches storage',
    (await page.evaluate(() => localStorage.getItem('awt-fav-workshops'))) === null);
  // Dismissing it is an answer, not a toggle: it has to survive a reload, or
  // the offer is made again on every visit.
  await page.click('#savedArcTryBtn');
  check('hiding the demo restores the built-in note', /Nothing shelved yet/.test(await page.$eval('#savedArcMount', (el) => el.textContent)));
  check('a hidden demo hides the find box and view toggle',
    (await page.$eval('.awt-arc__tools', (el) => getComputedStyle(el).display)) === 'none');
  check('the invitation names the demo', /demo/i.test(await page.$eval('#savedArcTryBtn', (el) => el.textContent)));
  await page.goto(`${BASE}/saved/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600); // long enough for the demo to have opened
  check('a hidden demo stays hidden on the next visit', (await page.$$('.awt-book')).length === 0);
  check('and can still be asked back', await (async () => {
    await page.click('#savedArcTryBtn');
    await page.waitForSelector('.awt-book', { timeout: 8000 });
    return true;
  })());
  await page.click('#savedArcTryBtn'); // leave it hidden for the next block
  await page.evaluate(() => localStorage.removeItem('awt-shelf-demo'));

  // A real list, half of it archived.
  await page.evaluate((sl) => localStorage.setItem('awt-fav-workshops', JSON.stringify(sl)), [...pastSlugs, ...openSlugs]);
  await page.goto(`${BASE}/saved/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.awt-book', { timeout: 8000 });
  check('past saves become shelf volumes', (await page.$$('.awt-book')).length === pastSlugs.length);
  check('open calls stay board rows', (await page.$$('[data-saved-ws]')).length === openSlugs.length);
  check('no past save is left in the board list',
    await page.$$eval('[data-saved-ws]', (els, p) => els.every((e) => !p.includes(e.dataset.savedWs)), pastSlugs));
  // Each heading covers its own half now. Asserting both is what catches a
  // regression that moves rows between the two without moving the counts.
  check('the upcoming heading counts the board rows',
    (await page.$eval('#savedWsCount', (el) => el.textContent)) === `(${openSlugs.length})`);
  check('the archived heading counts the shelf volumes',
    (await page.$eval('#savedArcHeadCount', (el) => el.textContent)) === `(${pastSlugs.length})`);
  check('a filled archive drops the demo offer', await page.$eval('#savedArcTry', (el) => el.hidden));

  await page.click('#savedArcListBtn');
  check('List view swaps the rack for rows', (await page.$('.awt-list')) !== null && (await page.$('.awt-shelf__rack')) === null);
  check('List view flips both aria-pressed',
    (await page.$eval('#savedArcListBtn', (el) => el.getAttribute('aria-pressed'))) === 'true' &&
    (await page.$eval('#savedArcShelfBtn', (el) => el.getAttribute('aria-pressed'))) === 'false');
  check('no list row carries a closing date', (await page.$('.awt-list__year')) === null);
  // The slider only moves books; over a list of rows it would visibly do nothing.
  check('List view puts the size slider away',
    (await page.$eval('.saved-arc-size', (el) => getComputedStyle(el).display)) === 'none');
  await page.click('#savedArcShelfBtn');
  check('Shelf view brings the size slider back',
    (await page.$eval('.saved-arc-size', (el) => getComputedStyle(el).display)) !== 'none');
  await page.click('#savedArcListBtn');

  const findFor = await page.$eval('.awt-list li .awt-list__name b', (el) => el.textContent.trim());
  await page.fill('#savedArcFind', findFor);
  check('the find box narrows the archive',
    (await page.$$eval('.awt-list li', (els) => els.filter((e) => getComputedStyle(e).display !== 'none').length)) < pastSlugs.length,
    findFor);
  await page.fill('#savedArcFind', '');

  // The shelf's star is [data-unstar], not [data-star-ws] — favorites.js's
  // delegated listener never sees it, so this is the one path that proves
  // unstarWorkshop() is wired through.
  await page.click('.awt-list li:first-child .awt-list__unstar');
  await page.waitForTimeout(200);
  check('unstarring a volume removes it from storage',
    (await page.evaluate(() => JSON.parse(localStorage.getItem('awt-fav-workshops') || '[]'))).length === pastSlugs.length + openSlugs.length - 1);
  check('unstarring a volume takes it off the shelf', (await page.$$('.awt-list li')).length === pastSlugs.length - 1);
  // A shelf volume belongs to the archived half, so that is the count that
  // moves; the upcoming heading must NOT flinch, which is the whole point of
  // splitting them.
  check('unstarring a volume updates the archived count',
    (await page.$eval('#savedArcHeadCount', (el) => el.textContent)) === `(${pastSlugs.length - 1})`);
  check('and leaves the upcoming count alone',
    (await page.$eval('#savedWsCount', (el) => el.textContent)) === `(${openSlugs.length})`);

  // Opening a cover by hover is the real path to the shelf-view star.
  await page.click('#savedArcShelfBtn');
  await page.hover('.awt-book .awt-face--spine');
  await page.waitForSelector('.awt-book.is-open', { timeout: 4000 });
  check('hovering a spine opens its cover', true);
  await page.click('.awt-book.is-open .awt-cover__unstar');
  await page.waitForTimeout(200);
  check('the star on an open cover unstars too',
    (await page.evaluate(() => JSON.parse(localStorage.getItem('awt-fav-workshops') || '[]'))).length === pastSlugs.length + openSlugs.length - 2);

  // Saved, but nothing open: the board half needs different copy from "you have
  // saved nothing at all".
  await page.evaluate((sl) => localStorage.setItem('awt-fav-workshops', JSON.stringify(sl)), pastSlugs);
  await page.goto(`${BASE}/saved/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.awt-book', { timeout: 8000 });
  check('an all-archived list says so instead of claiming nothing is saved',
    /Nothing open right now/.test(await page.$eval('#savedWsList .empty-state', (el) => el.textContent)));

  // Book size: a legibility setting, so unlike the Shelf/List choice it is kept.
  /* ---- break captions ----
     A caption is absolutely positioned, so nothing reserves room for it: the
     space it gets is only ever what its own group occupies. One book is ~27px
     against a caption of ~53px, so one-book groups used to print their captions
     over each other. They now stack onto two lines when — and only when — one
     line will not fit. Seeded so EVERY group is a single book, which is the
     worst case and the one that was broken. */
  console.log('— /saved/ archive shelf: break captions —');
  {
    const seen = new Set();
    const oneEach = [];
    for (const w of api) {
      if (!(w.status === 'past' || w.status === 'deadline_passed')) continue;
      const k = `${w.conference}-${w.year}`;
      if (seen.has(k)) continue;
      seen.add(k);
      oneEach.push(w.slug);
      if (oneEach.length >= 8) break;
    }
    // A group with room, so the fix cannot pass by stacking everything.
    const roomy = api.filter((w) => (w.status === 'past' || w.status === 'deadline_passed') &&
      `${w.conference}-${w.year}` === [...seen][1]).slice(0, 5).map((w) => w.slug);

    const probe = () => {
      const rack = document.querySelector('.awt-shelf__rack');
      const brks = [...rack.querySelectorAll('.awt-brk')];
      let minCaptionGap = Infinity, minYearGap = Infinity, misaligned = 0, stacked = 0;
      brks.forEach((b, i) => {
        const lab = b.querySelector('.awt-brk__label');
        const lr = lab.getBoundingClientRect();
        const item = b.getBoundingClientRect();
        // The LINE BOX, not a span's rect: an inline span reports the font's
        // content box, which is taller than the line box and reads ~1px low.
        const font = parseFloat(getComputedStyle(lab).fontSize);
        const dot = getComputedStyle(b, '::before');
        const dotCentre = parseFloat(dot.top) + parseFloat(dot.height) / 2;
        if (Math.abs((lr.top + font / 2 - item.top) - dotCentre) > 0.6) misaligned++;
        if (b.classList.contains('is-stacked')) stacked++;
        let bk = b.nextElementSibling;
        while (bk && bk.classList.contains('awt-book')) {
          minYearGap = Math.min(minYearGap,
            bk.querySelector('.awt-book__body').getBoundingClientRect().top - lr.bottom);
          bk = bk.nextElementSibling;
        }
        const n = brks[i + 1];
        if (n && n.offsetTop === b.offsetTop) {
          minCaptionGap = Math.min(minCaptionGap,
            n.querySelector('.awt-brk__label').getBoundingClientRect().left - lr.right);
        }
      });
      return { stacked, total: brks.length,
               minCaptionGap: minCaptionGap === Infinity ? null : minCaptionGap,
               minYearGap, misaligned };
    };

    for (const pct of [70, 100, 130]) {
      await page.evaluate((sl) => localStorage.setItem('awt-fav-workshops', JSON.stringify(sl)), oneEach);
      await page.evaluate((p) => localStorage.setItem('awt-shelf-size', String(p)), pct);
      await page.goto(`${BASE}/saved/`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.awt-book', { timeout: 8000 });
      await page.waitForTimeout(350);
      const r = await page.evaluate(probe);
      check(`captions never overlap each other at ${pct}%`,
        r.minCaptionGap === null || r.minCaptionGap >= 0, `${r.minCaptionGap}px`);
      // A stacked caption hangs its year into the slot the books stand in.
      check(`a stacked year never lands on a book at ${pct}%`, r.minYearGap >= 0, `${r.minYearGap}px`);
      check(`every caption's first line sits on its dot at ${pct}%`, r.misaligned === 0, `${r.misaligned} off`);
      check(`one-book groups stack at ${pct}%`, r.stacked > 0, `${r.stacked}/${r.total}`);
    }
    await page.evaluate(() => localStorage.removeItem('awt-shelf-size'));

    // Stacking is a last resort, not the default: a group with room keeps one line.
    if (roomy.length >= 3) {
      await page.evaluate((sl) => localStorage.setItem('awt-fav-workshops', JSON.stringify(sl)), roomy);
      await page.goto(`${BASE}/saved/`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.awt-book', { timeout: 8000 });
      check('a group with room keeps its caption on one line',
        (await page.$$eval('.awt-brk', (els) => els.every((e) => !e.classList.contains('is-stacked')))));
    }

    // Opening a book buys its row a whole cover's width, so that caption fits again.
    await page.evaluate((sl) => localStorage.setItem('awt-fav-workshops', JSON.stringify(sl)), oneEach);
    await page.goto(`${BASE}/saved/`, { waitUntil: 'networkidle' });
    // A break is a zero-width flex item, so it is never "visible" to Playwright.
    await page.waitForSelector('.awt-brk.is-stacked', { state: 'attached', timeout: 8000 });
    const spine = await page.$eval('.awt-brk.is-stacked + .awt-book .awt-face--spine', (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height * 0.6 };
    });
    await page.mouse.move(spine.x, spine.y);
    await page.waitForTimeout(700);
    check('opening a book un-stacks its own caption',
      await page.$eval('.awt-book.is-open', (bk) => {
        let p = bk.previousElementSibling;
        while (p && !p.classList.contains('awt-brk')) p = p.previousElementSibling;
        return !!p && !p.classList.contains('is-stacked');
      }));
    await page.mouse.move(4, 4);
    await page.waitForTimeout(700);
    check('closing it stacks the caption again', (await page.$('.awt-brk.is-stacked')) !== null);
    await page.evaluate(() => localStorage.clear());
  }

  await page.evaluate(() => localStorage.clear());
  await page.goto(`${BASE}/saved/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.awt-book', { timeout: 8000 }); // opens itself
  const bookW = () => page.$eval('.awt-book', (el) => el.offsetWidth);
  const wideBooks = await bookW();
  await page.$eval('#savedArcSize', (el) => {
    el.value = '70';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(250);
  check('the size slider makes the books smaller', (await bookW()) < wideBooks, `${wideBooks} -> ${await bookW()}`);
  // The renderer reads --awt-cover-w back with parseFloat, so it has to stay a
  // real length; a calc() there resolves to NaN and collapses every cover to 0.
  check('the cover width stays a resolved pixel length',
    /^\d+px$/.test((await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--awt-cover-w'))).trim()));
  const smallBooks = await bookW();
  await page.goto(`${BASE}/saved/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.awt-book', { timeout: 8000 });
  check('the size survives a reload', (await page.$eval('#savedArcSize', (el) => el.value)) === '70');
  check('and is applied before the shelf is measured', Math.abs((await bookW()) - smallBooks) <= 1);
  // Storage is a text field anyone can edit; an unusable value must not size
  // the shelf to nothing.
  await page.evaluate(() => localStorage.setItem('awt-shelf-size', '99999'));
  await page.goto(`${BASE}/saved/`, { waitUntil: 'networkidle' });
  check('an out-of-range stored size falls back', (await page.$eval('#savedArcSize', (el) => el.value)) === '100');
  await page.evaluate(() => localStorage.removeItem('awt-shelf-size'));

  await page.evaluate(() => localStorage.clear());
}

// --- /tools/ ---------------------------------------------------------------
// The free-tool pages are static pages with client-side logic and, for the
// citation tools, live calls to the DOI registries. Every registry call is
// stubbed here so the suite never depends on the network; what is checked is
// the page's own behaviour: the registry-driven frame (title, H1, FAQ markup,
// light theme), each tool producing output from a paste, and the DOI finder
// and BibTeX generator turning a registry answer into what the page promises.
{
  console.log('— /tools/: index and frame —');
  const { TOOLS } = await import('../site/src/lib/tools.mjs');
  await page.goto(`${BASE}/tools/`, { waitUntil: 'networkidle' });
  const cards = await page.$$eval('a.tool-card[data-tool]', (els) => els.map((e) => {
    const tile = e.querySelector('.tool-glyph');
    const path = tile?.querySelector('svg[viewBox] path');
    return {
      href: e.getAttribute('href'), slug: e.dataset.tool, hidden: tile?.getAttribute('aria-hidden'),
      icon: !!path, tileText: tile?.textContent.trim(),
      // Inline SVG painted in currentColor: the path's computed fill is the
      // tile's colour, which is how the dark theme reaches the icon.
      themed: !!path && getComputedStyle(path).fill === getComputedStyle(tile).color,
      blurb: e.querySelector('p')?.textContent.trim(),
    };
  }));
  check(`the index links every registered tool exactly once (${TOOLS.length})`, cards.length === TOOLS.length && TOOLS.every((t) => cards.some((c) => c.href.endsWith(`/tools/${t.slug}/`))), cards.map((c) => c.href).join(' '));
  // A card is the tool's icon (decorative, in the tile's colour), its name
  // and its one-line blurb, not the page's lede.
  const off = cards.filter((c) => { const t = TOOLS.find((x) => x.slug === c.slug); return !t || !c.icon || !c.themed || c.tileText !== '' || c.hidden !== 'true' || c.blurb !== t.blurb; });
  check('every card shows its icon in the tile colour, hidden from screen readers, and its blurb', off.length === 0, JSON.stringify(off.slice(0, 2)));
  check('the header has a Tools entry, current on the index', (await page.$eval('.site-nav a[href$="/tools/"]', (a) => a.getAttribute('aria-current'))) === 'page');
  check('the index renders light unless the visitor chose otherwise', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light');

  const t0 = TOOLS.find((t) => t.slug === 'doi-finder');
  await page.goto(`${BASE}/tools/doi-finder/`, { waitUntil: 'networkidle' });
  check('a tool page carries its registry title and H1', (await page.title()) === t0.title && (await page.$eval('h1', (h) => h.textContent.trim())) === t0.h1);
  const ld = await page.$$eval('script[type="application/ld+json"]', (els) => els.map((e) => JSON.parse(e.textContent)['@type']));
  check('FAQPage, BreadcrumbList and WebApplication JSON-LD are present', ['FAQPage', 'BreadcrumbList', 'WebApplication'].every((k) => ld.includes(k)), ld.join(','));
  check('every FAQ question is visible on the page', (await page.$$eval('.tool-faq-item h3', (els) => els.map((e) => e.textContent.trim()))).join('|') === t0.faqs.map((f) => f.q).join('|'));
  check('the Tools nav entry stays current on a tool page', (await page.$eval('.site-nav a[href$="/tools/"]', (a) => a.getAttribute('aria-current'))) === 'page');
  await page.evaluate(() => localStorage.setItem('theme', 'dark'));
  await page.reload({ waitUntil: 'networkidle' });
  check('an explicit dark choice still wins on a tool page', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
  await page.evaluate(() => localStorage.removeItem('theme'));

  console.log('— /tools/: DOI finder and BibTeX generator (registries stubbed) —');
  const work = {
    DOI: '10.1038/nature14539', type: 'journal-article', title: ['Deep learning'],
    author: [{ given: 'Yann', family: 'LeCun' }, { given: 'Yoshua', family: 'Bengio' }, { given: 'Geoffrey', family: 'Hinton' }],
    'container-title': ['Nature'], volume: '521', issue: '7553', page: '436-444', issued: { 'date-parts': [[2015, 5, 27]] }, publisher: 'Springer', score: 90,
  };
  await page.route('https://api.crossref.org/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ message: { items: [work] } }) }));
  await page.route('https://api.datacite.org/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ data: [] }) }));
  await page.route('https://doi.org/**', (r) => r.fulfill({ status: 200, contentType: 'application/vnd.citationstyles.csl+json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ...work, type: 'article-journal', title: 'Deep learning', 'container-title': 'Nature' }) }));
  await page.goto(`${BASE}/tools/doi-finder/`, { waitUntil: 'networkidle' });
  await page.fill('#toolInput', 'deep learning lecun');
  await page.click('#toolGo');
  await page.waitForSelector('#toolList li', { timeout: 8000 });
  check('the finder shows the DOI and a Cite link into the generator', await page.$eval('#toolList li', (li) => li.querySelector('code').textContent === '10.1038/nature14539' && li.querySelector('a.btn[href*="bibtex-citation-generator/?q=10.1038"]') !== null));
  await page.goto(`${BASE}/tools/bibtex-citation-generator/?q=10.1038%2Fnature14539`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#toolBib')?.textContent.includes('@article'), null, { timeout: 8000 });
  const bib = await page.$eval('#toolBib', (el) => el.textContent);
  check('a ?q= DOI is resolved into BibTeX with a derived key', bib.startsWith('@article{lecun2015deep,') && bib.includes('journal      = {Nature}') && bib.includes('pages        = {436--444}'), bib.slice(0, 120));
  check('the four styles are shown under the entry', (await page.$$eval('#toolStyles dt', (els) => els.map((e) => e.textContent))).join(',') === 'APA,MLA,IEEE,ACM');
  await page.goto(`${BASE}/tools/bibtex-to-apa/`, { waitUntil: 'networkidle' });
  await page.fill('#toolInput', '@inproceedings{v, title={Attention is all you need}, author={Vaswani, Ashish and Shazeer, Noam}, booktitle={NeurIPS}, year={2017}}');
  await page.click('#toolGo');
  await page.waitForSelector('#toolList li', { timeout: 8000 });
  check('BibTeX pasted into the APA page formats as APA 7', (await page.$eval('#toolList li', (li) => li.textContent.trim())) === 'Vaswani, A., & Shazeer, N. (2017). Attention is all you need. In NeurIPS.');
  await page.unroute('https://api.crossref.org/**');
  await page.unroute('https://api.datacite.org/**');
  await page.unroute('https://doi.org/**');

  console.log('— /tools/: LaTeX tools and AoE —');
  // Every tool that converts as you type goes back to its arrival state when
  // the box is emptied: nothing a run wrote survives, whether an output
  // block, the status line, or the LaTeX preview's colour and size. The
  // LaTeX placeholder once kept the last equation's 24 px and its picked
  // colour, because both were inline styles on the preview box, which
  // outlives every render, and an inline style beats the placeholder's class
  // rule; and a "LaTeX error" line outlived the expression it was about.
  const toolState = () => page.evaluate(() => {
    const st = document.querySelector('#toolStatus');
    const pv = document.querySelector('#toolPreview');
    const cs = pv && getComputedStyle(pv);
    return JSON.stringify({
      status: st && [st.textContent, st.className],
      out: [...document.querySelectorAll('.tool-out')].map((o) => [o.hidden, o.hidden ? '' : o.textContent.trim()]),
      preview: pv && [pv.textContent.trim(), pv.className, cs.color, cs.fontSize, pv.querySelector('svg') !== null],
    });
  });
  // Empties the box and waits for the debounced run to act on it; the empty
  // branch is synchronous, so its first visible effect means all of it ran.
  const backToArrival = async (slug, arrived) => {
    await page.fill('#toolInput', '');
    await page.waitForFunction(() => document.querySelector('#toolOut')?.hidden || document.querySelector('#toolPreview')?.classList.contains('is-empty'), null, { timeout: 5000 });
    const now = await toolState();
    check(`${slug}: emptying the box puts the page back as it arrived`, now === arrived, now);
  };
  await page.goto(`${BASE}/tools/excel-to-latex/`, { waitUntil: 'networkidle' });
  const arrivedExcel = await toolState();
  await page.fill('#toolInput', 'Model,Acc\nBERT,92.1\nGPT,95.0');
  await page.waitForFunction(() => document.querySelector('#toolResult')?.textContent.includes('tabular'), null, { timeout: 5000 });
  check('CSV becomes a booktabs table with numbers right-aligned', (await page.$eval('#toolResult', (el) => el.textContent)).includes('\\begin{tabular}{lr}\n    \\toprule\n    Model & Acc \\\\'));
  await backToArrival('excel-to-latex', arrivedExcel);
  await page.goto(`${BASE}/tools/markdown-to-latex/`, { waitUntil: 'networkidle' });
  const arrivedMarkdown = await toolState();
  await page.fill('#toolInput', '# Intro\n\nSome **bold** text with 5% and x_1.');
  await page.waitForFunction(() => document.querySelector('#toolResult')?.textContent.includes('section'), null, { timeout: 5000 });
  check('Markdown becomes escaped LaTeX', (await page.$eval('#toolResult', (el) => el.textContent)) === '\\section{Intro}\n\nSome \\textbf{bold} text with 5\\% and x\\_1.');
  await backToArrival('markdown-to-latex', arrivedMarkdown);
  await page.goto(`${BASE}/tools/latex-word-count/`, { waitUntil: 'networkidle' });
  const arrivedCount = await toolState();
  await page.fill('#toolInput', '\\section{Intro}\nFour words are here \\cite{x}. $y$');
  await page.waitForSelector('#toolStats .tool-stat', { timeout: 5000 });
  check('the word counter reports text words, headers and math separately', (await page.$$eval('#toolStats .tool-stat b', (els) => els.map((e) => e.textContent))).slice(0, 2).join(',') === '4,1');
  await backToArrival('latex-word-count', arrivedCount);
  // A render that finishes after the box was emptied does not show. The
  // renderer arrives on first use, so on a cold page the first render waits
  // for the bundle; the box can be emptied in that time, and the empty branch
  // is synchronous, so the equation for text no longer in the box used to
  // land on top of the placeholder. The bundle is held here until the box has
  // been emptied. The values are set without input events and the form
  // submitted, which calls render() at once: no debounce timer to outwait, so
  // the order of the two renders is certain.
  let releaseBundle;
  const bundleHeld = new Promise((r) => { releaseBundle = r; });
  await page.route('**/vendor/mathjax/tex-svg.js', async (route) => { await bundleHeld; await route.continue(); });
  await page.goto(`${BASE}/tools/latex-to-png/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#toolPreview')?.textContent === 'Type some LaTeX above.', null, { timeout: 5000 });
  const arrivedLatex = await toolState();
  // The box starts empty with the sample as a placeholder, and the 686 KB bundle
  // is not fetched until the tool is used — so the test has to type. Asserting
  // nothing is fetched on an idle visit is what keeps that true.
  check('the renderer is not fetched on an idle visit',
    (await page.$$eval('script[src]', (els) => els.map((e) => e.src).filter((u) => u.includes('/vendor/mathjax/')))).length === 0);
  const bundleRequested = page.waitForRequest((r) => r.url().includes('/vendor/mathjax/tex-svg.js'), { timeout: 8000 });
  await page.evaluate(() => { document.querySelector('#toolInput').value = 'x'; document.querySelector('#toolForm').requestSubmit(); });
  await bundleRequested;
  await page.evaluate(() => { document.querySelector('#toolInput').value = ''; document.querySelector('#toolForm').requestSubmit(); });
  releaseBundle();
  await page.waitForFunction(() => typeof window.MathJax?.tex2svgPromise === 'function', null, { timeout: 25000 });
  // The stale render resumes once the renderer is up. A conversion of the
  // suite's own, queued behind it, and a moment for it to have appended.
  await page.evaluate(async () => { await window.MathJax.startup.promise; await window.MathJax.tex2svgPromise('x'); });
  await page.waitForTimeout(500);
  check('a render that finishes after the box was emptied does not show', await page.$eval('#toolPreview', (el) => el.classList.contains('is-empty') && el.querySelector('svg') === null && el.textContent === 'Type some LaTeX above.'), await page.$eval('#toolPreview', (el) => `${el.className} / ${el.textContent.trim().slice(0, 30)} / svg:${el.querySelector('svg') !== null}`));
  await page.unroute('**/vendor/mathjax/tex-svg.js');
  await page.type('#toolInput', 'e^{i\\pi}+1=0', { delay: 10 });
  // The render of the whole expression at a size: its last glyph, the "0",
  // in an SVG whose font is that size. On a slow runner the typing pauses
  // long enough for a partial expression to render, and "e^{i\p" renders as
  // an error box, so the first SVG to appear is not always the equation.
  const settledAt = (px) => page.waitForFunction((want) => { const s = document.querySelector('#toolPreview svg'); return !!s && getComputedStyle(s).fontSize === want && !!s.querySelector('[data-c="30"]'); }, `${px}px`, { timeout: 25000 });
  await settledAt(24);
  check('MathJax renders a typed equation from the vendored bundle', await page.$eval('#toolPreview svg', (svg) => svg.querySelector('defs path') !== null));
  // The assistive MathML copy MathJax adds for screen readers is hidden only by
  // a stylesheet a full typeset injects; a convert-only page showed it as a
  // second, native rendering under the SVG.
  check('the preview shows the equation once (no assistive MathML copy)', (await page.$$eval('#toolPreview svg, #toolPreview mjx-assistive-mml, #toolPreview math', (els) => els.map((e) => e.tagName.toLowerCase()).join(','))) === 'svg');
  // The size and colour are set on the equation's own container, not on the
  // preview box (the placeholder checks below say why); MathJax sizes the
  // SVG in `ex`, resolved from that container's font, so the picked size
  // has to reach the drawing from there.
  const svgWidth = () => page.$eval('#toolPreview svg', (s) => s.getBoundingClientRect().width);
  const widthAt24 = await svgWidth();
  await page.selectOption('#optSize', '48');
  await settledAt(48);
  const widthAt48 = await svgWidth();
  // Not "exactly twice": `ex` is the font's x-height, which Linux grid-fits
  // at each size, so the Linux runner draws 48 px 1.86 times as wide as
  // 24 px where a Mac draws 1.99. settledAt has already seen the SVG's font
  // at the picked size; a drawing the size never reached would not grow.
  check('the picked font size reaches the drawing (48 px draws it about twice as wide as 24 px)', widthAt48 / widthAt24 > 1.6 && widthAt48 / widthAt24 < 2.4, `${widthAt24} -> ${widthAt48}`);
  await page.selectOption('#optSize', '24');
  await settledAt(24);
  // The buttons save a file rather than opening the image as a page (the
  // site's link handler once sent the host-less blob: URL to a new tab), and
  // the PNG can go to the clipboard as an image.
  const [pngDl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.click('#dlPng')]);
  check('Download PNG saves equation.png', pngDl.suggestedFilename() === 'equation.png', pngDl.suggestedFilename());
  const [svgDl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.click('#dlSvg')]);
  check('Download SVG saves equation.svg', svgDl.suggestedFilename() === 'equation.svg', svgDl.suggestedFilename());
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin });
  await page.click('#copyPng');
  await page.waitForFunction(() => /Copied|Copy failed/.test(document.querySelector('#copyPng')?.textContent || ''), null, { timeout: 8000 });
  check('Copy PNG puts an image on the clipboard', (await page.$eval('#copyPng', (b) => b.textContent)) === 'Copied' && (await page.evaluate(async () => (await navigator.clipboard.read()).some((item) => item.types.includes('image/png')))));
  // The picked colour reaches the files. MathJax fills with `currentColor`,
  // which resolved to black in a standalone SVG (and so in every PNG drawn
  // from it) until the exporter set `color` on the root element.
  await page.fill('#optColor', '#ff0000');
  await page.waitForFunction(() => { const s = document.querySelector('#toolPreview svg'); return !!s && getComputedStyle(s).color === 'rgb(255, 0, 0)'; }, null, { timeout: 5000 });
  const [redSvgDl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.click('#dlSvg')]);
  const redSvg = readFileSync(await redSvgDl.path(), 'utf8');
  check('the downloaded SVG carries the picked colour as its own default', /<svg[^>]* color="#ff0000"/.test(redSvg) && redSvg.includes('fill="currentColor"'), redSvg.slice(0, 300));
  // The button flashes "Copied" for 1.4 s after the first copy; wait for it
  // to reset so the second "Copied" is this click's, not a stale label.
  await page.waitForFunction(() => document.querySelector('#copyPng')?.textContent === 'Copy PNG', null, { timeout: 8000 });
  await page.click('#copyPng');
  await page.waitForFunction(() => document.querySelector('#copyPng')?.textContent === 'Copied', null, { timeout: 8000 });
  const pngColour = await page.evaluate(async () => {
    const item = (await navigator.clipboard.read()).find((i) => i.types.includes('image/png'));
    const bmp = await createImageBitmap(await item.getType('image/png'));
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width; canvas.height = bmp.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] === 255) seen.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
    return [...seen];
  });
  check('the copied PNG is drawn in the picked colour, not black', pngColour.length > 0 && pngColour.every((c) => c === '255,0,0'), pngColour.slice(0, 5).join(' | '));
  // The report that found the leak: an equation rendered, the colour changed,
  // the box emptied, and the placeholder came back red at 24 px.
  await backToArrival('latex-to-png', arrivedLatex);
  // An error line goes the same way: "\frac{" leaves "LaTeX error: Missing
  // close brace" under the buttons, about an expression that is then gone.
  await page.fill('#toolInput', '\\frac{');
  await page.waitForFunction(() => document.querySelector('#toolStatus')?.classList.contains('is-error'), null, { timeout: 8000 });
  await backToArrival('latex-to-png after a LaTeX error', arrivedLatex);
  await page.goto(`${BASE}/tools/aoe-time/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => /^\d\d:\d\d:\d\d$/.test(document.querySelector('#aoeClockTime')?.textContent || ''), null, { timeout: 5000 });
  const aoe = await page.evaluate(() => {
    const now = new Date(Date.now() - 12 * 3600 * 1000);
    return { shown: document.querySelector('#aoeClockTime').textContent.slice(0, 5), want: `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}` };
  });
  check('the AoE clock is UTC minus twelve hours', aoe.shown === aoe.want, `${aoe.shown} vs ${aoe.want}`);
  check('the converter rendered a default result and the open-call table has rows', (await page.$$eval('#aoeTable tbody tr', (els) => els.length)) >= 10 && (await page.$$eval('#aoeCalls tbody tr', (els) => els.length)) >= 1);
  // The open-calls table's instants: every column spelled one way (Intl's
  // en-GB once wrote "Sept" and a comma beside the page's own "Sep"), and at
  // a desktop width a cell never breaks: the Left column showed "6h" over
  // "25m" and the AoE column "Fri 11 Sep 2026 12:00" over a lone "AoE". On a
  // phone a cell may break once, between the date and the time, never inside
  // either piece.
  const WHEN = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d\d:\d\d( AoE)?$/;
  const callRows = () => page.$$eval('#aoeCalls tbody tr', (rows) => rows.map((r) => {
    const lines = (el) => { const rg = document.createRange(); rg.selectNodeContents(el); return new Set([...rg.getClientRects()].map((b) => Math.round(b.top))).size; };
    return {
      when: [...r.querySelectorAll('td.when')].map((td) => ({ text: td.textContent.replace(/\s+/g, ' ').trim(), lines: lines(td), pieces: [...td.querySelectorAll('span')].map(lines) })),
      left: { text: r.lastElementChild.textContent.trim(), lines: lines(r.lastElementChild) },
    };
  }));
  let callRowsSeen = await callRows();
  check('every deadline and local time in the table is spelled the same way', callRowsSeen.length > 0 && callRowsSeen.every((r) => r.when.length === 2 && r.when.every((w) => WHEN.test(w.text))), JSON.stringify(callRowsSeen[0]?.when));
  check('at desktop width no instant and no countdown wraps', callRowsSeen.every((r) => r.when.every((w) => w.lines === 1) && r.left.lines === 1), JSON.stringify(callRowsSeen.find((r) => r.when.some((w) => w.lines !== 1) || r.left.lines !== 1)));
  await page.setViewportSize({ width: 390, height: 800 });
  callRowsSeen = await callRows();
  check('on a phone a cell breaks only between the date and the time', callRowsSeen.every((r) => r.when.every((w) => w.pieces.length === 2 && w.pieces.every((n) => n === 1)) && r.left.lines === 1), JSON.stringify(callRowsSeen[0]));
  // Four columns of instants cannot fit a phone however they wrap, and a table
  // that scrolls sideways hides "Your time": the rows stack into labelled
  // lines instead, and the table stays inside the screen.
  const phone = await page.evaluate(() => {
    const t = document.querySelector('#aoeCalls');
    const tds = [...t.querySelectorAll('tbody tr:first-child td')];
    return {
      fits: t.scrollWidth <= document.documentElement.clientWidth,
      headerGone: getComputedStyle(t.querySelector('thead')).display === 'none',
      stacked: tds.length === 4 && tds.every((td, i) => i === 0 || td.getBoundingClientRect().top > tds[i - 1].getBoundingClientRect().bottom - 1),
      labels: tds.slice(1).map((td) => getComputedStyle(td, '::before').content),
    };
  });
  check('on a phone the open-calls table stacks its rows and fits the screen', phone.fits && phone.headerGone && phone.stacked && phone.labels.join() === '"Deadline","Your time","Left"', JSON.stringify(phone));
  await page.setViewportSize({ width: 1280, height: 900 });
}

// --- conference hub and year pages: the main conference ---------------------
// Which pages to look at comes from the data itself (data/editions.yml and
// data/acceptance_rates.yml, kept current by the daily editions sync), so the
// checks hold whichever conference's call happens to be open on the day.
{
  console.log('— conference pages: main-conference deadline, dates and acceptance rate —');
  const eds = loadEditions();
  const withDeadline = eds.filter((e) => e.paper_deadline).sort((a, b) => b.year - a.year)[0];
  if (withDeadline) {
    await page.goto(`${BASE}/conference/${withDeadline.conference}/${withDeadline.year}/`, { waitUntil: 'networkidle' });
    check('a year page with a main-conference deadline says so in its H1', /deadline, dates and workshops$/i.test(await page.$eval('h1', (h) => h.textContent.trim())), await page.$eval('h1', (h) => h.textContent.trim()));
    check('… and in its title', /Deadline, Dates & Workshops/.test(await page.title()), await page.title());
    check('… with a key-dates block naming the paper deadline', (await page.$eval('.conf-dates', (el) => el.textContent)).includes('Paper deadline'));
    check('… converted to the reader\'s local time', (await page.$$eval('.conf-dates .js-local[data-local-done]', (els) => els.filter((e) => /Your time/.test(e.textContent)).length)) >= 1);
    const ld = await page.$$eval('script[type="application/ld+json"]', (els) => els.map((e) => JSON.parse(e.textContent)));
    check('… and a FAQ entry for the deadline in the JSON-LD', ld.some((d) => d['@type'] === 'FAQPage' && d.mainEntity.some((q) => /paper submission deadline\?$/.test(q.name))));
  }
  const rates = loadAcceptanceRates();
  const byConf = new Map();
  for (const r of rates) byConf.set(r.conference, (byConf.get(r.conference) ?? 0) + 1);
  const ratedConf = [...byConf.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (ratedConf) {
    const n = Math.min(12, byConf.get(ratedConf));
    await page.goto(`${BASE}/conference/${ratedConf}/`, { waitUntil: 'networkidle' });
    check('the hub title carries the acceptance-rate query', /Acceptance Rate/.test(await page.title()), await page.title());
    check(`the hub tabulates the ${n} most recent acceptance rates`, (await page.$$eval('.rate-table tbody tr', (els) => els.length)) === n);
    check('the hub headlines a main-conference edition with a link to its year page', (await page.$('.conf-main a[href*="/conference/"]')) !== null);
  }
  // The cross-conference page: one row per headlined edition, open calls first.
  await page.goto(`${BASE}/conference/`, { waitUntil: 'networkidle' });
  check('the AI conference deadlines page carries its query in title and H1', /^AI Conference Deadlines/.test(await page.title()) && (await page.$eval('h1', (h) => h.textContent.trim())) === 'AI conference deadlines', await page.title());
  const dlRows = await page.$$eval('.dl-table tbody tr', (trs) => trs.map((tr) => ({ open: tr.classList.contains('is-open'), counting: /\d+[dhm]/.test(tr.querySelector('.countdown')?.textContent || ''), local: /Your time/.test(tr.querySelector('.js-local')?.textContent || '') })));
  const anyOpen = eds.some((e) => e.paper_deadline && resolveDeadlineUtcMs(String(e.paper_deadline), e.timezone || 'AoE') > Date.now());
  check(`it lists one row per conference with tracker data (${dlRows.length})`, dlRows.length >= 5 && dlRows.length <= expectedConfs, String(dlRows.length));
  check('open calls come first, each with a ticking countdown', dlRows.every((r, i) => !r.open || (r.counting && dlRows.slice(0, i).every((p) => p.open))) && (!anyOpen || dlRows[0].open));
  check('deadlines are converted to the reader\'s local time', dlRows.filter((r) => r.local).length >= dlRows.filter((r) => r.open).length && dlRows.some((r) => r.local));
  check('the footer links the page from every page', (await page.$('.footer-confs a[href$="/conference/"]')) !== null);
  // An edition the trackers know but no workshop does yet still has a page.
  const wsYears = new Set(apiTop.map((w) => `${w.conference}-${w.year}`));
  const only = eds.find((e) => e.paper_deadline && !wsYears.has(`${e.conference}-${e.year}`));
  if (only) {
    const res = await page.goto(`${BASE}/conference/${only.conference}/${only.year}/`, { waitUntil: 'networkidle' });
    check('an edition-only year page exists and says its workshops are not announced yet', res.status() === 200 && (await page.textContent('body')).includes('not been announced yet'));
  }
}

check('no page/console errors during the whole run', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
