#!/usr/bin/env node
/**
 * Topic tagging with Jev (lib/jev_topics.mjs): the question set, the state it is
 * asked over, and the policy that turns probabilities into a topic list. The
 * answers replayed here are REAL — recorded from jev-1.13.0 on 2026-09-18 for
 * three corpus entries the keyword table had left as `other` — so the suite
 * pins the thresholds against what the model actually says, and runs offline.
 *
 * Run: node scripts/jev_topics_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTopics, loadConferences } from '../lib/workshops.mjs';
import { topicQuestions, topicState, pickTopics, suggestTopics, TOPIC_MIN, TOPIC_MAX } from '../lib/jev_topics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}
const noul = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, { type: 'noul', noul: v }]));

/* --------------------------------------------- recorded answers (real) ---- */
// corl-2026-lfc — "Learning from Corrections and Interventions", CoRL 2026.
// The keyword table saw no topic. With the conference described, robotics 0.93.
const LFC = noul({ agents: 0.21, causality: 0.07, climate: 0.02, datasets: 0.11, diffusion: 0.07, education: 0.04, efficiency: 0.06, 'evaluation-benchmarks': 0.14, fairness: 0.08, 'federated-learning': 0.06, 'generative-models': 0.07, genomics: 0.01, graphs: 0.06, 'healthcare-bio': 0.04, interpretability: 0.07, llms: 0.12, 'math-reasoning': 0.07, multimodal: 0.1, neuroscience: 0.03, nlp: 0.05, optimization: 0.14, physics: 0.02, privacy: 0.04, 'reinforcement-learning': 0.79, robotics: 0.93, robustness: 0.17, 'safety-alignment': 0.28, 'science-applications': 0.03, 'speech-audio': 0.03, systems: 0.05, tabular: 0.07, theory: 0.2, 'time-series': 0.07, vision: 0.09 });
// iclr-2025-ai4na — "AI for Nucleic Acids". Four topics near or over the bar;
// the cap and the ordering are what this fixture exercises.
const AI4NA = noul({ agents: 0.07, causality: 0.04, climate: 0.02, datasets: 0.22, diffusion: 0.25, education: 0.02, efficiency: 0.16, 'evaluation-benchmarks': 0.38, fairness: 0.06, 'federated-learning': 0.07, 'generative-models': 0.34, genomics: 0.86, graphs: 0.14, 'healthcare-bio': 0.72, interpretability: 0.21, llms: 0.55, 'math-reasoning': 0.1, multimodal: 0.08, neuroscience: 0.02, nlp: 0.06, optimization: 0.27, physics: 0.04, privacy: 0.04, 'reinforcement-learning': 0.16, robotics: 0.02, robustness: 0.2, 'safety-alignment': 0.06, 'science-applications': 0.4, 'speech-audio': 0.02, systems: 0.09, tabular: 0.06, theory: 0.17, 'time-series': 0.06, vision: 0.03 });
// eccv-2026-wearableai — "Wearable AI Workshop". One topic clears the bar,
// and only because the conference is a vision conference.
const WEARABLE = noul({ agents: 0.09, causality: 0.04, climate: 0.02, datasets: 0.13, diffusion: 0.13, education: 0.03, efficiency: 0.42, 'evaluation-benchmarks': 0.22, fairness: 0.09, 'federated-learning': 0.12, 'generative-models': 0.2, genomics: 0.02, graphs: 0.06, 'healthcare-bio': 0.1, interpretability: 0.1, llms: 0.13, 'math-reasoning': 0.07, multimodal: 0.23, neuroscience: 0.05, nlp: 0.05, optimization: 0.14, physics: 0.02, privacy: 0.13, 'reinforcement-learning': 0.11, robotics: 0.07, robustness: 0.19, 'safety-alignment': 0.07, 'science-applications': 0.03, 'speech-audio': 0.04, systems: 0.09, tabular: 0.06, theory: 0.12, 'time-series': 0.17, vision: 0.89 });

const topics = loadTopics();
const conferences = loadConferences();

/* ------------------------------------------------------- the questions ---- */
{
  const q = topicQuestions(topics);
  const ids = Object.keys(q);
  check('one question per topic, `other` never asked',
    ids.length === topics.length - 1 && !('other' in q) && ids.every((id) => topics.some((t) => t.id === id)));
  check('every question is a noul with a yes and a no criterion',
    ids.every((id) => q[id].type === 'noul' && q[id].criteria?.true && q[id].criteria?.false));
  check('every topic carries a description, and the question quotes it',
    topics.filter((t) => t.id !== 'other').every((t) => t.description && q[t.id].instructions.includes(t.description)),
    'labels like "Efficiency" are too terse for a literal reader; data/topics.yml holds the gloss');
  check('the question tells the model to use the host conference',
    ids.every((id) => /`conference`/.test(q[id].instructions) && /full_name/.test(q[id].instructions)),
    'told to judge from the name alone, Jev scored a CoRL workshop 0.20 for robotics');
}

