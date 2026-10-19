#!/usr/bin/env node
/**
 * The "New since the last run" pings on the three data-health issues, and
 * hiding them once everything they announced has left the issue
 * (scripts/issue_pings.mjs).
 *
 * Two halves. The rules, on fixtures built by the real report builders: what
 * counts as an item on each issue, which comments are pings, which pings are
 * resolved. Then the issue step of all three workflows, run for real (the
 * JavaScript embedded in the YAML, against a mock client), because that is
 * where a ping is posted and where it must later be hidden. The pings fed back
 * in are the ones the workflow itself just posted, so the parser is tested
 * against the format the workflows actually write.
 *
 * Run: node scripts/issue_pings_test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import {
  PING_HEAD,
  deadlineReviewItems,
  officialListItems,
  editionsReviewItems,
  pingItems,
  resolvedPings,
  hideResolvedPings,
} from './issue_pings.mjs';
import { buildReport } from './deadline_crosscheck.mjs';
import { buildEditionsReport } from './sync_editions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
function check(label, got, expect) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(expect)})`}`);
}
const sorted = (set) => [...set].sort();

/* ------------------------------------------------------ what an item is -- */
const row = (slug) => ({
  kind: 'human-conflict', slug, file: `data/workshops/${slug}.yml`, name: slug, conf: 'NEURIPS', year: 2026,
  stored: '2026-08-24 11:59', fetched: '2026-08-31 12:00', label: 'differs by 7.00d',
});
const unchecked = [{
  file: 'data/workshops/neurips-2026-unread.yml', name: 'Unread', conf: 'NEURIPS', year: 2026,
  venueId: 'NeurIPS.cc/2026/Workshop/Unread', reason: 'venue group could not be fetched',
}];
const deadlines = buildReport([row('neurips-2026-a'), row('neurips-2026-b')], [], [], unchecked);
check('deadline review: the entries on review rows, not the run\'s "could not be checked" rows',
  sorted(deadlineReviewItems(deadlines)), ['data/workshops/neurips-2026-a.yml', 'data/workshops/neurips-2026-b.yml']);
check('...and a box somebody ticked is still its row',
  sorted(deadlineReviewItems(deadlines.replace('- [ ]', '- [x]'))), ['data/workshops/neurips-2026-a.yml', 'data/workshops/neurips-2026-b.yml']);

const LIST_URL = 'https://blog.iclr.cc/2027/01/10/iclr-2027-workshops/';
const officialList =
  '### Title or website differs from the official list\n\n' +
  '- [ ] `data/workshops/neurips-2026-x.yml` — **X** (NeurIPS 2026) — name\n\n' +
  '### Candidate official list found\n\n' +
  `- [ ] **ICLR 2027** — [Workshops](${LIST_URL})\n` +
  `      - Adopt it by adding \`workshop_list_url: "${LIST_URL}"\` to the \`iclr 2027\` row of \`data/editions.yml\`.\n`;
check('official list: entry files and candidate list URLs',
  sorted(officialListItems(officialList)), ['data/workshops/neurips-2026-x.yml', `workshop_list_url: "${LIST_URL}"`]);

const editions = buildEditionsReport([
  { kind: 'rate-missing', conf: 'icml', years: [2025] },
  { kind: 'rate-missing', conf: 'corl', years: [2024, 2025] },
]);
check('editions: the keys the report carries in its trailing comment',
  sorted(editionsReviewItems(editions)), ['rate-missing:corl-2024+2025', 'rate-missing:icml-2025']);
check('no report, no items', [deadlineReviewItems('').size, officialListItems(null).size, editionsReviewItems(undefined).size], [0, 0, 0]);

