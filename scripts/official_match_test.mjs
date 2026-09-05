#!/usr/bin/env node
/**
 * The official-list MATCHER (lib/official_match.mjs).
 *
 * The question it answers — "is this corpus entry on the conference's accepted
 * list?" — has two expensive ways to be wrong. A false NEGATIVE reports a real,
 * running workshop as possibly rejected. A false POSITIVE quietly pairs a
 * rejected proposal with somebody else's accepted workshop and the report goes
 * silent. So the must-NOT-match cases below carry as much weight as the matches.
 *
 * Run: node scripts/official_match_test.mjs
 */
import fs from 'node:fs';
import { extractListedWorkshops } from '../lib/official_list.mjs';
import { matchOfficialList, classifyNameDrift, classifyWebsiteDrift, hostedByConference } from '../lib/official_match.mjs';
import { loadWorkshops } from '../lib/workshops.mjs';

let failed = 0;
function check(label, got, expect) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(expect)})`}`);
}

const LIST_URL = 'https://blog.neurips.cc/2026/08/10/announcing-the-neurips-2026-workshops/';
const listed = extractListedWorkshops(
  fs.readFileSync(new URL('./fixtures/neurips-2026-workshops.html', import.meta.url), 'utf8'),
  { baseUrl: LIST_URL },
).items;

/** A resolved-workshop shape, minimal but with the fields the matcher reads. */
const ws = (over) => ({
  slug: 'x',
  conference: 'neurips',
  year: 2026,
  name: 'A Workshop',
  website: '',
  status: 'upcoming',
  statusLabel: 'Open call',
  ...over,
});
const run = (entries, items = listed) =>
  matchOfficialList(entries, items, { listUrl: LIST_URL, conferenceWebsite: 'https://neurips.cc' });
const slugsOf = (list) => list.map((e) => e.slug).sort();

/* ------------------------------------------------- tier U: the same page */
{
  const r = run([ws({ slug: 'a', website: 'https://opt-ml.org/', name: 'OPT 2026' })]);
  check('exact url matches', r.pairs[0]?.how, 'url');

  // A list routinely links a deeper path than we store, and vice versa.
  // Asserted as `{how, url}`: checking only the url lets a later tier rescue the
  // case, and the containment rule would then pin nothing.
  //
  // These are the shapes websiteKey() does NOT already flatten — it strips
  // `/home`, `index.html` and fragments, so those normalise to one key on their
  // own and prove nothing here. What is left is a genuinely deeper path: the
  // list linking a year sub-page or a call-for-papers page while we store the
  // workshop root. Five live entries depend on it (all three GenAI4Health track
  // files, MPLR-FM, ReMuCAI).
  check('official list links a year sub-page, we store the root',
    (({ how, item }) => ({ how, url: item.url }))(run([ws({ website: 'https://genai4health.github.io/' })]).pairs[0]),
    { how: 'url', url: 'https://genai4health.github.io/2026-NeurIPS/' });
  check('official list links a call-for-papers page, we store the root',
    (({ how, item }) => ({ how, url: item.url }))(
      run([ws({ website: 'https://neurips-workshop2026.github.io/foundation_model_agentic_privacy/' })]).pairs[0],
    ),
    { how: 'url', url: 'https://neurips-workshop2026.github.io/foundation_model_agentic_privacy/call_for_papers.html' });
  check('...and the reverse, a shared host where we store the deeper path',
    (({ how, item }) => ({ how, url: item.url }))(run([ws({ website: 'https://sites.google.com/view/remucai/description' })]).pairs[0]),
    { how: 'url', url: 'https://sites.google.com/view/remucai/description' });
  check('trailing slash and scheme are irrelevant',
    run([ws({ website: 'http://www.opt-ml.org' })]).pairs[0]?.how, 'url');
}

