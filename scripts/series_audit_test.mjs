#!/usr/bin/env node
/**
 * The weekly series-identity audit (lib/series_links.mjs): which pairs are
 * candidates, how a Score answer becomes a record, that a pair is asked once
 * and re-asked only when an identity changes, that a person's decision
 * outranks the model, and that the file round-trips. Offline — the network is
 * a stub that replays the probabilities jev-1.13.0 really returned for these
 * corpus records on 2026-09-18.
 *
 * Run: node scripts/series_audit_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { computeRelations, pairKey, pairHash, identityHash, LINK_MIN, REVIEW_MIN } from '../lib/workshops.mjs';
import {
  candidatePairs,
  seriesQuestion,
  pairState,
  pSame,
  classify,
  auditSeries,
  decide,
  serializeSeriesLinks,
  renderReport,
  SERIES_LEVELS,
} from '../lib/series_links.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}

/* ------------------------------------------------- real corpus records ---- */
const E = {
  dpfm24: { slug: 'iclr-2024-dpfm', name: 'Navigating and Addressing Data Problems for Foundation Models', acronym: 'DPFM 2024', conference: 'iclr', year: 2024, website: 'https://sites.google.com/view/dpfm-iclr24/', openreview_venue_id: 'ICLR.cc/2024/Workshop/DPFM', topics: ['datasets'], statusLabel: 'Past' },
  dp25: { slug: 'iclr-2025-data-problems', name: 'Navigating and Addressing Data Problems for Foundation Models', acronym: 'Data Problems', conference: 'iclr', year: 2025, website: 'https://datafm.github.io/', openreview_venue_id: 'ICLR.cc/2025/Workshop/Data_Problems', topics: ['datasets'], statusLabel: 'Past' },
  fm4ls_icml: { slug: 'icml-2025-fm4ls', name: 'Multi-modal Foundation Models and Large Language Models for Life Sciences', acronym: 'FM4LS 2025', conference: 'icml', year: 2025, website: 'https://fm4ls.github.io', openreview_venue_id: 'ICML.cc/2025/Workshop/FM4LS', topics: ['llms'], statusLabel: 'Past' },
  fm4ls_nips: { slug: 'neurips-2025-fm4ls', name: '2nd Workshop on Multi-modal Foundation Models and Large Language Models for Life Sciences', acronym: '2nd Workshop FM4LS', conference: 'neurips', year: 2025, website: 'https://nips2025fm4ls.github.io', openreview_venue_id: 'NeurIPS.cc/2025/Workshop/FM4LS', topics: ['llms'], statusLabel: 'Past' },
  aims_colm: { slug: 'colm-2026-aims', name: 'First Workshop in AI Measurement Science: Toward Rigorous AI Evaluation', acronym: 'AIMS', conference: 'colm', year: 2026, website: 'https://aimslab.stanford.edu/workshop', openreview_venue_id: 'colmweb.org/COLM/2026/Workshop/AIMS', topics: ['evaluation-benchmarks'], statusLabel: 'Open call' },
  aims_iclr: { slug: 'iclr-2026-aims', name: 'The First Workshop on AI for Mechanism Design and Strategic Decision Making', acronym: 'AIMS', conference: 'iclr', year: 2026, website: 'https://alimama-tech.github.io/aims-2026/#', openreview_venue_id: 'ICLR.cc/2026/Workshop/AIMS', topics: ['agents'], statusLabel: 'Past' },
  // Two tracks of one workshop on one site: Tier 1 links them, so they are
  // never a candidate — and they share a conference-year, which is out of scope anyway.
  aims_ct: { slug: 'colm-2026-aims-competition-track', name: 'First Workshop in AI Measurement Science: Toward Rigorous AI Evaluation - Competition Track', acronym: 'AIMS', conference: 'colm', year: 2026, website: 'https://aimslab.stanford.edu/workshop', openreview_venue_id: 'colmweb.org/COLM/2026/Workshop/AIMS_Competition_Track', topics: ['evaluation-benchmarks'], statusLabel: 'Open call' },
  // Same conference, agreeing names — a candidate by `names`, and the real
  // MATH-AI series: Tier 4 already links these, so they must NOT be asked.
  mathai24: { slug: 'neurips-2024-math-ai', name: 'The 4th Workshop on Mathematical Reasoning and AI', acronym: 'MATH-AI', conference: 'neurips', year: 2024, website: 'https://mathai2024.github.io/', openreview_venue_id: 'NeurIPS.cc/2024/Workshop/MATH-AI', topics: ['math-reasoning'], statusLabel: 'Past' },
  mathai25: { slug: 'neurips-2025-math-ai', name: 'The 5th Workshop on Mathematical Reasoning and AI', acronym: 'MATH-AI', conference: 'neurips', year: 2025, website: 'https://mathai2025.github.io/', openreview_venue_id: 'NeurIPS.cc/2025/Workshop/MATH-AI', topics: ['math-reasoning'], statusLabel: 'Past' },
};
const ALL = Object.values(E);
const CONFS = [
  { id: 'iclr', name: 'ICLR', full_name: 'International Conference on Learning Representations' },
  { id: 'icml', name: 'ICML', full_name: 'International Conference on Machine Learning' },
  { id: 'neurips', name: 'NeurIPS', full_name: 'Conference on Neural Information Processing Systems' },
  { id: 'colm', name: 'COLM', full_name: 'Conference on Language Modeling' },
];
// What jev-1.13.0 answered on 2026-09-18 (probabilities in level order).
const ANSWERS = {
  [pairKey('iclr-2024-dpfm', 'iclr-2025-data-problems')]: [0, 0.01, 0.99],
  [pairKey('icml-2025-fm4ls', 'neurips-2025-fm4ls')]: [0.02, 0.08, 0.9],
  [pairKey('colm-2026-aims', 'iclr-2026-aims')]: [1, 0, 0],
};

