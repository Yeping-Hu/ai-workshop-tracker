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
import { guessTopics } from './discover_openreview.mjs';

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

// genuinely opaque -> still other
eq('opaque acronym -> other', 'MARINE', ['other']);
eq('cross-cutting question -> other', 'Rediscovering Intelligence: Can AI Still Learn from Humans?', ['other']);

console.log(failed === 0 ? '\nTopic matcher OK.' : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