/* ------------------------------------- many-to-one: a workshop's tracks */
{
  // THE case that makes tracks matched rather than reported as rejected. Three
  // NeurReps track files share one website and one listed workshop.
  const tracks = ['proceedings', 'findings', 'extended-abstracts'].map((t) =>
    ws({ slug: `neurreps-${t}`, name: `Symmetry and Geometry in Neural Representations (${t})`, website: 'https://neurreps.org/' }),
  );
  const r = run(tracks);
  check('three track files all match', r.pairs.length, 3);
  check('...to ONE listed workshop', new Set(r.pairs.map((p) => p.item.url)).size, 1);
  check('...counted once, not three times', r.counts.matched, 1);
  check('...and none is reported off-list', r.offList.length, 0);
}

/* --------------------------------------------- tier T: names alone */
{
  // Entries with no stored website at all — the only tier that can reach them.
  check('no website, near-identical title',
    run([ws({ name: 'Towards Test-Time Continual Learning Agents' })]).pairs[0]?.how, 'title');
  // Our stored name is an abbreviation of the listed one. Containment over the
  // shorter name is why this matches where Jaccard would not.
  check('our name is a prefix of the listed one',
    run([ws({ name: 'Physical Understanding for Decision-Making: Bridging Foundation Models and Reliable Agents' })]).pairs[0]?.item.url,
    'https://sites.google.com/view/neurips-2026-workshop-pudm');
  // A placeholder website pointing at the conference itself must not block the
  // title tier, and must not match on host either.
  check('a placeholder conference URL falls through to the title tier',
    run([ws({ name: 'Self-Evolving Diversity-Driven Search for Robust AI Systems', website: 'https://neurips.cc/Conferences/2026' })]).pairs[0]?.how,
    'title');
}

/* ---------------------------------- must NOT match: the expensive errors */
{
  // "foundation models" agrees with twenty titles under namesAgree's two-shared-
  // tokens rule. A generic name must produce NO match, not an arbitrary one.
  check('a generic name matches nothing', run([ws({ name: 'Workshop on Foundation Models' })]).pairs.length, 0);
  check('...and is reported off-list instead', run([ws({ slug: 'gen', name: 'Workshop on Foundation Models' })]).offList.length, 1);

  // Two different workshops on one shared host. siteRoot() returns null for
  // these, so the host tier can never fire.
  check('two sites.google.com workshops do not match on host',
    run([ws({ name: 'Something Entirely Unrelated', website: 'https://sites.google.com/view/some-other-thing' })]).pairs.length, 0);
  check('two github.io workshops do not match on host',
    run([ws({ name: 'Something Entirely Unrelated', website: 'https://unrelated-thing.github.io/' })]).pairs.length, 0);

  // A rejected proposal must never be paired with somebody else's workshop.
  check('the rejected EIML proposal matches nothing',
    run([ws({ slug: 'eiml', name: 'Epistemic Intelligence in Machine Learning', website: 'https://epistemic-intelligence-in-ml.github.io' })]).pairs.length, 0);
  // A competition and an affinity event are real, but not on this list.
  check('a competition matches nothing',
    run([ws({ name: 'RoCo-Spring: The Robust Correspondence Challenge', website: 'https://roco-spring.github.io/' })]).pairs.length, 0);
  check('an affinity event matches nothing',
    run([ws({ name: 'Women in Machine Learning Workshop', website: 'https://sites.google.com/wimlworkshop.org/wimlworkshopneurips2026/' })]).pairs.length, 0);
}