/* ---------------------------------------------------------- candidates ---- */
{
  const rel = computeRelations(ALL);
  const cands = candidatePairs(ALL, rel);
  const keys = new Set(cands.map((c) => pairKey(c.a.slug, c.b.slug)));
  check('a renamed stem in one conference is a candidate by names',
    keys.has(pairKey('iclr-2024-dpfm', 'iclr-2025-data-problems')) && cands.find((c) => c.a.slug === 'iclr-2024-dpfm').why === 'names');
  check('a shared stem across conferences is a candidate by stem',
    keys.has(pairKey('icml-2025-fm4ls', 'neurips-2025-fm4ls')) && keys.has(pairKey('colm-2026-aims', 'iclr-2026-aims')));
  check('a pair Tiers 1–4 already link is never asked (MATH-AI, Tier 4)',
    !keys.has(pairKey('neurips-2024-math-ai', 'neurips-2025-math-ai')));
  check('a same-conference-year pair is never asked (tracks belong to Tiers 1–2)',
    !keys.has(pairKey('colm-2026-aims', 'colm-2026-aims-competition-track')));
  check('unrelated names in one conference are not candidates',
    !keys.has(pairKey('iclr-2024-dpfm', 'iclr-2026-aims')));
  check('candidates are in canonical slug order', cands.every((c) => c.a.slug < c.b.slug));
}

