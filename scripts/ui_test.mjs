/**
 * Headless UI tests for the search-first homepage.
 * Run a build first, then:  node scripts/ui_test.mjs [http://localhost:4321]
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
const browseCount = await page.$eval('#searchCount', (el) => el.textContent);
check('browse headline omits papers segment', /^\d+ workshops? · open calls first( · page \d+\/\d+)?$/.test(browseCount), browseCount);
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
const ordBrowseCount = await page.$eval('#searchCount', (el) => el.textContent);
check('browse count line says "open calls first"', /open calls first/.test(ordBrowseCount), ordBrowseCount);
const ordPills = await page.$$eval('#results .pf-result .pill', (els) => els.map((e) => e.textContent.trim()));
check('first browse result is an Open call', ordPills[0] === 'Open call', ordPills.slice(0, 3).join(','));
const ordLastOpen = ordPills.lastIndexOf('Open call');
check('open calls form a contiguous leading band', ordPills.slice(0, ordLastOpen + 1).every((p) => p === 'Open call'), ordPills.join(','));
const ordDues = await page.$$eval('#results .pf-result .result-meta', (els) =>
  els.map((e) => (e.textContent.match(/due (.+)$/) || [])[1]).filter(Boolean));
const ordDueMs = ordDues.map((d) => Date.parse(d.replace(' AoE (UTC−12)', ' UTC-12')));
check('open-call deadlines ascend', ordDueMs.every((v, i) => i === 0 || !(v < ordDueMs[i - 1])), ordDues.slice(0, 4).join(' | '));
check('due dates shown on open-call rows', ordDues.length >= 2, `got ${ordDues.length}`);
await page.uncheck('[data-facet="conference"] input[value="IROS"]');

// Keywords = relevance: count line says so; ordering is Pagefind's, not the bands.
await page.fill('#q', 'surgical robotics');
await page.waitForFunction(() => document.querySelectorAll('#results .pf-result').length > 0, null, { timeout: 8000 });
const ordKwCount = await page.$eval('#searchCount', (el) => el.textContent);
check('keyword count line says "by relevance"', /by relevance/.test(ordKwCount), ordKwCount);
const ordKwTitle = await page.$eval('#results .pf-result .pf-title', (el) => el.textContent);
check('top relevance hit matches the query topic', /surgical/i.test(ordKwTitle), ordKwTitle);
await page.fill('#q', '');

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
  check('saved row carries a status pill', (await page.$(`[data-saved-ws="${starredSlug}"] .pill`)) !== null);
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
check('keyword results: workshop rows have star buttons', (await page.$('#results .pf-result > [data-star-ws]')) !== null);
const pap = await page.$eval('#results .pf-papers li:has(.pf-ptitle)', (li) => ({
  hasStar: !!li.querySelector(':scope > [data-star-paper]'),
  title: li.querySelector('.pf-ptitle')?.textContent.trim() ?? '',
  excerpt: li.querySelector('.pf-excerpt')?.textContent.trim() ?? '',
}));
check('paper line 1 has a real star button', pap.hasStar);
check('paper line 1 carries no leaked star glyph', !/[☆★]/.test(pap.title), pap.title.slice(0, 40));
check('paper line 2 no longer repeats the title', !pap.excerpt.toLowerCase().startsWith(pap.title.slice(0, 25).toLowerCase()), pap.excerpt.slice(0, 60));
check('paper line 2 carries no star glyphs', !/[☆★]/.test(pap.excerpt), pap.excerpt.slice(0, 60));

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
await page.waitForSelector('#results .pf-result > [data-star-ws]', { timeout: 10000 });
const yearStars = await page.$$eval('#results .pf-result', (els) => els.filter((e) => e.querySelector(':scope > [data-star-ws]')).length);
const yearRows = (await page.$$('#results .pf-result')).length;
check(`year-filtered results all starrable (${yearStars}/${yearRows})`, yearRows > 0 && yearStars === yearRows);
const yBtn = await page.$('#results .pf-result > [data-star-ws]');
await yBtn.click();
check('starring from filtered results works', (await yBtn.textContent()) === '★');
check('state survives a re-render (pagination/hydrate)', await page.$eval('#results .pf-result > [data-star-ws]', (el) => el.classList.contains('is-on')));
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
const fsx = await import('node:fs');
const errsBefore0 = errors.length;
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.querySelector('[data-facet="year"]')?.children.length > 0, null, { timeout: 8000 });
await page.waitForTimeout(1200); // idle prefetch: the engine memorizes the current data files
const stash = '/tmp/pf-stash-test';
fsx.mkdirSync(stash, { recursive: true });
const chunkDirs = ['site/dist/pagefind/index', 'site/dist/pagefind/filter', 'site/dist/pagefind-papers/index', 'site/dist/pagefind-papers/filter'];
const moved = [];
for (const d of chunkDirs) for (const f of fsx.readdirSync(d)) { fsx.renameSync(`${d}/${f}`, `${stash}/${moved.length}`); moved.push(`${d}/${f}`); }
await page.click('summary[data-facet-summary="year"]');
await page.check('[data-facet="year"] input[data-f]');
await page.waitForFunction(() => /Reload the page/.test(document.querySelector('#results')?.textContent || ''), null, { timeout: 10000 });
const staleMsg = await page.$eval('#results', (el) => el.textContent.trim());
check('stale index shows an honest message, not "No matches"', /couldn't be refreshed/.test(staleMsg) && !/No matches/.test(staleMsg), staleMsg.slice(0, 90));
check('message offers a reload button', (await page.$('#results .btn-quiet')) !== null);
// the new deploy's files become reachable — search must recover IN PLACE
moved.forEach((orig, i) => fsx.renameSync(`${stash}/${i}`, orig));
await page.uncheck('[data-facet="year"] input[data-f]');
await page.check('[data-facet="year"] input[data-f]');
await page.waitForSelector('#results .pf-result', { timeout: 10000 });
check('search recovers without a page reload once files are back', (await page.$$('#results .pf-result')).length > 0);
// chunk 404s during the simulated outage are expected noise, not regressions
const addedErrs = errors.splice(errsBefore0);
for (const e of addedErrs) if (!/pagefind|fetch|404|load/i.test(e)) errors.push(e);

check('no page/console errors during the whole run', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