/* ------------------------------------------------- pings, and which go -- */
const ping = (...items) => `${PING_HEAD}${items.length} items:\n\n${items.map((i) => `- \`${i}\``).join('\n')}\n\nSee the issue body above.`;
check('a ping\'s items, one per line', pingItems(ping('a', 'workshop_list_url: "https://x.example/"')), ['a', 'workshop_list_url: "https://x.example/"']);
check('anything else is not a ping', pingItems('Nothing is left to review; closed automatically.'), null);

const bot = (id, body, isMinimized = false) => ({ id, body, isMinimized, author: { login: 'github-actions' } });
const open = new Set(['b', 'c']);
const comments = [
  bot('gone', ping('a')),
  bot('partly-open', ping('a', 'b')),
  bot('open', ping('c')),
  bot('already-hidden', ping('a'), true),
  bot('not-a-ping', 'Nothing is left to review; closed automatically by the `sync-editions` workflow.'),
  { id: 'human', body: ping('a'), isMinimized: false, author: { login: 'Yeping-Hu' } },
  { id: 'rest-shaped', body: ping('a'), isMinimized: false, author: { login: 'github-actions[bot]' } },
  bot('unknown-format', `${PING_HEAD}something new\n\nno list here`),
];
check('only the bot\'s pings with no item still open, not yet hidden',
  resolvedPings(comments, open).map((c) => c.id), ['gone', 'rest-shaped']);

/* -------------------------------------------- hiding, and its refusals -- */
function mockGithub({ pages, refuse = false, listFails = false }) {
  const hidden = [];
  let page = 0;
  return {
    hidden,
    graphql: async (query, vars) => {
      if (/minimizeComment/.test(query)) {
        if (refuse) throw new Error('Resource not accessible by integration');
        hidden.push(vars.id);
        return { minimizeComment: { minimizedComment: { isMinimized: true } } };
      }
      if (listFails) throw new Error('HTTP 502');
      const nodes = pages[page] ?? [];
      const hasNextPage = page < pages.length - 1;
      page++;
      return { repository: { issue: { comments: { pageInfo: { hasNextPage, endCursor: hasNextPage ? `c${page}` : null }, nodes } } } };
    },
  };
}
const quiet = { log: () => {} };
{
  const gh = mockGithub({ pages: [[bot('p1', ping('a'))], [bot('p2', ping('a')), bot('p3', ping('b'))]] });
  const n = await hideResolvedPings({ github: gh, owner: 'o', repo: 'r', issueNumber: 29, open, ...quiet, warn: () => {} });
  check('every page of comments is read, and every resolved ping hidden', [n, gh.hidden], [2, ['p1', 'p2']]);

  const warnings = [];
  const refusing = mockGithub({ pages: [[bot('p1', ping('a')), bot('p2', ping('a'))]], refuse: true });
  const r = await hideResolvedPings({ github: refusing, owner: 'o', repo: 'r', issueNumber: 29, open, ...quiet, warn: (m) => warnings.push(m) });
  check('a refusal hides nothing, says so once, and does not throw', [r, warnings.length, /refused/.test(warnings[0])], [0, 1, true]);

  const listWarn = [];
  const down = await hideResolvedPings({ github: mockGithub({ pages: [], listFails: true }), owner: 'o', repo: 'r', issueNumber: 29, open, ...quiet, warn: (m) => listWarn.push(m) });
  check('a listing that fails is a warning too', [down, listWarn.length], [0, 1]);

  const noGraphql = await hideResolvedPings({ github: {}, owner: 'o', repo: 'r', issueNumber: 29, open, ...quiet, warn: () => {} });
  check('even a client with no GraphQL at all only warns', noGraphql, 0);
}

/* ------------------------- the three workflows' issue steps, run for real -- */
const require = createRequire(import.meta.url);
process.env.GITHUB_WORKSPACE = ROOT; // the steps import the module from the checkout
async function runStep(workflow, stepName, reportFile, { report, issue = null, comments = [], refuse = false }) {
  const wf = yaml.load(fs.readFileSync(path.join(ROOT, '.github', 'workflows', workflow), 'utf8'));
  const step = Object.values(wf.jobs)[0].steps.find((s) => s.name === stepName);
  if (!step) throw new Error(`${workflow}: no step named "${stepName}"`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-pings-'));
  if (report != null) fs.writeFileSync(path.join(dir, reportFile), report);
  const calls = [];
  const out = [];
  const github = {
    rest: { issues: {
      listForRepo: async () => ({ data: issue ? [issue] : [] }),
      create: async (a) => calls.push({ kind: 'create', ...a }),
      update: async (a) => calls.push({ kind: a.state === 'closed' ? 'close' : 'update', ...a }),
      createComment: async (a) => calls.push({ kind: 'comment', ...a }),
    } },
    graphql: async (query, vars) => {
      if (/minimizeComment/.test(query)) {
        if (refuse) throw new Error('Resource not accessible by integration');
        calls.push({ kind: 'hide', id: vars.id });
        return { minimizeComment: { minimizedComment: { isMinimized: true } } };
      }
      return { repository: { issue: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: comments } } } };
    },
  };
  const cwd = process.cwd();
  const log = console.log;
  process.chdir(dir);
  console.log = (...a) => out.push(a.join(' '));
  try {
    const fn = new Function('github', 'context', 'require', `return (async () => { ${step.with.script} })()`);
    await fn(github, { repo: { owner: 'o', repo: 'r' } }, require);
  } finally {
    console.log = log;
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { calls, out: out.join('\n') };
}

const ISSUES = [
  {
    workflow: 'deadline-review.yml', step: 'Create/update the consolidated issue', file: 'deadline-review.md',
    title: 'Data health: deadlines to review',
    report: (...slugs) => buildReport(slugs.map(row)),
    item: (slug) => `data/workshops/${slug}.yml`,
  },
  {
    workflow: 'official-list-check.yml', step: 'Create/update the consolidated issue', file: 'official-list.md',
    title: 'Data health: workshops not on the official list',
    report: (...slugs) => '### Title or website differs from the official list\n\n' +
      slugs.map((s) => `- [ ] \`data/workshops/${s}.yml\` — **${s}** (NeurIPS 2026) — name`).join('\n') + '\n',
    item: (slug) => `data/workshops/${slug}.yml`,
  },
  {
    workflow: 'sync-editions.yml', step: 'Create/update the review issue', file: 'editions-review.md',
    title: 'Data health: conference editions to review',
    report: (...slugs) => buildEditionsReport(slugs.map((s) => ({ kind: 'rate-missing', conf: s, years: [2025] }))),
    item: (slug) => `rate-missing:${slug}-2025`,
  },
];

