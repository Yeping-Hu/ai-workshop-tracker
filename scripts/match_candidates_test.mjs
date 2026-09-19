#!/usr/bin/env node
/**
 * The matcher's candidate feed (lib/match_candidates.mjs): open calls only,
 * past titles drawn from the series newest-first and capped, honest counts for
 * a first edition, the vocabulary alongside, and the board's order.
 *
 * Run: node scripts/match_candidates_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMatchCandidates, PAST_TITLES_MAX } from '../lib/match_candidates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}

const TOPICS = [
  { id: 'robotics', label: 'Robotics', description: 'robotics: robot learning' },
  { id: 'llms', label: 'Large language models', description: 'large language models' },
  { id: 'other', label: 'Other' },
];
const CONFS = new Map([
  ['neurips', { id: 'neurips', name: 'NeurIPS', full_name: 'Conference on Neural Information Processing Systems' }],
  ['corl', { id: 'corl', name: 'CoRL', full_name: 'Conference on Robot Learning' }],
]);
const W = [
  // An open call in its third year: two tracked editions with papers.
  { slug: 'neurips-2026-mathai', name: 'Math-AI', acronym: 'MATH-AI', conference: 'neurips', year: 2026, topics: ['llms'], website: 'https://mathai-2026.github.io/', status: 'upcoming', deadlineIso: '2026-10-02T12:00:00.000Z', deadlineWallClock: 'Oct 2, 2026, 12:00 UTC', relatedEditions: [{ slug: 'neurips-2024-mathai' }, { slug: 'neurips-2025-mathai' }] },
  { slug: 'neurips-2025-mathai', name: 'Math-AI', conference: 'neurips', year: 2025, topics: ['llms'], status: 'past', relatedEditions: [{ slug: 'neurips-2026-mathai' }, { slug: 'neurips-2024-mathai' }] },
  { slug: 'neurips-2024-mathai', name: 'Math-AI', conference: 'neurips', year: 2024, topics: ['llms'], status: 'past', relatedEditions: [{ slug: 'neurips-2026-mathai' }, { slug: 'neurips-2025-mathai' }] },
  // A first edition: open, no series, no papers.
  { slug: 'corl-2026-newws', name: 'Brand New Robotics Workshop', conference: 'corl', year: 2026, topics: ['robotics', 'other'], status: 'upcoming', deadlineIso: '2026-09-25T00:00:00.000Z', deadlineWallClock: 'Sep 25, 2026, 00:00 UTC', relatedEditions: [] },
  // Open with no deadline announced yet.
  { slug: 'corl-2026-tba', name: 'TBA Workshop', conference: 'corl', year: 2026, topics: ['robotics'], status: 'upcoming', deadlineIso: null, deadlineWallClock: null, relatedEditions: [] },
  // Never candidates.
  { slug: 'corl-2026-dead', name: 'Not Running', conference: 'corl', year: 2026, topics: ['robotics'], status: 'not_running', relatedEditions: [] },
  { slug: 'corl-2025-past', name: 'Closed', conference: 'corl', year: 2025, topics: ['robotics'], status: 'past', relatedEditions: [] },
];
const PAPERS = {
  'neurips-2025-mathai': { paper_count: 20, papers: Array.from({ length: 20 }, (_, i) => ({ title: `2025 paper ${i + 1}` })) },
  'neurips-2024-mathai': { paper_count: 3, papers: [{ title: '2024 paper 1' }, { title: '2024 paper 2' }, { title: '2024 paper 3' }] },
};
const built = buildMatchCandidates(W, {
  paperCache: (slug) => PAPERS[slug] ?? null,
  conferenceById: CONFS,
  topics: TOPICS,
  shortName: (w) => w.acronym || w.name,
  href: (p) => `/base${p}`,
});
const by = new Map(built.candidates.map((c) => [c.slug, c]));

check('only open calls are candidates: not the past, not a not-running edition',
  built.count === 3 && [...by.keys()].sort().join(',') === 'corl-2026-newws,corl-2026-tba,neurips-2026-mathai');
check('soonest deadline first, unannounced last (the board\'s order)',
  built.candidates.map((c) => c.slug).join(',') === 'corl-2026-newws,neurips-2026-mathai,corl-2026-tba');

const m = by.get('neurips-2026-mathai');
check('past titles come from the series, newest edition first, capped',
  m.past_titles.length === PAST_TITLES_MAX && m.past_titles[0] === '2025 paper 1' && !m.past_titles.includes('2024 paper 1'),
  `${m.past_titles.length} titles, first "${m.past_titles[0]}"`);
check('...while the count covers every paper the series has', m.past_paper_count === 23 && m.editions === 2);
check('identity, topics with labels, deadline and links travel with it',
  m.short_name === 'MATH-AI' && m.conference.name === 'NeurIPS' && m.conference.full_name.startsWith('Conference on Neural')
    && m.topics[0].label === 'Large language models' && m.deadline_utc === '2026-10-02T12:00:00.000Z'
    && m.url === '/base/workshop/neurips-2026-mathai/' && m.website === 'https://mathai-2026.github.io/');

const n = by.get('corl-2026-newws');
check('a first edition says so: no titles, zero past papers, zero editions',
  n.past_titles.length === 0 && n.past_paper_count === 0 && n.editions === 0);
check('an unannounced deadline is null, not a string',
  by.get('corl-2026-tba').deadline_utc === null && by.get('corl-2026-tba').deadline_wall_clock === null);
check('the vocabulary travels with the candidates, descriptions included, `other` excluded',
  built.topics.length === 2 && built.topics.every((t) => t.description) && !built.topics.some((t) => t.id === 'other'));

const spread = buildMatchCandidates(
  [{ ...W[0], relatedEditions: [{ slug: 'neurips-2024-mathai' }] }, W[2]],
  { paperCache: (slug) => PAPERS[slug] ?? null, conferenceById: CONFS, topics: TOPICS, shortName: (w) => w.name },
);
check('with fewer titles than the cap, every one is kept',
  spread.candidates[0].past_titles.length === 3 && spread.candidates[0].url === '/workshop/neurips-2026-mathai/');

/* ---------------------------------------------------------- plumbing ------ */
{
  const route = fs.readFileSync(path.join(ROOT, 'site', 'src', 'pages', 'api', 'match-candidates.json.ts'), 'utf8');
  check('the API route is built from this module and nothing else', /buildMatchCandidates\(/.test(route) && /match_candidates\.mjs/.test(route));
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'validate.yml'), 'utf8');
  check('CI runs this test', /match_candidates_test\.mjs/.test(ci), 'the workflow lists tests by hand');
}

console.log(failed === 0 ? '\nMatch candidates OK.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
