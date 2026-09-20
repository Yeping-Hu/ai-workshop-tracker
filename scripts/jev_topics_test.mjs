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
import { topicQuestions, topicState, pickTopics, askTopics, retagDecision, TOPIC_MIN, TOPIC_FLOOR, TOPIC_MAX } from '../lib/jev_topics.mjs';
import { hasAutoTopicsNote, withoutAutoTopicsNote, hasKeywordTopicsNote, judgedTopicsNote, topicsForImport, AUTO_TOPICS_NOTE, KEYWORD_TOPICS_NOTE } from './discover_openreview.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}
const noul = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, { type: 'noul', noul: v }]));

/* --------------------------------------------- recorded answers (real) ---- */
// Recorded 2026-09-19 against the 48-topic vocabulary (jev-1.13.0).
// corl-2026-lfc — "Learning from Corrections and Interventions", CoRL 2026.
// The keyword table saw no topic. With the conference described, robotics 0.93.
// The first recording also had reinforcement learning at 0.79 — as did 36 CoRL
// workshops that never mention it, because "Conference on Robot Learning" read
// as RL. The description now says what does not count; 0.30 here.
const LFC = noul({ affinity: 0.02, agents: 0.2, 'autonomous-driving': 0.07, causality: 0.07, climate: 0.02, code: 0.04, 'continual-learning': 0.18, 'creative-ai': 0.03, datasets: 0.08, diffusion: 0.08, economics: 0.03, education: 0.05, efficiency: 0.06, 'evaluation-benchmarks': 0.14, fairness: 0.08, 'federated-learning': 0.06, 'generative-models': 0.06, genomics: 0.01, graphs: 0.06, 'healthcare-bio': 0.04, 'human-ai': 0.56, interpretability: 0.08, llms: 0.1, 'math-reasoning': 0.04, multimodal: 0.1, neuroscience: 0.03, nlp: 0.05, optimization: 0.16, physics: 0.02, privacy: 0.04, probabilistic: 0.14, 'reinforcement-learning': 0.3, 'representation-learning': 0.07, 'research-practice': 0.1, robotics: 0.93, robustness: 0.17, 'safety-alignment': 0.29, 'science-applications': 0.03, 'speech-audio': 0.04, systems: 0.04, tabular: 0.06, theory: 0.17, 'time-series': 0.07, video: 0.04, vision: 0.08, 'vision-3d': 0.06, 'vision-humans': 0.03, 'world-models': 0.13 });
// iclr-2025-ai4na — "AI for Nucleic Acids". Two topics over the bar and one
// (llms 0.55) in the band between the floor and the bar, which the bar drops.
const AI4NA = noul({ affinity: 0.02, agents: 0.07, 'autonomous-driving': 0.02, causality: 0.04, climate: 0.02, code: 0.04, 'continual-learning': 0.07, 'creative-ai': 0.03, datasets: 0.15, diffusion: 0.25, economics: 0.02, education: 0.02, efficiency: 0.15, 'evaluation-benchmarks': 0.41, fairness: 0.06, 'federated-learning': 0.07, 'generative-models': 0.31, genomics: 0.85, graphs: 0.14, 'healthcare-bio': 0.71, 'human-ai': 0.05, interpretability: 0.2, llms: 0.52, 'math-reasoning': 0.06, multimodal: 0.07, neuroscience: 0.02, nlp: 0.06, optimization: 0.24, physics: 0.05, privacy: 0.04, probabilistic: 0.19, 'reinforcement-learning': 0.08, 'representation-learning': 0.55, 'research-practice': 0.08, robotics: 0.02, robustness: 0.19, 'safety-alignment': 0.06, 'science-applications': 0.39, 'speech-audio': 0.03, systems: 0.07, tabular: 0.06, theory: 0.1, 'time-series': 0.06, video: 0.02, vision: 0.03, 'vision-3d': 0.02, 'vision-humans': 0.02, 'world-models': 0.05 });
// eccv-2026-wearableai — "Wearable AI Workshop". One topic clears the bar,
// and only because the conference is a vision conference.
const WEARABLE = noul({ affinity: 0.02, agents: 0.09, 'autonomous-driving': 0.05, causality: 0.04, climate: 0.02, code: 0.07, 'continual-learning': 0.13, 'creative-ai': 0.09, datasets: 0.13, diffusion: 0.14, economics: 0.01, education: 0.03, efficiency: 0.43, 'evaluation-benchmarks': 0.25, fairness: 0.1, 'federated-learning': 0.12, 'generative-models': 0.21, genomics: 0.02, graphs: 0.08, 'healthcare-bio': 0.11, 'human-ai': 0.23, interpretability: 0.1, llms: 0.11, 'math-reasoning': 0.04, multimodal: 0.26, neuroscience: 0.05, nlp: 0.05, optimization: 0.15, physics: 0.02, privacy: 0.14, probabilistic: 0.11, 'reinforcement-learning': 0.06, 'representation-learning': 0.2, 'research-practice': 0.06, robotics: 0.07, robustness: 0.18, 'safety-alignment': 0.07, 'science-applications': 0.03, 'speech-audio': 0.1, systems: 0.09, tabular: 0.06, theory: 0.1, 'time-series': 0.19, video: 0.4, vision: 0.91, 'vision-3d': 0.19, 'vision-humans': 0.36, 'world-models': 0.1 });
// neurips-2024-regml — "Regulatable ML". Nothing over the bar; the best
// (fairness 0.53) is over the floor, so it is the one topic the entry takes.
const REGML = noul({ affinity: 0.02, agents: 0.06, 'autonomous-driving': 0.05, causality: 0.1, climate: 0.03, code: 0.09, 'continual-learning': 0.05, 'creative-ai': 0.04, datasets: 0.11, diffusion: 0.1, economics: 0.08, education: 0.04, efficiency: 0.07, 'evaluation-benchmarks': 0.18, fairness: 0.53, 'federated-learning': 0.1, 'generative-models': 0.12, genomics: 0.03, graphs: 0.05, 'healthcare-bio': 0.06, 'human-ai': 0.08, interpretability: 0.23, llms: 0.19, 'math-reasoning': 0.07, multimodal: 0.06, neuroscience: 0.05, nlp: 0.1, optimization: 0.16, physics: 0.03, privacy: 0.18, probabilistic: 0.16, 'reinforcement-learning': 0.06, 'representation-learning': 0.07, 'research-practice': 0.14, robotics: 0.03, robustness: 0.19, 'safety-alignment': 0.34, 'science-applications': 0.04, 'speech-audio': 0.05, systems: 0.12, tabular: 0.09, theory: 0.16, 'time-series': 0.07, video: 0.04, vision: 0.09, 'vision-3d': 0.03, 'vision-humans': 0.05, 'world-models': 0.05 });
// corl-2026-groundeddrivingwms — "Grounded 4D Multimodal World Models for
// Autonomous Driving Decision-Making". Six topics over the bar; the cap keeps five.
const DRIVINGWM = noul({ affinity: 0.01, agents: 0.35, 'autonomous-driving': 0.86, causality: 0.08, climate: 0.02, code: 0.05, 'continual-learning': 0.09, 'creative-ai': 0.02, datasets: 0.11, diffusion: 0.29, economics: 0.02, education: 0.02, efficiency: 0.12, 'evaluation-benchmarks': 0.25, fairness: 0.06, 'federated-learning': 0.04, 'generative-models': 0.63, genomics: 0.01, graphs: 0.11, 'healthcare-bio': 0.01, 'human-ai': 0.06, interpretability: 0.14, llms: 0.21, 'math-reasoning': 0.07, multimodal: 0.9, neuroscience: 0.04, nlp: 0.07, optimization: 0.18, physics: 0.06, privacy: 0.04, probabilistic: 0.15, 'reinforcement-learning': 0.27, 'representation-learning': 0.22, 'research-practice': 0.05, robotics: 0.95, robustness: 0.34, 'safety-alignment': 0.13, 'science-applications': 0.02, 'speech-audio': 0.08, systems: 0.05, tabular: 0.05, theory: 0.09, 'time-series': 0.22, video: 0.34, vision: 0.78, 'vision-3d': 0.34, 'vision-humans': 0.03, 'world-models': 0.96 });

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
  check('the documented thresholds', TOPIC_MIN === 0.6 && TOPIC_FLOOR === 0.5 && TOPIC_MAX === 5);
  check('LfC: robotics alone — the conference name no longer reads as reinforcement learning',
    pickTopics(LFC).join(',') === 'robotics', pickTopics(LFC).join(','));
  check('AI4NA: two over the bar in probability order; 0.55 is in the band the bar drops',
    pickTopics(AI4NA).join(',') === 'genomics,healthcare-bio', pickTopics(AI4NA).join(','));
  check('WearableAI: one topic', pickTopics(WEARABLE).join(',') === 'vision');
  check('RegML: nothing over the bar, so the single best over the floor — and only that one',
    pickTopics(REGML).join(',') === 'fairness', pickTopics(REGML).join(','));
  check('the floor never adds to a list: with one topic over the bar, a 0.55 beside it stays out',
    pickTopics(noul({ a: 0.7, b: 0.55 })).join(',') === 'a');
  check('the cap keeps the five strongest of six (generative-models 0.63 is the one dropped)',
    pickTopics(DRIVINGWM).join(',') === 'world-models,robotics,multimodal,autonomous-driving,vision', pickTopics(DRIVINGWM).join(','));
  check('the cap is the cap: a lower bar on AI4NA still yields five',
    pickTopics(AI4NA, { min: 0.2 }).length === 5);
  check('below the floor means none, not the best of a bad set',
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
  const got = await askTopics(lfc, { ask: replay(LFC), topics, conferences });
  check('askTopics asks the topic questions over the entry state and applies the policy',
    got.join(',') === 'robotics'
      && seen[0].state.conference.full_name === 'Conference on Robot Learning'
      && Object.keys(seen[0].questions).length === topics.length - 1);

  const empty = await askTopics(lfc, { ask: replay(noul({ robotics: 0.31, vision: 0.31 })), topics, conferences });
  const silent = await askTopics(lfc, { ask: async () => null, topics, conferences });
  check('askTopics keeps the two apart: [] is "asked, nothing fits", null is "no answer"',
    Array.isArray(empty) && empty.length === 0 && silent === null);

  const rogue = await askTopics(lfc, { ask: replay({ ...LFC, 'not-a-topic': { type: 'noul', noul: 0.99 } }), topics, conferences });
  check('an answer under an id we never asked is dropped, never written',
    !rogue.includes('not-a-topic') && rogue[0] === 'robotics');
}