for (const t of ISSUES) {
  const W = t.workflow;
  // Day 1: A and B are open; the issue has no pings yet. Day 2 adds C. The
  // pings each day posts are captured and fed back in, as GitHub would.
  const day1 = t.report('neurips-2026-a', 'neurips-2026-b');
  const first = await runStep(W, t.step, t.file, { report: t.report('neurips-2026-a', 'neurips-2026-b', 'neurips-2026-c'), issue: { number: 7, title: t.title, body: day1 } });
  const firstPing = first.calls.find((c) => c.kind === 'comment')?.body ?? '';
  check(`${W}: an item that appears is pinged, and the ping names it`, pingItems(firstPing), [t.item('neurips-2026-c')]);

  // Day 3: A and C have resolved, B is still open, D is new. Earlier pings on
  // the issue: one about A alone (resolved), one about B and C (B still open),
  // yesterday's about C (resolved), a person's comment, and one already hidden.
  const yesterday = t.report('neurips-2026-a', 'neurips-2026-b', 'neurips-2026-c');
  const earlier = [
    bot('ping-a', ping(t.item('neurips-2026-a'))),
    bot('ping-b-and-c', ping(t.item('neurips-2026-b'), t.item('neurips-2026-c'))),
    bot('ping-c', firstPing),
    { id: 'person', body: ping(t.item('neurips-2026-a')), isMinimized: false, author: { login: 'Yeping-Hu' } },
    bot('hidden-already', ping(t.item('neurips-2026-a')), true),
  ];
  const third = await runStep(W, t.step, t.file, { report: t.report('neurips-2026-b', 'neurips-2026-d'), issue: { number: 7, title: t.title, body: yesterday }, comments: earlier });
  check(`${W}: the body is rewritten, D is pinged, and only the pings with nothing left open are hidden`,
    third.calls.map((c) => c.kind === 'hide' ? `hide:${c.id}` : c.kind), ['update', 'comment', 'hide:ping-a', 'hide:ping-c']);

  // GitHub refuses to hide (the token may not be allowed to): the run's real
  // work still happens, and the refusal is a warning, not a failure.
  const refused = await runStep(W, t.step, t.file, { report: t.report('neurips-2026-b', 'neurips-2026-d'), issue: { number: 7, title: t.title, body: yesterday }, comments: earlier, refuse: true });
  check(`${W}: a refused hide still updates and pings, and only warns`,
    [refused.calls.map((c) => c.kind), /::warning::GitHub refused to hide/.test(refused.out)], [['update', 'comment'], true]);

  // Nothing left: the issue closes, and every ping on it is resolved.
  const closing = await runStep(W, t.step, t.file, { report: '', issue: { number: 7, title: t.title, body: yesterday }, comments: earlier });
  check(`${W}: closing hides every ping still showing`,
    closing.calls.filter((c) => c.kind === 'close' || c.kind === 'hide').map((c) => c.kind === 'hide' ? `hide:${c.id}` : c.kind),
    ['close', 'hide:ping-a', 'hide:ping-b-and-c', 'hide:ping-c']);
}

const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'validate.yml'), 'utf8');
check('CI runs this test', /issue_pings_test\.mjs/.test(ci), true);

console.log(failed === 0 ? '\nData-health pings OK.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
