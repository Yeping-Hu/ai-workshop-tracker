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
import { matchOfficialList } from '../lib/official_match.mjs';
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
const run = (entries, items = listed) => matchOfficialList(entries, items, { listUrl: LIST_URL });
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
  check('99 of 102 covered by the corpus', r.counts.matched, 99);
  check('10 tracked entries are off-list', r.counts.offList, 10);
  check('3 accepted workshops are absent', r.counts.missing, 3);
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
    'neurips-2026-wiml',
  ]);
  check('the missing set is the known one', r.missing.map((m) => m.url).sort(), [
    'https://aiforpeaceworkshop.github.io/',
    'https://embodiedsr.github.io/',
    'https://reo-workshop.org/2026/',
  ]);
  // Every legitimate track file is matched, not reported.
  check('no track file is reported off-list',
    r.offList.some((e) => /neurreps|genai4health|infpriv|tccml|vericodegen|iab-/.test(e.slug)), false);
}

// SECOND: the corpus as it actually stands. Each of those ten now carries a
// decision — nine acknowledged as real events that are simply not "workshops" in
// this list's sense, one marked as a rejected proposal — so the weekly report is
// empty and the issue closes. A new off-list entry appearing here (UniReps is
// due on the next crawl) turns this red, which is the point.
{
  const entries = loadWorkshops().filter((w) => w.conference === 'neurips' && w.year === 2026);
  const r = run(entries);
  check('every off-list entry has a recorded decision', r.counts.offList, 0);
  check('...nine acknowledged as running', r.counts.acked, 9);
  check('...one marked as not running', r.counts.marked, 1);
  check('the three genuinely missing workshops still report', r.counts.missing, 3);
}

console.log(failed === 0 ? '\nOfficial-list matching OK.' : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
