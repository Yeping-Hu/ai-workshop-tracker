#!/usr/bin/env node
/**
 * The vocabulary's size rule (lib/topic_usage.mjs): a topic needs three
 * workshops, tracks of one workshop count once, and validate.mjs warns rather
 * than fails. Fixtures only — the live counts move with every edit, which is
 * exactly why the rule warns.
 *
 * Run: node scripts/topic_usage_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { topicUsage, thinTopics, TOPIC_MIN_WORKSHOPS } from '../lib/topic_usage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}

const topics = [{ id: 'graphs', label: 'Graphs' }, { id: 'vision', label: 'Computer vision' }, { id: 'unused', label: 'Unused' }, { id: 'other', label: 'Other' }];
const tracks = (...slugs) => slugs.map((slug) => ({ slug, topics: ['graphs'], relatedTracks: slugs.filter((s) => s !== slug).map((s) => ({ slug: s })) }));
const entries = [
  // one workshop in three tracks: one workshop, however many files it has
  ...tracks('neurips-2026-neurreps-extended-abstracts', 'neurips-2026-neurreps-findings', 'neurips-2026-neurreps-proceedings'),
  // the same series a year earlier is a different event, and counts
  { slug: 'neurips-2025-neurreps', topics: ['graphs', 'vision'], relatedTracks: [] },
  { slug: 'cvpr-2026-a', topics: ['vision'], relatedTracks: [] },
  { slug: 'cvpr-2026-b', topics: ['vision'] },
  { slug: 'icml-2026-c', topics: ['other'], relatedTracks: [] },
];

const usage = topicUsage(entries, topics);
check('the documented minimum', TOPIC_MIN_WORKSHOPS === 3);
check('three tracks of one workshop count once; another year counts again', usage.get('graphs') === 2, String(usage.get('graphs')));
check('an entry without relatedTracks is its own workshop', usage.get('vision') === 3, String(usage.get('vision')));
check('a topic nobody carries is counted as zero, not skipped', usage.get('unused') === 0);

const thin = thinTopics(entries, topics);
check('thin topics, thinnest first — and `other` is never one of them',
  thin.map((t) => `${t.id}:${t.workshops}`).join(',') === 'unused:0,graphs:2', JSON.stringify(thin));
check('a topic at the minimum is not thin', !thin.some((t) => t.id === 'vision'));
check('the minimum is a parameter, so the rule can be read at another bar', thinTopics(entries, topics, 4).some((t) => t.id === 'vision'));
check('an id outside the vocabulary is ignored here (validate.mjs reports it as the error it is)',
  topicUsage([{ slug: 'x', topics: ['nope'] }], topics).get('nope') === undefined);

const validate = fs.readFileSync(path.join(ROOT, 'scripts', 'validate.mjs'), 'utf8');
check('validate.mjs warns with it and never fails on it',
  /thinTopics\(/.test(validate) && /warnings\.push\([^)]*data\/topics\.yml/s.test(validate) && !/errors\.push\([^)]*thin/is.test(validate));
const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'validate.yml'), 'utf8');
check('CI runs this test', /topic_usage_test\.mjs/.test(ci), 'the workflow lists tests by hand');

console.log(failed === 0 ? '\nTopic usage OK.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