/* ------------------------------------- what an import writes, and the marker */
{
  const asked = topicsForImport(['robotics', 'agents'], ['agents']);
  check("an import Jev answered: Jev's list under the plain auto-suggested note",
    asked.topics.join() === 'robotics,agents' && asked.notes === AUTO_TOPICS_NOTE);
  const nothing = topicsForImport([], ['privacy']);
  check('asked and nothing fit: the keyword table, and STILL the plain note — that is a considered answer, not a debt',
    nothing.topics.join() === 'privacy' && nothing.notes === AUTO_TOPICS_NOTE);
  const silent = topicsForImport(null, ['vision']);
  check('Jev could not be asked: the keyword table, and the note says a judgment is still owed',
    silent.topics.join() === 'vision' && silent.notes === KEYWORD_TOPICS_NOTE && hasKeywordTopicsNote(silent.notes));
  check('the marker is an extra sentence on the auto note, so every reader of that note needs no change',
    KEYWORD_TOPICS_NOTE.startsWith(`${AUTO_TOPICS_NOTE} `) && hasAutoTopicsNote(KEYWORD_TOPICS_NOTE)
      && /auto-suggested and may be imprecise/.test(KEYWORD_TOPICS_NOTE));
  check('a judged entry is not owed one, and neither is a person\'s note that happens to quote the sentence',
    !hasKeywordTopicsNote(AUTO_TOPICS_NOTE) && !hasKeywordTopicsNote('They are a keyword match on the title.') && !hasKeywordTopicsNote(undefined));

  const later = `${KEYWORD_TOPICS_NOTE} Website removed on review — host stopped serving the page.`;
  check('once Jev has answered, the sentence comes off and nothing else moves',
    judgedTopicsNote(KEYWORD_TOPICS_NOTE) === AUTO_TOPICS_NOTE
      && judgedTopicsNote(later) === `${AUTO_TOPICS_NOTE} Website removed on review — host stopped serving the page.`
      && judgedTopicsNote(AUTO_TOPICS_NOTE) === AUTO_TOPICS_NOTE && judgedTopicsNote('mine') === 'mine');
  check('a person choosing the topics clears both sentences and keeps what is theirs',
    withoutAutoTopicsNote(KEYWORD_TOPICS_NOTE) === undefined
      && withoutAutoTopicsNote(later) === 'Website removed on review — host stopped serving the page.');
}