/* ----------------------------------------------------------- the state ---- */
{
  const s = topicState({ name: 'Learning from Corrections and Interventions', acronym: 'LfC Workshop CoRL 2026', conference: 'corl', year: 2026 }, conferences);
  check('the state describes the conference by its own row, not a hand-written gloss',
    s.conference.name === 'CoRL' && s.conference.full_name === 'Conference on Robot Learning' && s.workshop_name.startsWith('Learning from'));
  const u = topicState({ name: 'X', conference: 'nope', year: 2030 }, conferences);
  check('an unknown conference degrades to its id, and a missing acronym to ""',
    u.conference.name === 'nope' && u.conference.full_name === '' && u.acronym === '');
}

/* ------------------------------------------------------------ the policy -- */
{
  check('the documented thresholds', TOPIC_MIN === 0.5 && TOPIC_MAX === 3);
  check('LfC: robotics and RL clear the bar, in probability order',
    pickTopics(LFC).join(',') === 'robotics,reinforcement-learning', pickTopics(LFC).join(','));
  check('AI4NA: the cap keeps the three strongest and drops the fourth (science-applications 0.40)',
    pickTopics(AI4NA).join(',') === 'genomics,healthcare-bio,llms', pickTopics(AI4NA).join(','));
  check('WearableAI: one topic', pickTopics(WEARABLE).join(',') === 'vision');
  check('the cap is the cap: a lower bar on AI4NA still yields three',
    pickTopics(AI4NA, { min: 0.2 }).length === 3);
  check('below the bar means none, not the best of a bad set',
    pickTopics(noul({ a: 0.49, b: 0.3 })).length === 0);
  check('ties break by id, so a re-run writes the same list',
    pickTopics(noul({ zeta: 0.7, alpha: 0.7 })).join(',') === 'alpha,zeta');
  check('a malformed answer never counts',
    pickTopics({ a: { type: 'noul' }, b: null, c: { noul: 'high' } }).length === 0);
}

/* --------------------------------------------------------- end to end ----- */
{
  const seen = [];
  const replay = (answers) => async (state, questions) => { seen.push({ state, questions }); return { answers, model: 'jev-1.13.0', usage: {} }; };
  const lfc = { name: 'Learning from Corrections and Interventions', acronym: 'LfC Workshop CoRL 2026', conference: 'corl', year: 2026 };
  const got = await suggestTopics(lfc, { ask: replay(LFC), topics, conferences });
  check('suggestTopics asks the topic questions over the entry state and applies the policy',
    got.join(',') === 'robotics,reinforcement-learning'
      && seen[0].state.conference.full_name === 'Conference on Robot Learning'
      && Object.keys(seen[0].questions).length === topics.length - 1);

  const none = await suggestTopics(lfc, { ask: async () => null, topics, conferences });
  check('no judgment available -> null, so the caller falls back to the keyword table', none === null);

  const flat = await suggestTopics(lfc, { ask: replay(noul({ robotics: 0.31, vision: 0.31 })), topics, conferences });
  check('nothing over the bar -> null too (LMRL really did come back this way)', flat === null);

  const rogue = await suggestTopics(lfc, { ask: replay({ ...LFC, 'not-a-topic': { type: 'noul', noul: 0.99 } }), topics, conferences });
  check('an answer under an id we never asked is dropped, never written',
    !rogue.includes('not-a-topic') && rogue[0] === 'robotics');
}

/* ---------------------------------------------------------- plumbing ------ */
{
  const discover = fs.readFileSync(path.join(ROOT, 'scripts', 'discover_openreview.mjs'), 'utf8');
  check('discovery asks Jev first and keeps the keyword table as the fallback',
    /import \{[^}]*\bsuggestTopics\b[^}]*\} from '\.\.\/lib\/jev_topics\.mjs'/.test(discover)
      && /await suggestTopics\([^)]*\)\)\s*\?\?\s*guessTopics\(/.test(discover));
  const retag = fs.readFileSync(path.join(ROOT, 'scripts', 'retag_topics.mjs'), 'utf8');
  check('the retag sweep does the same', /suggestTopics/.test(retag) && /guessTopics/.test(retag));
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'discover.yml'), 'utf8');
  check('the discovery workflow passes the key (unset on a fork => keyword table, by design)',
    /TYPESAFE_API_KEY:\s*\$\{\{\s*secrets\.TYPESAFE_API_KEY\s*\}\}/.test(wf));
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'validate.yml'), 'utf8');
  check('CI runs this test', /jev_topics_test\.mjs/.test(ci), 'the workflow lists tests by hand');
}

console.log(failed === 0 ? '\nJev topic tagging OK.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