/* ------------------------------------------- drift, and what is NOT drift */
{
  // A single entry whose stored website disagrees with the list IS drift.
  const lone = ws({ slug: 'evorobust', name: 'Self-Evolving Diversity-Driven Search for Robust AI Systems', website: 'https://neurips.cc/Conferences/2026' });
  check('a lone entry pointing somewhere else is reported', run([lone]).drifted.map((d) => d.field), ['website']);

  // But a TRACK is not. The official list carries one URL per workshop — the
  // workshop's — so once a sibling matches it exactly, a track pointing
  // elsewhere is its own competition/track site, not a disagreement.
  //
  // This is the real IAB shape, and it matters because the report's suggested
  // fix is "adopt the official URL": acting on it would overwrite the
  // competition track's own site with a duplicate of the main entry's, and the
  // stored value is deliberate — the entry carries a maintainer's note saying
  // exactly which site belongs to which.
  const main = ws({ slug: 'iab', name: 'The 1st Workshop on Interpreting Agent Behavior (IAB)', website: 'https://iab-agents.github.io/' });
  const track = ws({
    slug: 'iab-competition-paper-track',
    name: 'The 1st Workshop on Interpreting Agent Behavior (IAB) at NeurIPS 2026 - Competition Paper Track',
    website: 'https://glee-competition.com',
  });
  const both = run([main, track]);
  check('both the workshop and its track match the one listed entry', both.pairs.length, 2);
  check('...counted once', both.counts.matched, 1);
  check('...and the track site is NOT reported as drift', both.drifted.length, 0);

  // The suppression is conditional on a sibling actually accounting for the
  // official URL — a track alone, with no sibling matching it, still reports.
  check('the track alone (no sibling holds the official url) still reports',
    run([track]).drifted.map((d) => d.field), ['website']);
}

/* --------------------------- a list that links OpenReview instead of homepages */
// Four of ICLR 2024's twenty entries link the workshop's OpenReview GROUP rather
// than its website. websiteKey() drops the query string, so all four normalise to
// the single key "openreview.net/group": they matched each other, the counts
// disagreed with the list itself, and each produced a nonsense "your website
// should be openreview.net" drift row.
{
  const iclr2024 = extractListedWorkshops(
    fs.readFileSync(new URL('./fixtures/iclr-2024-workshops.html', import.meta.url), 'utf8'),
    { baseUrl: 'https://blog.iclr.cc/2024/01/08/announcing-the-accepted-workshops-at-iclr-2024/' },
  ).items;
  check('20 workshops listed', iclr2024.length, 20);
  const collapsed = iclr2024.filter((i) => /openreview\.net\/group/.test(i.url));
  check('...four of them link an OpenReview group, not a homepage', collapsed.length, 4);

  const entries = [
    ws({ slug: 'gem', name: 'Nothing In Common', openreview_venue_id: 'ICLR.cc/2024/Workshop/GEM', website: 'https://gem-workshop.example/' }),
    ws({ slug: 'dpfm', name: 'Also Unrelated', openreview_venue_id: 'ICLR.cc/2024/Workshop/DPFM', website: 'https://dpfm.example/' }),
  ];
  const r = matchOfficialList(entries, iclr2024, { listUrl: 'x', conferenceWebsite: 'https://iclr.cc' });

  // Names deliberately share nothing with the listed titles, so ONLY the venue
  // id can match these — and it must match each to its own workshop.
  check('each matches by venue id', r.pairs.map((p) => p.how), ['venue', 'venue']);
  check('...to two DIFFERENT listed workshops', new Set(r.pairs.map((p) => p.item.index)).size, 2);
  check('...and the right ones', r.pairs.map((p) => /GEM|DPFM/.exec(p.item.url)?.[0]).sort(), ['DPFM', 'GEM']);

  // An OpenReview group URL is not a homepage, so it can never be evidence that
  // our website is wrong.
  check('no website drift is invented from an OpenReview link',
    r.drifted.filter((d) => d.field === 'website').length, 0);
  // Name drift still fires, correctly — these fixtures are deliberately named
  // nothing like the listed titles, which is what forced the venue-id match.
  check('...while name drift still works', r.drifted.filter((d) => d.field === 'name').length, 2);

  // The case the !item.venueId guard actually protects: an entry with NO venue
  // id of its own, matched to an OpenReview-linked listing by title. Nothing
  // else suppresses it, and without the guard the report would tell you to set
  // your website to "openreview.net/group?id=…".
  const byTitle = matchOfficialList(
    [ws({ slug: 'settlm', name: 'Secure and Trustworthy Large Language Models', website: 'https://set-llm.example/' })],
    iclr2024,
    { listUrl: 'x', conferenceWebsite: 'https://iclr.cc' },
  );
  check('a title match against an OpenReview-linked listing still matches', byTitle.pairs[0]?.how, 'title');
  check('...and still invents no website drift',
    byTitle.drifted.filter((d) => d.field === 'website').length, 0);

  // The count is derived from the array the report prints, not from lengths.
  check('counts.missing agrees with the missing array', r.counts.missing, r.missing.length);
  check('...and with the arithmetic', r.counts.missing, 18);
}