/* ------------------------------------------------- the retag decision ----- */
{
  const d = (stored, jev, kw, all) => retagDecision(stored, jev, kw, { all });
  check("default sweep: an `other` entry takes Jev's list", d(['other'], ['robotics'], ['other'], false)?.join() === 'robotics');
  check('default sweep: the keyword table when Jev has nothing', d(['other'], [], ['vision'], false)?.join() === 'vision'
    && d(['other'], null, ['vision'], false)?.join() === 'vision');
  check('default sweep: still `other` writes nothing', d(['other'], [], ['other'], false) === null);
  check('--all: a keyword-tagged entry is re-derived (LEAP was `agents` alone)',
    d(['agents'], ['robotics', 'agents'], ['agents'], true)?.join() === 'robotics,agents');
  check('--all: no answer leaves a judged entry exactly as it is — an outage never downgrades the corpus',
    d(['robotics', 'agents'], null, ['agents'], true) === null);
  check("--all: asked and nothing fits -> what an import would write, the keyword table's guess, `other` included",
    d(['systems'], [], ['other'], true)?.join() === 'other' && d(['other'], [], ['privacy'], true)?.join() === 'privacy');
  check('--all: an unchanged list is not rewritten, and order is part of the list',
    d(['robotics', 'agents'], ['robotics', 'agents'], ['agents'], true) === null
      && d(['agents', 'robotics'], ['robotics', 'agents'], ['agents'], true)?.join() === 'robotics,agents');
}

