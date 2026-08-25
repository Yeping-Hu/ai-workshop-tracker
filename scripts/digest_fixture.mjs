#!/usr/bin/env node
/**
 * Render ONE fixed digest fixture, so two renderers can be compared with the
 * code as the only variable.
 * Run: node scripts/digest_fixture.mjs [path/to/render.mjs] [out-basename]
 *
 * Why a committed fixture rather than a screenshot in a PR: a reviewer has to
 * be able to reproduce the "before". Point the first argument at another
 * worktree and the same subscriber, the same events and the same nowMs go
 * through that checkout's renderer:
 *
 *   git worktree add /tmp/base origin/main
 *   node scripts/digest_fixture.mjs /tmp/base/alerts/render.mjs before
 *   node scripts/digest_fixture.mjs                            after
 *   git worktree remove /tmp/base
 *
 * The fixture is chosen to exercise the display rule at both extremes: two
 * pseudo-acronyms that must disappear (NeurReps_Extended_Abstracts,
 * Contact-Rich_Loco-Manipulation), a real one that must survive (DOM-R3), one
 * carrying a year that must be stripped (NLPOR 2026), and a sibling track that
 * must keep its disambiguating suffix (CVEU / Extended Abstract Track).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Which renderer to exercise. Defaults to this checkout's; point it at another
// worktree to produce the "before" side:
//   git worktree add /tmp/base origin/main
//   node scripts/digest_fixture.mjs /tmp/base/alerts/render.mjs out-before
const rendererArg = process.argv[2] || path.join(HERE, '..', 'alerts', 'render.mjs');
const outName = process.argv[3] || 'digest-fixture';
const { renderDigest } = await import(path.resolve(rendererArg));

const NOW = Date.parse('2026-08-25T09:00:00Z');
const at = (d, h = 23, m = 59) =>
  new Date(Date.UTC(2026, 7, 25 + d, h, m, 0)).toISOString();

const ids = {
  conferences: [
    { id: 'neurips', label: 'NeurIPS' }, { id: 'iros', label: 'IROS' },
    { id: 'corl', label: 'CoRL' }, { id: 'cvpr', label: 'CVPR' },
  ],
  topics: [{ id: 'llms', label: 'LLMs' }, { id: 'robotics', label: 'Robotics' }],
};

const mk = (slug, name, acronym, conference, day, over = {}) => ({
  slug, name, acronym, conference, year: 2026, topics: ['llms'],
  status: 'upcoming', deadline_utc: at(day), next_stage_utc: at(day),
  next_stage_is_abstract: false, website: 'https://example.com', track_label: null, ...over,
});

// The two lines the review must look at, plus enough around them to show the
// layout: a pseudo-acronym that must vanish, a real acronym that must survive.
const workshops = {
  'neurips-2026-neurreps': mk('neurips-2026-neurreps',
    'Symmetry and Geometry in Neural Representations', 'NeurReps_Extended_Abstracts', 'neurips', 12),
  'iros-2026-domr3': mk('iros-2026-domr3',
    'Dexterous Object Manipulation', 'DOM-R3', 'iros', 3),
  'neurips-2026-nlpor': mk('neurips-2026-nlpor',
    'Bridging NLP and Public Opinion Research', 'NLPOR 2026', 'neurips', 0),
  'corl-2026-contact': mk('corl-2026-contact',
    'Open Problems in Contact-Rich Loco-Manipulation', 'Contact-Rich_Loco-Manipulation', 'corl', 6),
  'cvpr-2026-cveu': mk('cvpr-2026-cveu',
    'AI for Creative Visual Content Generation Editing and Understanding', 'CVEU', 'cvpr', 9,
    { track_label: 'Extended Abstract Track' }),
  'iros-2026-abstract': mk('iros-2026-abstract',
    'Scalable Tactile Manipulation', 'Scalable_Tactile_Manipulation', 'iros', 4,
    { next_stage_is_abstract: true }),
};

const events = [
  { slug: 'neurips-2026-neurreps', kind: 'extended', days: 5, old_utc: at(7), new_utc: at(12) },
  { slug: 'corl-2026-contact', kind: 'extended', days: 3, old_utc: at(3), new_utc: at(6) },
  { slug: 'cvpr-2026-cveu', kind: 'earlier', days: 2, old_utc: at(11), new_utc: at(9) },
  { slug: 'iros-2026-domr3', kind: 'deadline_announced', days: null, old_utc: null, new_utc: at(3) },
  { slug: 'neurips-2026-nlpor', kind: 'announced', days: null, old_utc: null, new_utc: at(0) },
];

const sub = {
  email: 'reviewer@example.com', nonce: 'n', cadence: 'weekly', confirmed_at: 'x',
  conferences: [], topics: [], scope: 'all',
  starred_ws: ['iros-2026-domr3', 'iros-2026-abstract'], starred_papers: [],
  tz: 'America/Los_Angeles',
};

const args = { sub, tz: sub.tz, events, workshops, nowMs: NOW, ids,
  manageUrl: 'https://aiworkshoptracker.com/alerts/manage/',
  unsubUrl: 'https://aiworkshoptracker.com/alerts/unsubscribe/' };

const out = renderDigest({ ...args });
fs.writeFileSync(`${outName}.html`, out.html);
fs.writeFileSync(`${outName}.txt`, out.text);
console.log(`renderer: ${path.resolve(rendererArg)}`);
console.log(`subject : ${out.subject}`);
console.log(`bytes   : ${Buffer.byteLength(out.html)} html, ${Buffer.byteLength(out.text)} text`);
console.log(`wrote   : ${outName}.html, ${outName}.txt`);