/* ------------------------------------------- classifying drift, not just reporting it */
{
  // The three real NeurIPS 2026 name mismatches were three DIFFERENT situations,
  // which is the whole reason "always adopt the official list" is wrong.
  check('a stub name loses to the full official title',
    classifyNameDrift('AgenticOS Workshop', 'AgenticOS: Co-designing Systems and ML Foundations of an OS Layer for Agentic AI'),
    'adopt');
  check('a venue-noisy name loses to it too',
    classifyNameDrift('BabyVLM Workshop NEURIPS 2026', 'The BabyVLM Workshop: Toward Developmentally Plausible Multimodal Systems'),
    'adopt');
  // The expensive one: the official list is NOT always better. Adopting
  // "AI4Mat-NeurIPS-2026" would put acronym+venue+year in `name` — the exact
  // shape stripVenueFromName removes everywhere else — and would throw away the
  // only descriptive title this entry has.
  check('our real name BEATS an acronym-shaped official title',
    classifyNameDrift('AI for Accelerated Materials Design', 'AI4Mat-NeurIPS-2026'), 'decline');

  check('two genuinely different names are a human call',
    classifyNameDrift('Workshop on Robot Learning', 'Foundations of Agentic Systems Theory'), 'unclear');
  check('an empty side is never decided automatically', classifyNameDrift('', 'Anything At All'), 'unclear');

  // nameTokens already discards "workshop", the conference and the year, so
  // these two say the same thing and neither is more informative.
  check('a pure venue-noise difference is not an improvement',
    classifyNameDrift('BabyVLM Workshop NEURIPS 2026', 'BabyVLM Workshop'), 'unclear');

  // Website: exactly one case is mechanical.
  check('a stored URL that is the conference site is a placeholder -> adopt',
    classifyWebsiteDrift('https://neurips.cc/Conferences/2026', 'https://neurips.cc'), 'adopt');
  check('...regardless of scheme or www', classifyWebsiteDrift('http://www.neurips.cc/x', 'https://neurips.cc'), 'adopt');
  check('two real, different URLs stay a human call',
    classifyWebsiteDrift('https://theagenticweb.ai', 'https://neurips.cc'), 'unclear');
  check('no conference website configured -> never decides',
    classifyWebsiteDrift('https://neurips.cc/Conferences/2026', null), 'unclear');

  // And the verdict reaches the report rows.
  const r = run(
    [ws({ slug: 'evorobust', name: 'Self-Evolving Diversity-Driven Search for Robust AI Systems', website: 'https://neurips.cc/Conferences/2026' })],
    listed,
  );
  check('a drift row carries its verdict', r.drifted[0]?.verdict, 'adopt');
}