/* ---------------------------------------------------------- plumbing ------ */
{
  const discover = fs.readFileSync(path.join(ROOT, 'scripts', 'discover_openreview.mjs'), 'utf8');
  check('discovery asks Jev first, keeps the keyword table as the fallback, and records which one answered',
    /import \{[^}]*\baskTopics\b[^}]*\} from '\.\.\/lib\/jev_topics\.mjs'/.test(discover)
      && /topicsForImport\(await askTopics\([^)]*\), guessTopics\(/.test(discover)
      && /record\.topics = tagged\.topics;/.test(discover) && /record\.notes = tagged\.notes;/.test(discover));
  const retag = fs.readFileSync(path.join(ROOT, 'scripts', 'retag_topics.mjs'), 'utf8');
  check('the retag sweep asks Jev, keeps the table as the fallback, and leaves the policy to retagDecision',
    /askTopics\(/.test(retag) && /guessTopics\(/.test(retag) && /retagDecision\(/.test(retag));
  const appended = `${AUTO_TOPICS_NOTE} Website removed on review — host stopped serving the page.`;
  check('machine-made topics are recognised with a sentence appended to the note (28 entries read this way)',
    hasAutoTopicsNote(AUTO_TOPICS_NOTE) && hasAutoTopicsNote(appended));
  check('...and a person\'s own note, or one that merely quotes the sentence later on, is not',
    !hasAutoTopicsNote('This workshop focuses on efficient LLM reasoning.') && !hasAutoTopicsNote(`Curated. ${AUTO_TOPICS_NOTE}`) && !hasAutoTopicsNote(undefined));
  check('taking the sentence out keeps what followed it, and leaves nothing when nothing did',
    withoutAutoTopicsNote(appended) === 'Website removed on review — host stopped serving the page.'
      && withoutAutoTopicsNote(AUTO_TOPICS_NOTE) === undefined && withoutAutoTopicsNote('mine') === 'mine');
  check('the sweep keys on it, and takes --slug so a handful can be re-judged without paying for the corpus',
    /hasAutoTopicsNote\(raw\.notes\)/.test(retag) && /'--slug'/.test(retag));
  check('the sweep has a mode for entries still owed a judgment, settles their note, and stops when a whole batch goes unanswered',
    /'--pending'/.test(retag) && /pendingOnly && !hasKeywordTopicsNote\(raw\.notes\)/.test(retag)
      && /raw\.notes = judgedTopicsNote\(raw\.notes\)/.test(retag) && /answers\.every\(\(a\) => a === null\)/.test(retag)
      && /recordJevStatus\(/.test(retag));
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'discover.yml'), 'utf8');
  const crawl = wf.indexOf('- name: Discover venues');
  const heal = wf.indexOf('run: node scripts/retag_topics.mjs --pending ||');
  const publish = wf.indexOf('- name: Publish new/updated entries');
  check('the weekly discovery job heals the fallback on its own: after the crawl, before the publish, and never fatal',
    crawl !== -1 && heal > crawl && publish > heal);
  check('the discovery workflow passes the key (unset on a fork => keyword table, by design)',
    /TYPESAFE_API_KEY:\s*\$\{\{\s*secrets\.TYPESAFE_API_KEY\s*\}\}/.test(wf));
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'validate.yml'), 'utf8');
  check('CI runs this test', /jev_topics_test\.mjs/.test(ci), 'the workflow lists tests by hand');
}

console.log(failed === 0 ? '\nJev topic tagging OK.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
