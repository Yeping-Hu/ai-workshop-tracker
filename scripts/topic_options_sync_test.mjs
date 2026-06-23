#!/usr/bin/env node
/**
 * Guard: the "Topics" dropdowns in the issue forms must match data/topics.yml.
 * Because the templates are static YAML, the option list is generated into them
 * by scripts/gen_topic_options.mjs. This fails if someone edited topics.yml (or
 * a template) without regenerating, so the forms can never offer a stale or
 * misspelled topic set.
 *
 * Run: node scripts/topic_options_sync_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { TEMPLATES, topicOptionLines, extractBetweenMarkers } from './gen_topic_options.mjs';

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `  (${detail})`}`);
}

const expected = topicOptionLines();
check('topics.yml is non-empty', expected.length > 0, `${expected.length} topics`);

for (const file of TEMPLATES) {
  const rel = path.relative(process.cwd(), file);
  const content = fs.readFileSync(file, 'utf8');
  const between = extractBetweenMarkers(content);
  if (between === null) {
    check(`${rel}: has topic-options markers`, false, 'start/end markers not found');
    continue;
  }
  const same = between.length === expected.length && between.every((l, i) => l === expected[i]);
  check(
    `${rel}: topic options match data/topics.yml`,
    same,
    same ? '' : 'out of sync — run `node scripts/gen_topic_options.mjs`',
  );
}

console.log(
  failed === 0
    ? '\nIssue-form topic options are in sync with data/topics.yml.'
    : `\n${failed} check(s) failed. Run: node scripts/gen_topic_options.mjs`,
);
process.exit(failed === 0 ? 0 : 1);