/* ------------------------------------------------ question and answer ----- */
{
  const q = seriesQuestion();
  check('the question is a Score whose levels are the three things one can do with a pair',
    q.type === 'score' && q.criteria.map((c) => c.level).join(',') === SERIES_LEVELS.join(',') && SERIES_LEVELS[2] === 'same_series');
  check('...and it says an acronym alone is not identity', /acronym alone/.test(q.instructions));
  const s = pairState(E.fm4ls_icml, E.fm4ls_nips, CONFS);
  check('the state carries identity fields and each conference by its own row',
    s.workshop_a.openreview_short_name === 'fm4ls' && s.workshop_b.conference.full_name.startsWith('Conference on Neural') && !('deadline' in s.workshop_a));
  check('pSame reads the same_series level from the array the API returns',
    pSame({ probabilities: [0.02, 0.08, 0.9] }) === 0.9 && pSame({ probabilities: { same_series: 0.7 } }) === 0.7);
  check('...and a shape it does not recognise is no answer, not a wrong number',
    pSame({ probabilities: 'high' }) === null && pSame({}) === null && pSame({ probabilities: [0, 0, 1.7] }) === null);
  check('the documented thresholds', LINK_MIN === 0.9 && REVIEW_MIN === 0.4);
  check('classify: at the bar links, a hair under is review, under 0.4 is different',
    classify(0.9) === 'link' && classify(0.89) === 'review' && classify(0.4) === 'review' && classify(0.39) === 'no' && classify(null) === 'no');
}

/* ------------------------------------------------------- identity hash ---- */
{
  const h = identityHash(E.dp25);
  check('the hash is stable and 12 hex', h === identityHash({ ...E.dp25 }) && /^[0-9a-f]{12}$/.test(h));
  check('a deadline or note change does not move it (the daily jobs touch those)',
    identityHash({ ...E.dp25, submission_deadline: '2026-01-01', deadline_notes: 'x', notes: 'y', status: 'past' }) === h);
  check('a name, website or stem change does',
    identityHash({ ...E.dp25, name: 'Other' }) !== h && identityHash({ ...E.dp25, website: 'https://x.example' }) !== h
      && identityHash({ ...E.dp25, openreview_venue_id: 'ICLR.cc/2025/Workshop/Other' }) !== h);
  check('a pair hash is order-independent', pairHash(E.dpfm24, E.dp25) === pairHash(E.dp25, E.dpfm24));
}

