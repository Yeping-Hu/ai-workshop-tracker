#!/usr/bin/env node
/**
 * The paper matcher's pure logic (alerts/fit.mjs): input bounds, the two
 * question sets, candidate selection, batching, ranking, what a match is said
 * to stand on, and the partial/unavailable paths. Offline; the network is a
 * stub. Run: node scripts/alerts_fit_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateInput,
  paperState,
  paperTopicQuestions,
  paperTopics,
  selectCandidates,
  candidateView,
  fitQuestions,
  fitFromAnswer,
  matchPaper,
  TITLE_MAX,
  ABSTRACT_MAX,
  CANDIDATES_MAX,
  CANDIDATES_MIN,
  BATCH,
  MATCHES_SHOWN,
  FIT_LEVELS,
} from '../alerts/fit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}

const TOPICS = [
  { id: 'robotics', label: 'Robotics', description: 'robotics: robot learning, manipulation' },
  { id: 'llms', label: 'Large language models', description: 'large language models and foundation models' },
  { id: 'vision', label: 'Computer vision', description: 'computer vision: images, video, 3D' },
  { id: 'theory', label: 'Theory', description: 'learning theory' },
];
const cand = (slug, topics, deadline, extra = {}) => ({
  slug, url: `/workshop/${slug}/`, name: `Workshop ${slug}`, acronym: slug.toUpperCase(), short_name: slug.toUpperCase(),
  conference: { id: 'neurips', name: 'NeurIPS', full_name: 'Conference on Neural Information Processing Systems' }, year: 2026,
  topics: topics.map((id) => ({ id, label: TOPICS.find((t) => t.id === id).label })),
  website: null, deadline_utc: deadline, deadline_wall_clock: deadline, past_titles: [], past_paper_count: 0, editions: 0, ...extra,
});

/* --------------------------------------------------------------- input ---- */
{
  check('a title is required and at least three characters',
    validateInput({}).error === 'bad_request' && validateInput({ title: 'ab' }).error === 'bad_request' && validateInput(null).error === 'bad_request');
  const ok = validateInput({ title: '  Attention   is\nall you need ', abstract: ' We  propose\n\nthe Transformer. ' });
  check('whitespace is collapsed and the abstract is optional',
    ok.ok && ok.title === 'Attention is all you need' && ok.abstract === 'We propose the Transformer.' && validateInput({ title: 'A fine title' }).abstract === '');
  check('over-long input is refused as too_long, not truncated silently',
    validateInput({ title: 'x'.repeat(TITLE_MAX + 1) }).error === 'too_long' && validateInput({ title: 'ok title', abstract: 'x'.repeat(ABSTRACT_MAX + 1) }).error === 'too_long');
  check('a non-string abstract is a bad request', validateInput({ title: 'ok title', abstract: 42 }).error === 'bad_request');
  check('with no abstract the state tells the model to judge from the title',
    /judge from the title/.test(paperState({ title: 't', abstract: '' }).paper.abstract) && paperState({ title: 't', abstract: 'a' }).paper.abstract === 'a');
}

/* ------------------------------------------------------- stage 1 -------- */
{
  const q = paperTopicQuestions([...TOPICS, { id: 'other', label: 'Other' }]);
  check('one noul per topic, `other` never asked, description quoted, paper fields named',
    Object.keys(q).length === 4 && !('other' in q) && /large language models and foundation models/.test(q.llms.instructions)
      && /`paper\.title`/.test(q.llms.instructions) && q.llms.type === 'noul');
  const probs = paperTopics({ robotics: { noul: 0.9 }, llms: { noul: 0.2 }, vision: { noul: 0.7 } }, TOPICS);
  check('paper topics come back strongest first with labels, a missing answer reading as 0',
    probs.map((t) => t.id).join(',') === 'robotics,vision,llms,theory' && probs[0].label === 'Robotics' && probs[3].p === 0);
}

