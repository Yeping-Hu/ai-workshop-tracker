#!/usr/bin/env node
/**
 * Locks in the broadened topic keyword matcher (guessTopics in
 * discover_openreview.mjs). These are titles that the previous narrow matcher
 * sent to 'other' but which clearly belong to a real topic — plus a couple of
 * genuinely-unclassifiable titles that must still fall back to 'other'.
 * Asserts the EXPECTED topic is among the (≤3) returned, not an exact set.
 *
 * Run: node scripts/topics_guess_test.mjs
 */
import { guessTopics, TOPIC_KEYWORDS } from './discover_openreview.mjs';
import { loadTopics } from '../lib/workshops.mjs';

let failed = 0;
function has(label, title, expected) {
  const got = guessTopics(title);
  const ok = got.includes(expected);
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}: [${got.join(', ')}]${ok ? '' : `  (expected to include ${expected})`}`);
}
function eq(label, title, expectedArr) {
  const got = guessTopics(title);
  const ok = JSON.stringify(got) === JSON.stringify(expectedArr);
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}: [${got.join(', ')}]${ok ? '' : `  (expected [${expectedArr.join(', ')}])`}`);
}

// vision phrasings the old matcher missed
has('manipulation+control -> robotics', 'Dexterous Manipulation: Learning and Control', 'robotics');
has('humanoid/bimanual -> robotics', 'Whole-body Control and Bimanual Manipulation: Humanoids', 'robotics');
has('autonomous driving -> robotics', '8th Workshop on Autonomous Driving', 'robotics');
has('"visual" -> vision', 'Second Workshop on Visual Concepts', 'vision');
has('cameras/perception -> vision', 'Perception Beyond the Visible Spectrum', 'vision');
has('neural fields -> vision', 'Neural Fields Beyond Conventional Cameras', 'vision');
has('structure-from-motion -> vision', 'Structure-from-Motion in the Age of Deep Learning', 'vision');
has('reconstruction -> vision', 'Reconstruction of Human-Object Interactions', 'vision');
// nlp / llms
has('tokenization -> nlp', 'Second Tokenization Workshop', 'nlp');
has('multilingual -> nlp', 'First Workshop on Multilingual Data Quality Signals', 'nlp');
has('foundation model -> llms', 'Foundation Models for General CT Image Diagnosis', 'llms');
// interpretability / agents / science
has('model internals -> interpretability', 'Interplay of Model Behavior and Model Internals', 'interpretability');
has('planning -> agents', 'Learning Effective Abstractions for Planning', 'agents');
has('materials discovery -> AI for science', 'Machine Learning for Materials Discovery', 'science-applications');
// robustness (previously had NO keyword at all)
has('test-time adaptation -> robustness', 'Test-Time Adaptation: Model, Adapt Thyself!', 'robustness');
// challenges still get a benchmark tag (plus their domain)
has('challenge -> evaluation-benchmarks', 'Autonomous Grand Challenge 2024', 'evaluation-benchmarks');

// regressions: core mappings still work
has('llm still maps', 'Workshop on Large Language Models', 'llms');
has('robot still maps', 'Workshop on Robot Learning', 'robotics');

// the topics added 2026-09-19: the table is the fallback for the WHOLE vocabulary
has('autonomous driving -> its own topic too', '8th Workshop on Autonomous Driving', 'autonomous-driving');
has('world models', 'Bringing Physics Simulation and World Models Together for Robotics', 'world-models');
has('gaussian splatting -> 3D vision', 'Workshop on Gaussian Splatting and Neural Rendering', 'vision-3d');
has('faces and biometrics', 'Workshop on Face Anti-Spoofing and Biometrics', 'vision-humans');
has('video', 'Long-Form Video Understanding', 'video');
has('creative AI', 'The 4th AI for Visual Arts Workshop', 'creative-ai');
has('code', 'Third Workshop on Deep Learning for Code', 'code');
has('economics', 'AI for Mechanism Design and Strategic Decision Making', 'economics');
has('affinity', 'LatinX in AI Workshop', 'affinity');
has('probabilistic', 'Bayesian Decision-making and Uncertainty', 'probabilistic');
has('representation learning', 'Unifying Representations in Neural Models', 'representation-learning');
has('continual learning', 'Workshop on Continual Learning in Computer Vision', 'continual-learning');
has('human-AI interaction', 'Human-AI Coevolution', 'human-ai');
has('research practice', 'Championing Open-source Development in ML', 'research-practice');

// the table and the vocabulary cover each other, so a topic added to one and
// not the other fails here rather than silently never being assigned
{
  const vocab = new Set(loadTopics().map((t) => t.id).filter((id) => id !== 'other'));
  const table = new Set(TOPIC_KEYWORDS.map(([, id]) => id));
  const noLine = [...vocab].filter((id) => !table.has(id));
  const noTopic = [...table].filter((id) => !vocab.has(id));
  const ok = noLine.length === 0 && noTopic.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} every topic has a keyword line, and every line names a topic${ok ? '' : `  (no line: ${noLine.join(', ') || '-'}; no topic: ${noTopic.join(', ') || '-'})`}`);
}

// genuinely opaque -> still other
eq('opaque acronym -> other', 'MARINE', ['other']);
eq('cross-cutting question -> other', 'Rediscovering Intelligence: Can AI Still Learn from Humans?', ['other']);

console.log(failed === 0 ? '\nTopic matcher OK.' : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