/* -------------------------------------------------------------- audit ----- */
{
  const rel = computeRelations(ALL);
  const log = [];
  // pairState() carries identity fields and no slug, so the stub recognises a
  // pair by name + conference + year and replays what the model really said;
  // anything else gets the H2R collision's real, ambiguous numbers.
  const byName = new Map(ALL.map((e) => [`${e.name}|${e.conference}|${e.year}`, e.slug]));
  const askByName = async (state) => {
    const a = byName.get(`${state.workshop_a.name}|${state.workshop_a.conference.name.toLowerCase()}|${state.workshop_a.year}`);
    const b = byName.get(`${state.workshop_b.name}|${state.workshop_b.conference.name.toLowerCase()}|${state.workshop_b.year}`);
    log.push([a, b]);
    const probs = ANSWERS[pairKey(a, b)] ?? [0.44, 0.43, 0.13];
    return { answers: { series: { type: 'score', probabilities: probs } }, model: 'jev-1.13.0', usage: {} };
  };
  const tagged = ALL;

  const r1 = await auditSeries({ entries: tagged, relations: rel, links: { model: null, pairs: [], decisions: [] }, ask: askByName, today: '2026-09-18', conferences: CONFS });
  // Four candidates, not three: the competition track's stem is `aims` too, so
  // it collides with ICLR's AIMS across conferences exactly as the main track does.
  check('every candidate is asked once and recorded with probability, date, hash and reason',
    r1.asked === 4 && r1.answered === 4 && r1.links.pairs.length === 4
      && r1.links.pairs.every((p) => /^[0-9a-f]{12}$/.test(p.hash) && p.judged === '2026-09-18' && ['stem', 'names'].includes(p.via)));
  check('the model that answered is recorded', r1.links.model === 'jev-1.13.0');
  const dp = r1.links.pairs.find((p) => p.a === 'iclr-2024-dpfm');
  check('DPFM → Data_Problems links (0.99) and is reported as linked this run',
    dp.same === 0.99 && r1.linkedNow.some((p) => p.a === 'iclr-2024-dpfm'));
  check('the AIMS collision is recorded as different (0.00) and reported nowhere',
    r1.links.pairs.find((p) => p.a === 'colm-2026-aims').same === 0 && !r1.review.length && !r1.linkedNow.some((p) => p.a === 'colm-2026-aims'));

  const r2 = await auditSeries({ entries: tagged, relations: rel, links: r1.links, ask: askByName, today: '2026-09-25', conferences: CONFS });
  check('a second run asks nothing: every pair is recorded with a matching hash', r2.asked === 0 && r2.links.pairs.length === 4 && !r2.linkedNow.length);

  const renamed = tagged.map((e) => (e.slug === 'iclr-2025-data-problems' ? { ...e, name: 'Data Problems for Foundation Models, Renamed' } : e));
  const r3 = await auditSeries({ entries: renamed, relations: computeRelations(renamed), links: r1.links, ask: askByName, today: '2026-10-02', conferences: CONFS });
  // The stub resolves slugs by name, so the renamed side reads as unknown; the
  // unrenamed partner identifies the pair.
  check('a renamed entry is re-asked, and only it', r3.asked === 1 && log.at(-1)[0] === 'iclr-2024-dpfm', `asked ${r3.asked}`);

  const r4 = await auditSeries({ entries: tagged, relations: rel, links: { ...r1.links, model: 'jev-1.12.0' }, ask: askByName, today: '2026-10-09', conferences: CONFS });
  check('a file judged by another model version is re-judged in full, and says so', r4.stale && r4.asked === 4);

  const r5 = await auditSeries({ entries: tagged, relations: rel, links: { model: null, pairs: [], decisions: [] }, ask: async () => null, today: '2026-09-18', conferences: CONFS });
  check('Jev unavailable: asked, nothing answered, nothing recorded, no throw — next week asks again',
    r5.asked === 4 && r5.answered === 0 && r5.links.pairs.length === 0);

  const gone = tagged.filter((e) => e.slug !== 'neurips-2025-fm4ls');
  const r6 = await auditSeries({ entries: gone, relations: computeRelations(gone), links: r1.links, ask: askByName, today: '2026-10-16', conferences: CONFS });
  check('a record naming a slug that left the dataset is pruned', r6.pruned === 1 && !r6.links.pairs.some((p) => p.b === 'neurips-2025-fm4ls'));

  // The review band, with a real ambiguous answer: the H2R collision's numbers.
  const h2r = [
    { slug: 'corl-2025-h2r', name: 'Human to Robot: Workshop on Sensorizing, Modeling, and Learning from Humans', acronym: 'H2R CoRL 2025', conference: 'corl', year: 2025, website: 'https://sites.google.com/view/h2r-corl2025', openreview_venue_id: 'robot-learning.org/CoRL/2025/Workshop/H2R', topics: ['robotics'], statusLabel: 'Past' },
    { slug: 'cvpr-2025-h2r', name: 'Agents in Interactions, from Humans to Robots', acronym: 'H2R 2025', conference: 'cvpr', year: 2025, website: 'https://agents-in-interactions.github.io/', openreview_venue_id: 'thecvf.com/CVPR/2025/Workshop/H2R', topics: ['robotics'], statusLabel: 'Past' },
  ];
  const r7 = await auditSeries({ entries: h2r, relations: computeRelations(h2r), links: { model: null, pairs: [], decisions: [] }, ask: async () => ({ answers: { series: { probabilities: [0.44, 0.43, 0.13] } } }), today: '2026-09-18', conferences: CONFS });
  check('an ambiguous answer under the bar is recorded, not linked, and not reviewed either below 0.4',
    r7.links.pairs[0].same === 0.13 && !r7.linkedNow.length && !r7.review.length);
  const r8 = await auditSeries({ entries: h2r, relations: computeRelations(h2r), links: { model: null, pairs: [], decisions: [] }, ask: async () => ({ answers: { series: { probabilities: [0.1, 0.2, 0.7] } } }), today: '2026-09-18', conferences: CONFS });
  check('0.7 lands in the review band: recorded, reported, not linked',
    r8.review.length === 1 && !r8.linkedNow.length && computeRelations(h2r, { seriesLinks: r8.links }).get('corl-2025-h2r').relatedEditions.length === 0);
  const decided = decide(r8.links, 'cvpr-2025-h2r', 'corl-2025-h2r', 'different', '2026-09-19');
  const r9 = await auditSeries({ entries: h2r, relations: computeRelations(h2r), links: decided, ask: async () => { throw new Error('must not be asked'); }, today: '2026-09-26', conferences: CONFS });
  check('a decided pair leaves the review band and is never asked again', r9.review.length === 0 && r9.asked === 0);
  const same = decide(r8.links, 'cvpr-2025-h2r', 'corl-2025-h2r', 'same', '2026-09-20');
  check('a later verdict supersedes the earlier one, in canonical order',
    same.decisions.length === 1 && same.decisions[0].verdict === 'same' && same.decisions[0].a === 'corl-2025-h2r'
      && computeRelations(h2r, { seriesLinks: same }).get('corl-2025-h2r').relatedEditions[0].slug === 'cvpr-2025-h2r');
  let threw = false;
  try { decide(r8.links, 'a', 'b', 'maybe'); } catch { threw = true; }
  check('a verdict other than same/different is refused', threw);

  /* ------------------------------------------------------ file + report --- */
  const text = serializeSeriesLinks(r1.links);
  const back = yaml.load(text);
  check('the file round-trips', JSON.stringify(back) === JSON.stringify({ model: r1.links.model, pairs: r1.links.pairs, decisions: r1.links.decisions }));
  check('...one flow-style record per line, under a header that says who writes it',
    text.startsWith('# Series links judged by Jev') && /--decide/.test(text) && /^  - \{a: iclr-2024-dpfm, b: iclr-2025-data-problems, same: 0\.99/m.test(text));

  const by = new Map(h2r.map((e) => [e.slug, e]));
  const rep = renderReport({ review: r8.review, linkedNow: [], by, today: '2026-09-18' });
  check('the report names both workshops, the probability, and how to decide',
    /Human to Robot/.test(rep) && /Agents in Interactions/.test(rep) && /\*\*0\.70\*\*/.test(rep) && /--decide/.test(rep));
  check('nothing to confirm and nothing linked -> an empty report, which closes the issue',
    renderReport({ review: [], linkedNow: [], by, today: '2026-09-18' }) === '');
}

/* ---------------------------------------------------------- plumbing ------ */
{
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'series-audit.yml'), 'utf8');
  check('the weekly workflow runs the audit with the key and publishes the file',
    /series_audit\.mjs/.test(wf) && /TYPESAFE_API_KEY:\s*\$\{\{\s*secrets\.TYPESAFE_API_KEY\s*\}\}/.test(wf)
      && /publish-data/.test(wf) && /data\/series_links\.yml/.test(wf) && /group: data-write/.test(wf));
  check('...and offers the decision inputs on dispatch', /--decide/.test(wf) && /verdict/.test(wf));
  const lib = fs.readFileSync(path.join(ROOT, 'lib', 'workshops.mjs'), 'utf8');
  check('the build reads the file through loadWorkshops, never this module',
    /computeRelations\(all, \{ seriesLinks: loadSeriesLinks\(\) \}\)/.test(lib) && !/from '\.\/series_links\.mjs'/.test(lib));
  const validate = fs.readFileSync(path.join(ROOT, 'scripts', 'validate.mjs'), 'utf8');
  check('validate.mjs checks the file', /SERIES_LINKS_FILE/.test(validate));
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'validate.yml'), 'utf8');
  check('CI runs this test', /series_audit_test\.mjs/.test(ci), 'the workflow lists tests by hand');
}

console.log(failed === 0 ? '\nSeries audit OK.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