/* ------------------------------------------------ candidate selection ---- */
{
  const probs = paperTopics({ robotics: { noul: 0.9 }, vision: { noul: 0.6 }, llms: { noul: 0.2 } }, TOPICS);
  const C = [
    cand('a-llm', ['llms'], '2026-10-01'),
    cand('b-vis', ['vision'], '2026-10-05'),
    cand('c-rob-late', ['robotics'], '2026-11-01'),
    cand('d-rob-soon', ['robotics'], '2026-10-02'),
    cand('e-both', ['robotics', 'vision'], '2026-12-01'),
    cand('f-theory', ['theory'], null),
  ];
  const sel = selectCandidates(C, probs, { min: 1 });
  check('overlapping calls first: strongest overlap, then soonest deadline',
    sel.map((c) => c.slug).join(',') === 'e-both,d-rob-soon,c-rob-late,b-vis', sel.map((c) => c.slug).join(','));
  const filled = selectCandidates(C, probs, { min: 6 });
  check('below the floor, the rest are appended by their best topic, so an odd paper still gets an answer',
    filled.length === 6 && filled[4].slug === 'a-llm' && filled[5].slug === 'f-theory');
  const many = Array.from({ length: 60 }, (_, i) => cand(`w${String(i).padStart(2, '0')}`, ['robotics'], `2026-10-${String((i % 28) + 1).padStart(2, '0')}`));
  check('the cap holds', selectCandidates(many, probs).length === CANDIDATES_MAX && CANDIDATES_MIN < CANDIDATES_MAX);
  const none = selectCandidates(C, paperTopics({}, TOPICS), { min: 2 });
  check('a paper with no topic over the bar still meets the nearest calls',
    none.length === 2);
}

/* ------------------------------------------------------- stage 2 -------- */
{
  const b = [cand('x', ['robotics'], '2026-10-01', { past_titles: ['Grasping with tactile feedback'], past_paper_count: 40 }), cand('y', ['llms'], null)];
  const q = fitQuestions(b);
  check('one Score per candidate, each pointing at its own entry, four levels in order',
    Object.keys(q).join(',') === 'fit_0,fit_1' && /`candidates\[1\]`/.test(q.fit_1.instructions)
      && q.fit_0.criteria.map((c) => c.level).join(',') === FIT_LEVELS.join(','));
  const v = candidateView(b[0]);
  check('the model sees identity, topics and past titles — not slugs, urls or counts',
    v.conference.startsWith('NeurIPS (') && v.topics[0] === 'Robotics' && v.past_accepted_paper_titles[0].startsWith('Grasping') && !('slug' in v) && !('url' in v));
  check('a Score answer becomes a level and an expected value',
    JSON.stringify(fitFromAnswer({ probabilities: [0, 0.1, 0.3, 0.6] })) === JSON.stringify({ level: 'strong', score: 0.83 })
      && fitFromAnswer({ probabilities: { poor: 1, possible: 0, good: 0, strong: 0 } }).level === 'poor');
  check('a shape the API does not document is unjudged, not a wrong number',
    fitFromAnswer({ probabilities: [0.5, 0.5] }) === null && fitFromAnswer({}) === null && fitFromAnswer({ probabilities: [0, 0, 0, 1.5] }) === null);
}

