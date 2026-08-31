#!/usr/bin/env node
/**
 * Tests for alerts/render.mjs — the four email templates.
 *
 * What these pin, and why each one matters more than it looks:
 *
 *   - **An empty digest renders null.** A weekly "nothing happened this week"
 *     email is precisely how a useful list turns into a muted one. The renderer
 *     returning null is what makes "empty weeks send nothing" true; a caller
 *     can't skip a subscriber it was never told to skip.
 *   - **Every bulk email carries an unsubscribe link in the body** (Gmail and
 *     Yahoo's bulk-sender rules require it alongside the RFC 8058 headers), and
 *     **every message has a plaintext part** — an HTML-only send is a spam
 *     signal on its own.
 *   - **The accuracy caveat is present**, because the whole dataset is
 *     "when we observed a value", never "when organizers changed it", and an
 *     email is the one surface a reader sees without the site's own framing.
 *   - **Section caps hold**, so a busy deadline week can't produce a 200-item
 *     wall of text.
 *   - **"And N more" links use display labels, not ids** — the site's URL
 *     facets are label-based (see index.astro), so an id-based link silently
 *     lands on an empty result page.
 *
 * Pure logic — no network. Run: node scripts/alerts_render_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderDigest,
  renderUrgent,
  renderStarredChanges,
  fmtWhen,
  renderConfirm,
  renderMagic,
  facetUrl,
  fmtUtc,
  hoursUntil,
  UNSUB_PLACEHOLDER,
  MANAGE_PLACEHOLDER,
  FOOTER_CAVEAT,
  fmtRelative,
} from '../alerts/render.mjs';
import { SECTION_CAP } from '../alerts/config.mjs';
import { normalizeSubscriber } from '../alerts/match.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ids = JSON.parse(fs.readFileSync(path.join(ROOT, 'alerts', 'ids.json'), 'utf8'));

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}

const NOW = Date.parse('2026-08-14T00:00:00Z');
const iso = (days, h = 12) => new Date(NOW + days * 86_400_000 + h * 3_600_000).toISOString();

const ws = (slug, over = {}) => ({
  slug,
  // Deliberately does NOT embed the acronym: a name that contains it makes
  // displayAcronym suppress the acronym (correctly), which would mean these
  // fixtures silently stopped exercising the acronym path at all.
  name: 'Workshop on Applied Machine Learning',
  acronym: slug.split('-').pop().toUpperCase(),
  conference: 'neurips',
  year: 2026,
  topics: ['llms'],
  status: 'upcoming',
  status_label: 'Open call',
  deadline_utc: null,
  abstract_deadline_utc: null,
  next_stage_utc: null,
  next_stage_is_abstract: false,
  website: 'https://example.com/ws',
  ...over,
});

const sub = (over = {}) =>
  normalizeSubscriber({ email: 'a@example.com', nonce: 'n', cadence: 'weekly', confirmed_at: 'x', ...over });

/* ------------------------------------------------------------- date helpers */
{
  check('fmtUtc renders an unambiguous UTC stamp',
    fmtUtc('2026-09-01T23:59:00.000Z') === '1 Sep 2026, 23:59 UTC', fmtUtc('2026-09-01T23:59:00.000Z'));
  check('fmtUtc tolerates garbage', fmtUtc('not-a-date') === '');
  check('hoursUntil floors', hoursUntil(iso(0, 5.9), NOW) === 5, String(hoursUntil(iso(0, 5.9), NOW)));
  check('hoursUntil never goes negative', hoursUntil(iso(-3), NOW) === 0);
}

/* ------------------------------------------------- empty digest -> skip (null) */
{
  const out = renderDigest({ sub: sub(), events: [], workshops: {}, nowMs: NOW, ids });
  check('a digest with nothing in any section renders null', out === null);

  // Events exist, but for a workshop that is no longer in the dataset, and
  // nothing is closing: still nothing honest to say.
  const orphan = renderDigest({
    sub: sub(),
    events: [{ slug: 'vanished', kind: 'extended', days: 2, new_utc: iso(20) }],
    workshops: {},
    nowMs: NOW,
    ids,
  });
  check('events with no matching workshop still render null', orphan === null);

  // A far-future deadline is not "closing this week" and must not resurrect it.
  const far = renderDigest({
    sub: sub(),
    events: [],
    workshops: { a: ws('a', { deadline_utc: iso(60), next_stage_utc: iso(60) }) },
    nowMs: NOW,
    ids,
  });
  check('a deadline 60 days out does not make a digest', far === null);
}