/* ------------------------------------------------- ack and marked entries */
{
  const affinity = ws({ slug: 'wiml', name: 'Women in Machine Learning Workshop', website: 'https://www.wiml.example/' });
  check('unacknowledged -> reported off-list', run([affinity]).offList.length, 1);
  check('acknowledged against THIS list -> silent',
    run([{ ...affinity, review_ack: { official_list: LIST_URL } }]).offList.length, 0);
  check('...and counted, so the report can say how many are suppressed',
    run([{ ...affinity, review_ack: { official_list: LIST_URL } }]).counts.acked, 1);
  // Cosmetic churn in the recorded URL must not un-suppress it...
  check('a trailing slash does not un-suppress it',
    run([{ ...affinity, review_ack: { official_list: LIST_URL.replace(/\/$/, '') } }]).offList.length, 0);
  // ...but a genuinely different list must. That is the whole point of storing
  // the reviewed VALUE rather than a blanket mute.
  check('a DIFFERENT list re-reports it',
    run([{ ...affinity, review_ack: { official_list: 'https://blog.neurips.cc/2027/some-other-post/' } }]).offList.length, 1);

  const marked = { ...affinity, status: 'not_running', statusLabel: 'Not running' };
  check('an entry already marked is not re-reported', run([marked]).offList.length, 0);
  check('...but is counted', run([marked]).counts.marked, 1);
}

/* ------------------------------------------ independent: left the conference */
// Off the list AND outside the conference's OpenReview namespace is the
// organisers running the event on their own: UniReps 2026 and ML4PS 2026 were
// both imported from NeurIPS.cc during the proposal phase and had moved to their
// own namespaces within days of the accepted list appearing. An acknowledgement
// recorded before such a move was a verdict on a different fact, so it is
// reported again rather than staying silent forever.
{
  const NS = 'NeurIPS.cc/2026/Workshop';
  check('under the namespace -> hosted', hostedByConference('NeurIPS.cc/2026/Workshop/WiML', NS), true);
  check('own namespace -> not hosted', hostedByConference('ML4PS/2026/Workshop', NS), false);
  check('own domain namespace -> not hosted', hostedByConference('UniReps.org/2026/Workshop', NS), false);
  check('a longer segment is not the namespace', hostedByConference('NeurIPS.cc/2026/Workshops/X', NS), false);
  check('a trailing slash on the namespace is tolerated', hostedByConference('NeurIPS.cc/2026/Workshop/X', `${NS}/`), true);
  check('no venue id -> unknown, not either answer', hostedByConference('', NS), null);
  check('no namespace -> unknown', hostedByConference('ML4PS/2026/Workshop', null), null);

  const runNs = (entries) =>
    matchOfficialList(entries, listed, { listUrl: LIST_URL, conferenceWebsite: 'https://neurips.cc', venueNamespace: NS });
  const ack = { official_list: LIST_URL };
  const affinity = ws({
    slug: 'wiml', name: 'Women in Machine Learning Workshop', website: 'https://www.wiml.example/',
    openreview_venue_id: 'NeurIPS.cc/2026/Workshop/WiML', review_ack: ack,
  });
  const left = ws({
    slug: 'ml4ps', name: 'Machine Learning and the Physical Sciences', website: 'https://ml4ps.example/',
    openreview_venue_id: 'ML4PS/2026/Workshop', review_ack: ack,
  });
  const r = runNs([affinity, left]);
  check('only the acknowledged entry that left the namespace is reported', slugsOf(r.independent), ['ml4ps']);
  check('...both still count as acknowledged', r.counts.acked, 2);
  check('...and the departed one is counted', r.counts.independent, 1);
  check('neither is in the off-list bucket', r.offList.length, 0);
  // Only acknowledged entries: an unacknowledged one is already off-list, where
  // its own row says the same thing.
  const unacked = { ...left, review_ack: undefined };
  check('an unacknowledged departed entry is off-list, not independent',
    [runNs([unacked]).offList.length, runNs([unacked]).independent.length], [1, 0]);
  check('a marked entry is neither',
    runNs([{ ...left, status: 'not_running', statusLabel: 'Not running' }]).independent.length, 0);
  check('an acknowledgement against a different list is off-list again, not independent',
    runNs([{ ...left, review_ack: { official_list: 'https://blog.neurips.cc/2027/some-other-post/' } }]).independent.length, 0);
  check('without a namespace nothing can be judged, so nothing is reported', run([left]).independent.length, 0);
}