/* --------------------------------------------------------- end to end ---- */
{
  // Twenty-five open calls; the paper is about robot learning.
  const feed = {
    topics: TOPICS,
    candidates: [
      ...Array.from({ length: 22 }, (_, i) => cand(`rob${String(i).padStart(2, '0')}`, ['robotics'], `2026-10-${String(i + 1).padStart(2, '0')}`, i === 0 ? { past_titles: ['Learning dexterous grasps', 'Sim-to-real for manipulation'], past_paper_count: 57, editions: 2 } : {})),
      cand('vis1', ['vision'], '2026-10-03'),
      cand('llm1', ['llms'], '2026-10-04'),
      cand('thy1', ['theory'], null),
    ],
  };
  const calls = [];
  const ask = async (state, questions) => {
    calls.push({ state, questions });
    if (!state.candidates) {
      return { model: 'jev-1.13.0', answers: { robotics: { noul: 0.92 }, vision: { noul: 0.55 }, llms: { noul: 0.1 }, theory: { noul: 0.05 } } };
    }
    const answers = {};
    state.candidates.forEach((c, i) => {
      // The one call with past papers on grasping fits strongly; other robotics calls are good; anything else poor.
      const probs = c.past_accepted_paper_titles.length ? [0, 0.05, 0.15, 0.8] : c.topics.includes('Robotics') ? [0.05, 0.15, 0.6, 0.2] : [0.8, 0.15, 0.05, 0];
      answers[`fit_${i}`] = { type: 'score', probabilities: probs };
    });
    return { model: 'jev-1.13.0', answers };
  };
  const r = await matchPaper({ title: 'Learning grasps from tactile feedback', abstract: 'We train a policy...' }, feed, { ask });
  check('stage 1 asks once over the paper; stage 2 asks in batches of ten over the selected calls',
    calls.length === 1 + Math.ceil(23 / BATCH) && calls[1].state.candidates.length === BATCH && calls[0].state.paper.title.startsWith('Learning grasps'));
  check('the selection covered the 22 robotics calls and the vision call, not the LLM or theory ones',
    r.considered === 23 && r.open_calls === 25);
  check('the strongest fit ranks first, with its evidence named',
    r.matches[0].slug === 'rob00' && r.matches[0].fit === 'strong' && r.matches[0].basis === 'past_papers' && r.matches[0].past_paper_count === 57);
  check('a first edition is honest about its basis', r.matches[1].basis === 'name_topics' && r.matches[1].past_paper_count === 0);
  check(`at most ${MATCHES_SHOWN} matches, ordered by score then soonest deadline`,
    r.matches.length === MATCHES_SHOWN && r.matches[1].slug === 'rob01' && r.matches[2].slug === 'rob02'
      && r.matches.every((m, i, a) => i === 0 || a[i - 1].score >= m.score));
  check('the paper\'s own topics are reported, over the bar only',
    r.paper_topics.map((t) => t.id).join(',') === 'robotics,vision' && r.model === 'jev-1.13.0' && r.partial === false);
  check('a match carries what the page needs and nothing the model said in words',
    r.matches[0].url === '/workshop/rob00/' && r.matches[0].conference.name === 'NeurIPS' && r.matches[0].topics[0] === 'Robotics'
      && typeof r.matches[0].score === 'number' && !('explanation' in r.matches[0]));

  const down = await matchPaper({ title: 'Anything at all', abstract: '' }, feed, { ask: async () => null });
  check('no answer to stage 1 -> unavailable', down.ok === false && down.error === 'unavailable');

  let n = 0;
  const flaky = async (state, questions) => (state.candidates && ++n === 2 ? null : ask(state, questions));
  const part = await matchPaper({ title: 'Learning grasps from tactile feedback', abstract: '' }, feed, { ask: flaky });
  // The second batch is rob10–rob19 (robotics calls sort by deadline); none of
  // them may appear, and the other thirteen judged rows still fill the list.
  check('one failed batch leaves its rows unjudged and marks the result partial',
    part.ok && part.partial === true && part.matches.length === MATCHES_SHOWN && !part.matches.some((m) => /^rob1\d$/.test(m.slug)));

  const empty = await matchPaper({ title: 'Learning grasps', abstract: '' }, { topics: TOPICS, candidates: [] }, { ask });
  check('no open calls at all is a valid, empty answer', empty.ok && empty.matches.length === 0 && empty.considered === 0);
}

/* ---------------------------------------------------------- plumbing ------ */
{
  const worker = fs.readFileSync(path.join(ROOT, 'alerts', 'worker', 'src', 'index.mjs'), 'utf8');
  check('the Worker routes POST /match through this module and the pure Jev client',
    /path === '\/match' && method === 'POST'/.test(worker) && /from '\.\.\/\.\.\/fit\.mjs'/.test(worker) && /from '\.\.\/\.\.\/\.\.\/lib\/jev\.mjs'/.test(worker));
  check('...behind Turnstile, a per-IP limit and a daily brake, and 503 without the key',
    /handleMatch/.test(worker) && /RL_MATCH_PER_IP_HOUR/.test(worker) && /RL_MATCH_PER_DAY/.test(worker) && /TYPESAFE_API_KEY\) return fail\(request, env, 503/.test(worker));
  const fit = fs.readFileSync(path.join(ROOT, 'alerts', 'fit.mjs'), 'utf8');
  check('fit.mjs imports nothing but the Jev client (it runs in the Worker)',
    (fit.match(/^import /gm) ?? []).length === 1 && /from '\.\.\/lib\/jev\.mjs'/.test(fit));
  for (const wf of ['alerts-ci.yml', 'alerts-worker-deploy.yml']) {
    const text = fs.readFileSync(path.join(ROOT, '.github', 'workflows', wf), 'utf8');
    check(`${wf} knows lib/jev.mjs is inside the Worker bundle`, /lib\/jev\.mjs/.test(text));
  }
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'alerts-ci.yml'), 'utf8');
  check('CI runs this test', /alerts_fit_test\.mjs/.test(ci), 'the workflow lists tests by hand');
}

console.log(failed === 0 ? '\nPaper matcher OK.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