/* -------------------------------------------------------------- full digest */
{
  const workshops = {
    'neurips-2026-alpha': ws('neurips-2026-alpha', { deadline_utc: iso(30), next_stage_utc: iso(30) }),
    'neurips-2026-beta': ws('neurips-2026-beta', { deadline_utc: iso(3), next_stage_utc: iso(3) }),
    'neurips-2026-gamma': ws('neurips-2026-gamma', { deadline_utc: iso(2), next_stage_utc: iso(1), next_stage_is_abstract: true }),
    'cvpr-2026-old': ws('cvpr-2026-old', { conference: 'cvpr', status: 'past', deadline_utc: iso(-40) }),
  };
  const events = [
    { slug: 'neurips-2026-alpha', kind: 'extended', days: 5, old_utc: iso(25), new_utc: iso(30) },
    { slug: 'neurips-2026-beta', kind: 'deadline_announced', days: null, old_utc: null, new_utc: iso(3) },
    { slug: 'cvpr-2026-old', kind: 'announced', days: null, old_utc: null, new_utc: iso(-40) },
  ];
  const s = sub({ starred_ws: '["neurips-2026-gamma"]' });
  const out = renderDigest({ sub: s, events, workshops, nowMs: NOW, ids });

  check('a populated digest renders', !!out);
  // Two change events (an extension and a first-published deadline), and zero
  // *new* workshops that aren't already Past — so the "new workshops" clause is
  // dropped entirely rather than rendered as "0 new workshops".
  check('the subject counts changes and drops zero clauses',
    /^2 deadline changes in your areas — AI Workshop Tracker$/.test(out.subject), out.subject);
  check('an extension is described with its day count', /EXTENDED \+5d/.test(out.html));
  check('a newly published deadline is described', /DEADLINE POSTED/.test(out.html));
  check('a workshop announced but already Past is not listed as new',
    !/New this week/.test(out.html));
  check('items link to the workshop page',
    out.html.includes('https://aiworkshoptracker.com/workshop/neurips-2026-alpha/'));
  check('the saved-workshops section is present', /Your saved workshops/.test(out.html));
  check('a starred item is marked with a star', out.html.includes('★'));
  check('an abstract stage is labelled', /\(abstract\)/.test(out.html));
  check('the closing-soon section lists the imminent workshops',
    /Closing in the next 7 days/.test(out.html));

  // --- section order and the saved section's exemption from the cap --------
  // Order is the reader's priority: what they chose to follow, then what
  // changed, then what is new, then what is merely closing.
  // Its own fixture: the digest above deliberately has no *live* announced
  // workshop (the only one is Past), so all four sections never coexist there.
  const allFour = renderDigest({
    sub: sub({ starred_ws: '["neurips-2026-gamma"]' }),
    events: [
      { slug: 'neurips-2026-alpha', kind: 'extended', days: 5, old_utc: iso(25), new_utc: iso(30) },
      { slug: 'neurips-2026-delta', kind: 'announced', days: null, old_utc: null, new_utc: iso(40) },
    ],
    workshops: {
      ...workshops,
      'neurips-2026-delta': ws('neurips-2026-delta', { deadline_utc: iso(40), next_stage_utc: iso(40) }),
    },
    nowMs: NOW,
    ids,
  });
  const order = ['Your saved workshops', 'Deadline changes this week', 'New this week', 'Closing in the next 7 days']
    .map((h) => allFour.html.indexOf(h));
  check('sections render in reader-priority order',
    order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), JSON.stringify(order));
  check('the new-this-week section carries its subtitle',
    allFour.html.includes('workshops added to the tracker this week'));

  // --- badge parity -------------------------------------------------------
  // A chip visible only to HTML readers is a regression. Every badge that
  // reaches the html must reach the plaintext in the same words.
  const badgesIn = (t) => (t.match(/EXTENDED \+\d+d|EARLIER \u2212\d+d|DEADLINE POSTED|NEW|CLOSES TODAY/g) || []).sort();
  check('every badge in the html also appears in the plaintext',
    badgesIn(allFour.html), badgesIn(allFour.text));
  check('the plaintext brackets its badges', /\[EXTENDED \+\d+d\] /.test(allFour.text), true);
  check('badges carry no images', !/<img/i.test(allFour.html));

  // --- summary strip, grouping, footer stat --------------------------------
  const rich = renderDigest({
    sub: sub({ starred_ws: '["neurips-2026-gamma"]' }),
    events: [
      { slug: 'neurips-2026-alpha', kind: 'extended', days: 3, old_utc: iso(27), new_utc: iso(30) },
      { slug: 'neurips-2026-beta', kind: 'extended', days: 11, old_utc: iso(-8), new_utc: iso(3) },
      { slug: 'cvpr-2026-delta', kind: 'extended', days: 5, old_utc: iso(35), new_utc: iso(40) },
      { slug: 'neurips-2026-eps', kind: 'announced', days: null, old_utc: null, new_utc: iso(40) },
    ],
    workshops: {
      ...workshops,
      'cvpr-2026-delta': ws('cvpr-2026-delta', { conference: 'cvpr', deadline_utc: iso(40), next_stage_utc: iso(40) }),
      'neurips-2026-eps': ws('neurips-2026-eps', { deadline_utc: iso(40), next_stage_utc: iso(40) }),
    },
    nowMs: NOW, ids,
  });
  check('the summary strip counts changes and new workshops',
    /3 deadline changes · 1 new workshop/.test(rich.html), rich.html.slice(0, 0));
  check('the summary strip reaches the plaintext', rich.text.includes('3 deadline changes · 1 new workshop'));
  check('deadline changes are grouped by conference',
    rich.html.includes('>CVPR<') && rich.html.includes('>NeurIPS<'));
  check('conference groups are alphabetical',
    rich.html.indexOf('>CVPR<') < rich.html.indexOf('>NeurIPS<'));
  check('the group subheadings reach the plaintext',
    /\nCVPR\n/.test(rich.text) && /\nNeurIPS\n/.test(rich.text));

  // --- the digest applies the SAME rules as /changes/ ----------------------
  // Both surfaces render the same week; a row present in one and absent from
  // the other, or ordered differently, means a reader who gets the email and
  // clicks through sees two different accounts of the same seven days.
  const parity = renderDigest({
    sub: sub(),
    events: [
      // deadline already in the past when the window opened — must be dropped
      { slug: 'neurips-2026-stale', kind: 'extended', days: 2, old_utc: iso(-40), new_utc: iso(-30) },
      // three live ones, deliberately out of deadline order
      { slug: 'neurips-2026-c', kind: 'extended', days: 2, old_utc: iso(18), new_utc: iso(20) },
      { slug: 'neurips-2026-a', kind: 'extended', days: 2, old_utc: iso(3), new_utc: iso(5) },
      { slug: 'neurips-2026-b', kind: 'extended', days: 2, old_utc: iso(8), new_utc: iso(10) },
    ],
    workshops: {
      'neurips-2026-stale': ws('neurips-2026-stale', { deadline_utc: iso(-30), next_stage_utc: iso(-30) }),
      'neurips-2026-c': ws('neurips-2026-c', { deadline_utc: iso(20), next_stage_utc: iso(20) }),
      'neurips-2026-a': ws('neurips-2026-a', { deadline_utc: iso(5), next_stage_utc: iso(5) }),
      'neurips-2026-b': ws('neurips-2026-b', { deadline_utc: iso(10), next_stage_utc: iso(10) }),
    },
    nowMs: NOW, ids,
  });
  check('a deadline that passed before the window is not reported',
    !parity.html.includes('/workshop/neurips-2026-stale/'));
  const byDeadline = ['a', 'b', 'c'].map((k) => parity.html.indexOf(`/workshop/neurips-2026-${k}/`));
  check('changes are ordered by deadline, earliest first',
    byDeadline.every((at, i) => at >= 0 && (i === 0 || at > byDeadline[i - 1])), JSON.stringify(byDeadline));

  // Netting is shared with the page through lib/events.mjs: two hops, one row.
  const netted = renderDigest({
    sub: sub(),
    events: [
      { slug: 'neurips-2026-net', kind: 'extended', days: 6, old_utc: iso(2), new_utc: iso(8) },
      { slug: 'neurips-2026-net', kind: 'extended', days: 4, old_utc: iso(8), new_utc: iso(12) },
    ],
    workshops: { 'neurips-2026-net': ws('neurips-2026-net', { deadline_utc: iso(12), next_stage_utc: iso(12) }) },
    nowMs: NOW, ids,
  });
  check('two hops render as one row', (netted.html.match(/\/workshop\/neurips-2026-net\//g) || []).length === 1,
    String((netted.html.match(/\/workshop\/neurips-2026-net\//g) || []).length));
  check('and report the net, not the last hop', /EXTENDED \+10d/.test(netted.html));

  // The daily mail carries the same treatment as the weekly one.
  const urg = renderUrgent({
    sub: sub(), items: [ws('neurips-2026-soon', { deadline_utc: iso(0, 20), next_stage_utc: iso(0, 20) })],
    nowMs: NOW, ids,
  });
  check('an urgent alert badges its urgency', /CLOSES TODAY/.test(urg.html), '');
  check('and carries it in the plaintext too', urg.text.includes('[CLOSES TODAY]'));
  const twice = renderStarredChanges({
    sub: sub({ starred_ws: '["neurips-2026-alpha"]' }),
    events: [
      { slug: 'neurips-2026-alpha', kind: 'extended', days: 3, old_utc: iso(20), new_utc: iso(23) },
      { slug: 'neurips-2026-alpha', kind: 'extended', days: 2, old_utc: iso(23), new_utc: iso(25) },
    ],
    workshops, ids,
  });
  check('a saved-change alert reports one row per workshop',
    (twice.html.match(/\/workshop\/neurips-2026-alpha\//g) || []).length === 1);
  check('and nets the hops like the digest', /EXTENDED \+5d/.test(twice.html), '');
  // Median of 3, 5, 11 is 5 — a mean would be 6.3 and match no real extension.
  check('the footer states the median extension',
    /Median extension this week: 5 days\./.test(rich.html), '');
  check('the median reaches the plaintext', rich.text.includes('Median extension this week: 5 days.'));

  // A week with no extensions must omit the line, not print NaN or "0 days".
  const noExt = renderDigest({
    sub: sub(), events: [{ slug: 'neurips-2026-eps', kind: 'announced', days: null, old_utc: null, new_utc: iso(40) }],
    workshops: { ...workshops, 'neurips-2026-eps': ws('neurips-2026-eps', { deadline_utc: iso(40), next_stage_utc: iso(40) }) },
    nowMs: NOW, ids,
  });
  check('no extensions -> no median line at all', !/Median extension/.test(noExt.html));
  check('and certainly no NaN', !/NaN/.test(noExt.html) && !/NaN/.test(noExt.text));

  // "K of your saved close within 48h" — only when some actually do.
  const soon = renderDigest({
    sub: sub({ starred_ws: '["neurips-2026-soon"]' }),
    events: [],
    workshops: { 'neurips-2026-soon': ws('neurips-2026-soon', { deadline_utc: iso(1), next_stage_utc: iso(1) }) },
    nowMs: NOW, ids,
  });
  check('the strip counts saved workshops closing within 48h',
    /1 of your saved closes within 48h/.test(soon.html), '');
  const notSoon = renderDigest({
    sub: sub({ starred_ws: '["neurips-2026-far"]' }),
    events: [],
    workshops: { 'neurips-2026-far': ws('neurips-2026-far', { deadline_utc: iso(5), next_stage_utc: iso(5) }) },
    nowMs: NOW, ids,
  });
  check('a saved deadline beyond 48h is not counted as closing',
    !/of your saved close/.test(notSoon.html));

  // --- size: Gmail clips a message past ~102 KB ---------------------------
  // Clipping is silent and lands mid-digest, so the unsubscribe link and the
  // accuracy caveat — both required on every bulk message — are exactly what
  // disappears. The heaviest realistic digest is an all/all subscriber with a
  // long saved list, because that is the one section with no cap.
  const heavyWs = {};
  const heavyEvents = [];
  const heavySaved = [];
  for (let i = 0; i < 60; i++) {
    const slug = `neurips-2026-heavy${i}`;
    heavyWs[slug] = ws(slug, {
      name: 'A Workshop With A Deliberately Long Name About Foundation Models And Their Applications',
      deadline_utc: iso(1 + (i % 6)), next_stage_utc: iso(1 + (i % 6)),
    });
    heavySaved.push(slug);
    heavyEvents.push({ slug, kind: i % 2 ? 'extended' : 'announced', days: i % 2 ? 4 : null, old_utc: iso(i), new_utc: iso(1 + (i % 6)) });
  }
  const heavy = renderDigest({
    sub: sub({ starred_ws: JSON.stringify(heavySaved) }),
    events: heavyEvents, workshops: heavyWs, nowMs: NOW, ids,
  });
  const heavyBytes = Buffer.byteLength(heavy.html, 'utf8');
  check(`the heaviest digest stays well under Gmail's clip (${(heavyBytes / 1024).toFixed(1)} KB)`,
    heavyBytes < 70 * 1024, `${heavyBytes} bytes`);
  check('a same-day deadline is badged CLOSES TODAY',
    renderDigest({
      sub: sub({ starred_ws: '["neurips-2026-today"]' }),
      events: [],
      workshops: { 'neurips-2026-today': ws('neurips-2026-today', { deadline_utc: iso(0, 20), next_stage_utc: iso(0, 20) }) },
      nowMs: NOW, ids,
    }).html.includes('CLOSES TODAY'));
  check('the subtitle reaches the plaintext part too',
    allFour.text.includes('workshops added to the tracker this week'));

  // Someone who starred forty workshops asked for forty. SECTION_CAP applies to
  // every other section and must not apply to this one.
  const lots = {};
  const slugs = [];
  for (let i = 0; i < SECTION_CAP + 6; i++) {
    const slug = `neurips-2026-s${i}`;
    lots[slug] = ws(slug, { deadline_utc: iso(10 + i), next_stage_utc: iso(10 + i) });
    slugs.push(slug);
  }
  const savedOut = renderDigest({
    sub: sub({ starred_ws: JSON.stringify(slugs) }),
    events: [], workshops: lots, nowMs: NOW, ids,
  });
  const savedListed = slugs.filter((sl) => savedOut.html.includes(`/workshop/${sl}/`)).length;
  check(`the saved section is never capped (${SECTION_CAP + 6} starred, all listed)`,
    savedListed === SECTION_CAP + 6, String(savedListed));
  check('an uncapped saved section offers no "and N more" link',
    !/and \d+ more/.test(savedOut.html.split('Deadline changes this week')[0]));

  // Required on every bulk message. Under the placeholder design the renderer
  // cannot emit a real URL — it holds no HMAC secret — so what it guarantees is
  // the *placeholder*, and alerts/send.mjs guarantees the substitution. Both
  // halves are pinned: here, and in scripts/alerts_send_test.mjs.
  check('the HTML body contains the unsubscribe placeholder', out.html.includes(UNSUB_PLACEHOLDER));
  check('the HTML body contains the manage placeholder', out.html.includes(MANAGE_PLACEHOLDER));
  check('the plaintext part exists and is not HTML', out.text.length > 50 && !/<html/i.test(out.text));
  check('the plaintext part also carries the unsubscribe link', out.text.includes(UNSUB_PLACEHOLDER));
  check('the accuracy caveat is in the HTML', out.html.includes('Always confirm on the official workshop page'));
  check('the accuracy caveat is in the plaintext', out.text.includes(FOOTER_CAVEAT));
  check('no tracking pixel or remote image is embedded', !/<img/i.test(out.html));

  // Real links can be substituted (what the Worker does at send time).
  const real = renderDigest({
    sub: s, events, workshops, nowMs: NOW, ids,
    manageUrl: 'https://aiworkshoptracker.com/alerts/manage/#t=abc',
    unsubUrl: 'https://api.example.com/unsubscribe?token=abc',
  });
  check('explicit links replace the placeholders',
    real.html.includes('https://api.example.com/unsubscribe?token=abc') &&
    !real.html.includes(UNSUB_PLACEHOLDER));
}

/* --------------------------------------------------------------- section cap */
{
  const workshops = {};
  const events = [];
  for (let i = 0; i < SECTION_CAP + 7; i++) {
    const slug = `neurips-2026-w${i}`;
    workshops[slug] = ws(slug, { deadline_utc: iso(30 + i), next_stage_utc: iso(30 + i) });
    events.push({ slug, kind: 'extended', days: 2, old_utc: iso(28 + i), new_utc: iso(30 + i) });
  }
  const out = renderDigest({ sub: sub(), events, workshops, nowMs: NOW, ids });
  const listed = (out.html.match(/<li /g) || []).length;
    // Nineteen changes, all NeurIPS: one group, so the per-conference allowance
    // of 3 binds rather than the section cap. That is the trade of per-group
    // allocation — no conference is starved by whoever sorts first, and a
    // single-conference subscriber gets a shorter excerpt with its own link on.
    // One conference, 22 changes, budget 24: the budget is not reserved per
    // group, so a subscriber who follows a single conference gets all of it
    // rather than a third of it. Round-robin only starts dividing when there
    // is more than one group competing.
    check('a single-conference section gets the whole budget', listed === 22, String(listed));
  // The changes/new sections overflow to /changes/ — the page that shows
  // exactly what they are an excerpt of — carrying the subscriber's own facets.
  // "Closing in 7 days" is not a change, so it still overflows to the board.
  check('a capped changes section links on to /changes/',
    out.html.includes('https://aiworkshoptracker.com/changes/'), '');
  const facetOut = renderDigest({
    sub: sub({ conferences: '["neurips"]' }), events, workshops, nowMs: NOW, ids,
  });
    check('the section still links on with the subscriber facets',
    facetOut.html.includes('/changes/?conference=NeurIPS'), '');
    // Per-group overflow replaced the single combined line: each conference says
    // what it is holding back and links to that conference's changes.
    // Overflow, with a fixture past the budget: 30 changes, cap 24.
    const over = {}; const overEv = [];
    for (let i = 0; i < 30; i++) {
      const slug = `neurips-2026-o${i}`;
      over[slug] = ws(slug, { deadline_utc: iso(40 + i), next_stage_utc: iso(40 + i) });
      overEv.push({ slug, kind: 'extended', days: 2, old_utc: iso(38 + i), new_utc: iso(40 + i) });
    }
    const overOut = renderDigest({ sub: sub(), events: overEv, workshops: over, nowMs: NOW, ids });
    check('a group states its own overflow', /and \d+ more in NeurIPS →/.test(overOut.html), '');
    check('the plaintext carries the group overflow too', /and \d+ more in NeurIPS:/.test(overOut.text), '');
    check('a group overflow deep-links to that conference',
      overOut.html.includes('/changes/?conference=NeurIPS'), '');
}

/* ---------------------------------------------- "and N more" uses labels, not ids */
{
  const s = sub({ conferences: '["neurips","cvpr"]', topics: '["llms"]' });
  const url = facetUrl(s, ids);
  check('facet links use conference display labels', url.includes('conference=NeurIPS%2CCVPR'), url);
  check('facet links use topic display labels', url.includes('topic=Large+language+models'), url);
  check('an unfiltered subscriber links to the plain homepage',
    facetUrl(sub(), ids) === 'https://aiworkshoptracker.com/', facetUrl(sub(), ids));
}

/* -------------------------------------------------------------------- urgent */
{
  const items = [
    ws('neurips-2026-soon', { deadline_utc: iso(2, 6), next_stage_utc: iso(2, 6) }),
    ws('neurips-2026-sooner', { deadline_utc: iso(0, 20), next_stage_utc: iso(0, 20), acronym: 'SOON' }),
  ];
  const out = renderUrgent({ sub: sub(), items, nowMs: NOW, ids });
  check('an urgent alert renders', !!out);
  check('the subject leads with the soonest workshop and its hours',
    /^⏰ 20h left: SOON \(NeurIPS 2026\) \(\+1 more\)$/.test(out.subject), out.subject);
  check('all imminent workshops are in ONE message', out.html.includes('neurips-2026-soon') && out.html.includes('neurips-2026-sooner'));
  check('the urgent email carries an unsubscribe placeholder', out.html.includes(UNSUB_PLACEHOLDER));
  check('the urgent email carries a manage placeholder', out.html.includes(MANAGE_PLACEHOLDER));
  check('the urgent plaintext carries both placeholders',
    out.text.includes(UNSUB_PLACEHOLDER) && out.text.includes(MANAGE_PLACEHOLDER));
  check('the urgent email has a plaintext part', out.text.includes('Deadline approaching'));
  check('the urgent email carries the accuracy caveat', out.text.includes(FOOTER_CAVEAT));
  check('the urgent email links the official page', out.html.includes('https://example.com/ws'));
  check('no items -> null', renderUrgent({ sub: sub(), items: [], nowMs: NOW, ids }) === null);

  const single = renderUrgent({ sub: sub(), items: [items[0]], nowMs: NOW, ids });
  check('a single-workshop subject has no "+N more" suffix', !/\+\d+ more/.test(single.subject), single.subject);
}

/* ------------------------------------------------------------- transactional */
{
  const confirm = renderConfirm({ confirmUrl: 'https://api.example.com/confirm?token=abc' });
  check('the confirm email states the 48-hour expiry', /48 hours/.test(confirm.html));
  check('the confirm email contains the link', confirm.html.includes('https://api.example.com/confirm?token=abc'));
  check('the confirm email repeats the URL as text (clients that strip buttons)',
    (confirm.html.match(/api\.example\.com\/confirm/g) || []).length >= 2);
  check('the confirm email has a plaintext part', confirm.text.includes('https://api.example.com/confirm?token=abc'));
  // Transactional: there is nothing to unsubscribe from until it is clicked,
  // and offering one would let a scanner "unsubscribe" a pending signup.
  check('the confirm email has no unsubscribe link', !confirm.text.includes('Unsubscribe:'));
  check('the confirm email tells you what happens if you ignore it', /ignore this email/.test(confirm.text));

  const magic = renderMagic({ magicUrl: 'https://aiworkshoptracker.com/saved/#t=xyz' });
  check('the magic email states the 15-minute expiry', /15 minutes/.test(magic.html));
  check('the magic email warns about unrequested links', /didn't request this/.test(magic.text));
  check('the magic email has a plaintext part', magic.text.includes('#t=xyz'));
  check('every template sets a subject',
    [confirm, magic].every((m) => typeof m.subject === 'string' && m.subject.length > 5));
}

/* ------------------------------------------- saved-workshop change alerts */
{
  const workshops = {
    'neurips-2026-alpha': ws('neurips-2026-alpha', { deadline_utc: iso(30), next_stage_utc: iso(30) }),
    'neurips-2026-beta': ws('neurips-2026-beta', { deadline_utc: iso(9), next_stage_utc: iso(9) }),
  };
  const s = sub({ starred_ws: '["neurips-2026-alpha","neurips-2026-beta"]' });

  const one = renderStarredChanges({
    sub: s,
    events: [{ slug: 'neurips-2026-alpha', kind: 'extended', days: 6, old_utc: iso(24), new_utc: iso(30) }],
    workshops, ids,
  });
  check('a single saved change renders', !!one);
  // Built with wsTitle like every other subject, so it carries the
  // conference-year. This one used to interpolate `acronym || name` directly and
  // was the only subject without it — which left it ambiguous both across
  // editions (the same acronym recurs each year) and across sibling tracks.
  check('the subject names the workshop and its edition',
    /^Deadline update: ALPHA \(NeurIPS 2026\) — AI Workshop Tracker$/.test(one.subject), one.subject);
  check('it describes the extension', /EXTENDED \+6d/.test(one.html));
  check('it links the workshop page', one.html.includes('https://aiworkshoptracker.com/workshop/neurips-2026-alpha/'));

  const two = renderStarredChanges({
    sub: s,
    events: [
      { slug: 'neurips-2026-alpha', kind: 'extended', days: 6, old_utc: iso(24), new_utc: iso(30) },
      { slug: 'neurips-2026-beta', kind: 'earlier', days: 2, old_utc: iso(11), new_utc: iso(9) },
    ],
    workshops, ids,
  });
  check('several changes are counted in the subject',
    /^2 deadline updates on your saved workshops — AI Workshop Tracker$/.test(two.subject), two.subject);
  check('a moved-earlier deadline is described', /EARLIER \u22122d/.test(two.html));

  // It is deliberately narrow: this cadence exists to REPLACE a weekly summary,
  // so padding it with "closing soon" would defeat the point.
  check('it carries no closing-soon section', !/Closing in the next/.test(two.html));
  check('it carries no newly-announced section', !/New this week/.test(two.html));

  // Same rules as every other bulk message.
  check('nothing to report renders null',
    renderStarredChanges({ sub: s, events: [], workshops, ids }) === null);
  check('an event whose workshop vanished renders null',
    renderStarredChanges({ sub: s, events: [{ slug: 'gone', kind: 'extended', days: 1, new_utc: iso(5) }], workshops: {}, ids }) === null);

  // A closed deadline cannot move for any reason a subscriber cares about — the
  // only thing that changes it is us correcting our own record. Five seed
  // entries had estimated historical deadlines replaced with the real ones from
  // OpenReview, which without this guard would have mailed everyone who saved
  // them that a 2024 deadline had just been "extended".
  {
    const past = [{ slug: 'neurips-2026-alpha', kind: 'extended', days: 10, new_utc: iso(-30) }];
    const future = [{ slug: 'neurips-2026-alpha', kind: 'extended', days: 10, new_utc: iso(4) }];
    check('a change to an already-passed deadline is not mailed',
      renderStarredChanges({ sub: s, events: past, workshops, ids, nowMs: NOW }) === null);
    check('...while a change to a live deadline still is',
      renderStarredChanges({ sub: s, events: future, workshops, ids, nowMs: NOW }) !== null);
    check('...and with no clock supplied the guard stays out of the way',
      renderStarredChanges({ sub: s, events: past, workshops, ids }) !== null,
      'opt-in, so every caller that should filter is pinned below rather than here');

    // The subject is built from the FIRST surviving event, not the first
    // submitted one. Until the guard existed the two lists were identical, so
    // reading events[0] was harmless; with it, a dropped leading event put a
    // passed workshop in the subject line and a different one in the body.
    const mixed = [
      { slug: 'neurips-2026-alpha', kind: 'extended', days: 10, new_utc: iso(-30) },
      { slug: 'neurips-2026-beta', kind: 'extended', days: 3, new_utc: iso(9) },
    ];
    const m = renderStarredChanges({ sub: s, events: mixed, workshops, ids, nowMs: NOW });
    check('a dropped leading event does not title the mail',
      /BETA/.test(m.subject) && !/ALPHA/.test(m.subject), m.subject);
    check('...and the subject agrees with the one row in the body',
      /^Deadline update:/.test(m.subject) && /BETA/.test(m.html) && !/ALPHA/.test(m.html), m.subject);
  }
  check('it carries the unsubscribe placeholder', two.html.includes(UNSUB_PLACEHOLDER));
  check('it carries the manage placeholder', two.html.includes(MANAGE_PLACEHOLDER));
  check('it has a plaintext part', two.text.length > 50 && !/<html/i.test(two.text));
  check('the plaintext carries the unsubscribe placeholder', two.text.includes(UNSUB_PLACEHOLDER));
  check('it carries the accuracy caveat', two.text.includes(FOOTER_CAVEAT));
  check('no tracking pixel', !/<img/i.test(two.html));

  // Section caps apply here too.
  const many = {};
  const manyEvents = [];
  for (let i = 0; i < SECTION_CAP + 4; i++) {
    const slug = `neurips-2026-m${i}`;
    many[slug] = ws(slug, { deadline_utc: iso(20 + i), next_stage_utc: iso(20 + i) });
    manyEvents.push({ slug, kind: 'extended', days: 1, old_utc: iso(19 + i), new_utc: iso(20 + i) });
  }
  const capped = renderStarredChanges({ sub: sub({ starred_ws: JSON.stringify(Object.keys(many)) }), events: manyEvents, workshops: many, ids });
  check(`at most SECTION_CAP (${SECTION_CAP}) changes are listed`,
    (capped.html.match(/<li /g) || []).length === SECTION_CAP);
  check('the overflow links to the saved page', capped.html.includes('https://aiworkshoptracker.com/saved/'));
}

/* ------------------------------------------- local time, baked in at send --
 * Email cannot run JavaScript, so the conversion happens here from a zone
 * stored on the subscriber. The IANA *name* is stored rather than an offset so
 * each deadline resolves its own DST — an offset captured in July would be an
 * hour wrong for a January deadline.
 */
{
  const iso = '2026-09-16T23:59:00.000Z';
  check('no zone renders UTC only, exactly as before',
    fmtWhen(iso, null) === '16 Sep 2026, 23:59 UTC', fmtWhen(iso, null));
  check('a zone renders local first with UTC alongside',
    fmtWhen(iso, 'America/Los_Angeles') === '16 Sep 2026, 16:59 PDT (23:59 UTC)',
    fmtWhen(iso, 'America/Los_Angeles'));
  check('a zone ahead of UTC can roll to the next day',
    fmtWhen(iso, 'Asia/Tokyo').startsWith('17 Sep 2026'), fmtWhen(iso, 'Asia/Tokyo'));
  check('a half-hour offset is handled',
    fmtWhen(iso, 'Asia/Kolkata').includes('05:29'), fmtWhen(iso, 'Asia/Kolkata'));
  check('a subscriber already in UTC is not told the same time twice',
    fmtWhen(iso, 'UTC') === '16 Sep 2026, 23:59 UTC', fmtWhen(iso, 'UTC'));

  // The reason an IANA name is stored rather than an offset.
  const winter = fmtWhen('2026-01-16T23:59:00.000Z', 'America/Los_Angeles');
  const summer = fmtWhen('2026-07-16T23:59:00.000Z', 'America/Los_Angeles');
  check('a winter deadline uses PST', winter.includes('PST') && winter.includes('15:59'), winter);
  check('a summer deadline uses PDT', summer.includes('PDT') && summer.includes('16:59'), summer);

  // One bad row must not take down the whole send.
  check('an unknown zone degrades to UTC rather than throwing',
    fmtWhen(iso, 'Not/AZone') === '16 Sep 2026, 23:59 UTC');
  check('a junk zone degrades to UTC', fmtWhen(iso, '../../etc') === '16 Sep 2026, 23:59 UTC');
  check('an unparseable date still returns empty', fmtWhen('nope', 'UTC') === '');
}

/* ------------------------------------- the workshop is named, not initialled */
{
  const workshops = {
    'neurips-2026-lm4sci': ws('neurips-2026-lm4sci', {
      name: 'LLM for Scientific Discovery: Reasoning, Assistance, and Collaboration',
      acronym: 'LM4Sci',
      deadline_utc: iso(2), next_stage_utc: iso(2),
    }),
  };
  const s = sub({ starred_ws: '["neurips-2026-lm4sci"]' });
  const u = renderUrgent({ sub: s, tz: 'America/Los_Angeles', items: [workshops['neurips-2026-lm4sci']], nowMs: NOW, ids });

  // Every workshop in the dataset has an acronym, so `acronym || name` meant
  // the full name never appeared anywhere. The body must carry it.
  check('the body shows the full name', u.html.includes('LLM for Scientific Discovery'));
  check('the body still shows the acronym', u.html.includes('LM4Sci'));
  check('the plaintext shows the full name', u.text.includes('LLM for Scientific Discovery'));
  // Subjects are read in a crowded list; a 66-char median name truncates away.
  check('the subject uses the acronym', u.subject.includes('LM4Sci'));
  check('the subject omits the full name', !u.subject.includes('LLM for Scientific Discovery'), u.subject);
  check('the subject stays short', u.subject.length <= 70, `${u.subject.length}: ${u.subject}`);
  check('the body carries the local time', u.html.includes('PDT'));

  const d = renderDigest({
    sub: s, tz: 'America/Los_Angeles',
    events: [{ slug: 'neurips-2026-lm4sci', kind: 'extended', days: 3, old_utc: iso(-1), new_utc: iso(2) }],
    workshops, nowMs: NOW, ids,
  });
  check('the digest shows the full name too', d.html.includes('LLM for Scientific Discovery'));
  // ONE timezone in the digest now: no local conversion per row, a bare stamp
  // with a relative annotation, and the zone stated once under the first
  // heading. renderUrgent and renderStarredChanges keep the local reading.
  // Still ONE zone, stated once — but the reader's, not UTC. The original
  // decision was against repeating a second reading on every row, not against
  // local time itself; fmtLocalBare keeps a row to a single stamp while the note
  // names the zone. renderUrgent and renderStarredChanges keep "local (UTC)",
  // where a single deadline warrants both readings.
  check('the digest prints no per-row second reading', !/\(\d\d:\d\d UTC\)/.test(d.html));
  check('the digest states its timezone exactly once',
    (d.html.match(/All times [^.]+\./g) || []).length === 1,
    String((d.html.match(/All times [^.]+\./g) || []).length));
  check('a deadline carries a relative annotation', /in \d+ days · /.test(d.html), d.html.slice(0, 0));
}

/* --------------------------------------------- no internal jargon reaches a reader */
{
  const workshops = { 'neurips-2026-a': ws('neurips-2026-a', { deadline_utc: iso(2), next_stage_utc: iso(2) }) };
  const s = sub({ starred_ws: '["neurips-2026-a"]' });
  const mails = [
    renderUrgent({ sub: s, items: [workshops['neurips-2026-a']], nowMs: NOW, ids }),
    renderDigest({ sub: s, events: [], workshops, nowMs: NOW, ids }),
    renderStarredChanges({ sub: s, events: [{ slug: 'neurips-2026-a', kind: 'extended', days: 2, new_utc: iso(2) }], workshops, ids }),
  ].filter(Boolean);
  check('three templates rendered', mails.length === 3);
  for (const m of mails) {
    // "starred" is what the code calls it; the site calls it "saved", and so
    // should anything a subscriber reads.
    check(`no "starred" in "${m.subject.slice(0, 34)}…"`, !/starred/i.test(m.html) && !/starred/i.test(m.text));
    // "close" reads as "closed" to a non-native speaker, inverting the meaning.
    check(`no bare "is close" in "${m.subject.slice(0, 34)}…"`, !/is close\b/i.test(m.html));
  }
}

// --- sibling tracks must not share a subject line --------------------------
// Two tracks of one workshop carry the SAME acronym upstream (15 pairs in the
// corpus today: CVEU vs CVEU_Extended_Abstract_Track, AIMS vs its competition
// track, InfPriv vs its fast track...). The subject used to be built from
// `acronym || name`, so a subscriber who saved one track received a mail naming
// the other one just as accurately and could not tell which deadline had moved.
// The feed carries `track_label`; displayAcronym appends it when the name does
// not already say it, which is what keeps the two subjects apart.
{
  const ids = { conferences: [{ id: 'cvpr', name: 'CVPR' }], topics: [] };
  const mk = (slug, track_label) => ({
    slug, name: 'AI for Creative Visual Content Generation Editing and Understanding',
    acronym: 'CVEU', track_label, conference: 'cvpr', year: 2026,
    deadline_utc: iso(9), status: 'upcoming', topics: [],
  });
  const subjectFor = (slug, track_label) =>
    renderStarredChanges({
      events: [{ slug, kind: 'extended', days: 2, new_utc: iso(9) }],
      workshops: { [slug]: mk(slug, track_label) }, ids,
    })?.subject ?? '';

  const base = subjectFor('cvpr-2026-cveu', null);
  const track = subjectFor('cvpr-2026-cveu-extended-abstract-track', 'Extended Abstract Track');
  check('sibling tracks get distinct subjects', base !== track, `${base} === ${track}`);
  check('the track subject names its track', /Extended Abstract Track/.test(track), track);
  // A snapshot written before track_label existed must still render something.
  const legacy = subjectFor('cvpr-2026-cveu', undefined);
  check('falls back to the acronym without a track label', /CVEU/.test(legacy), legacy);
}

/* ------------------------------------------------- the caller must opt in -- */
// renderStarredChanges' passed-deadline guard only runs when it is given a
// clock, which makes it exactly as good as the one call site that matters.
// Asserted against the source because nothing else would notice the argument
// being dropped: the mail would still render, and would simply be wrong.
{
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const run = fs.readFileSync(path.join(ROOT, 'scripts', 'alerts_run.mjs'), 'utf8');
  const call = run.match(/renderStarredChanges\(\{[^}]*\}\)/);
  check('the alerts run passes a clock to renderStarredChanges',
    !!call && /nowMs\s*:/.test(call[0]),
    call ? call[0] : 'no renderStarredChanges call found in scripts/alerts_run.mjs');
}

console.log('— relative wording is calendar-based, in the reader\'s zone —');
{
  const at = (iso, now, tz) => fmtRelative(iso, Date.parse(now), tz);
  // The alert that prompted this: 47.9h out, but two calendar dates away. The
  // old 24-hour-block arithmetic floored it to 1 and said "closes tomorrow"
  // beside its own "in 47h".
  check('47.9h across two dates is 2 days', at('2026-09-01T11:59:00Z', '2026-08-30T12:08:00Z', 'America/Los_Angeles'), 'in 2 days');
  // …and the same bug in the other direction: under 24h, but the next date.
  check('20h across midnight is tomorrow', at('2026-08-31T19:00:00Z', '2026-08-30T23:00:00Z', 'UTC'), 'closes tomorrow');
  check('same date is today', at('2026-08-30T20:00:00Z', '2026-08-30T18:00:00Z', 'UTC'), 'closes today');
  check('past is closed', at('2026-08-29T12:00:00Z', '2026-08-30T12:00:00Z', 'UTC'), 'closed');
  // The zone is the reader's, so one instant can honestly read differently.
  check('01:00 UTC is still today in Los Angeles', at('2026-08-31T01:00:00Z', '2026-08-30T20:00:00Z', 'America/Los_Angeles'), 'closes today');
  check('...and tomorrow for a UTC reader', at('2026-08-31T01:00:00Z', '2026-08-30T20:00:00Z', 'UTC'), 'closes tomorrow');
  check('no zone falls back to UTC', at('2026-09-01T11:59:00Z', '2026-08-30T12:08:00Z', null), 'in 2 days');
}

console.log(failed === 0 ? '\nRendering OK.' : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