/* ------------------------------------------------------------- missing */
{
  // The only bucket that can ever surface a workshop with no OpenReview presence
  // at all — REO-2 and AI for Peace are exactly that, so no crawl will find them.
  const r = run([]);
  check('with an empty corpus every listed workshop is missing', r.missing.length, 102);
  check('missing rows carry the url a contributor needs',
    r.missing.every((m) => /^https?:\/\//.test(m.url) && m.title.length > 3), true);
}

/* ------------------------------------------- the live corpus: the real shape */
// Two different properties, pinned separately.
//
// FIRST: how the MATCHER classifies the real corpus, with every recorded
// decision stripped back off. This is the durable assertion — it describes what
// the code concludes, not what a maintainer has since decided about it, so
// acknowledging an entry cannot quietly turn it green.
{
  const undecided = loadWorkshops()
    .filter((w) => w.conference === 'neurips' && w.year === 2026)
    .map(({ not_running, review_ack, ...w }) => ({
      ...w,
      status: w.status === 'not_running' ? 'upcoming' : w.status,
      statusLabel: w.statusLabel === 'Not running' ? 'Open call' : w.statusLabel,
      ...(review_ack ? { review_ack: { ...review_ack, official_list: undefined } } : {}),
    }));
  const r = run(undecided);
  check('neurips 2026: 102 listed', r.counts.listed, 102);
  // Every accepted workshop is now tracked. Two of them (REO-2, AI for Peace)
  // have no OpenReview presence at all, so no crawl will ever produce them —
  // they exist only because this report surfaced them and a human added them.
  // A drop here means either the matcher regressed or coverage was lost.
  check('all 102 are covered by the corpus', r.counts.matched, 102);
  check('nothing on the list is missing', r.counts.missing, 0);
  check('11 tracked entries are off-list', r.counts.offList, 11);
  check('the off-list set is the known one', slugsOf(r.offList), [
    'neurips-2026-africa-in-ai',
    'neurips-2026-eiml',
    'neurips-2026-globalsouthai',
    'neurips-2026-lxai',
    'neurips-2026-ml4ps',
    'neurips-2026-musiml',
    'neurips-2026-newinml',
    'neurips-2026-queerinai',
    'neurips-2026-roco-spring',
    'neurips-2026-unireps',
    'neurips-2026-wiml',
  ]);
  // Every legitimate track file is matched, not reported.
  check('no track file is reported off-list',
    r.offList.some((e) => /neurreps|genai4health|infpriv|tccml|vericodegen|iab-/.test(e.slug)), false);
}

// SECOND: the corpus as it actually stands. Each of those eleven now carries a
// decision — eight acknowledged as events the conference hosts under its own
// namespace and simply does not call "workshops" (affinity events, a
// competition), three marked as not the conference's: one rejected proposal
// (EIML) and two independent events that left NeurIPS.cc for their own
// namespaces (ML4PS, UniReps) — so the weekly report is empty and the issue
// closes. A new off-list entry appearing here turns this red, which is the point.
{
  const entries = loadWorkshops().filter((w) => w.conference === 'neurips' && w.year === 2026);
  const r = run(entries);
  check('every off-list entry has a recorded decision', r.counts.offList, 0);
  check('...eight acknowledged as running', r.counts.acked, 8);
  check('...three marked as not running', r.counts.marked, 3);
  check('and nothing on the official list is untracked', r.counts.missing, 0);
  // The namespace rule against the corpus as it stands: every acknowledged
  // entry still sits under NeurIPS.cc. ML4PS, which had moved and was reported
  // here until 2026-09-04, is now marked, so nothing awaits a verdict.
  const rNs = matchOfficialList(entries, listed, {
    listUrl: LIST_URL, conferenceWebsite: 'https://neurips.cc', venueNamespace: 'NeurIPS.cc/2026/Workshop',
  });
  check('no acknowledged entry has left the conference namespace', slugsOf(rNs.independent), []);
}

console.log(failed === 0 ? '\nOfficial-list matching OK.' : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
