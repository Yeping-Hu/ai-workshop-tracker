#!/usr/bin/env node
/**
 * The "Jev did not answer" issue names the workshops still waiting for a topic
 * judgment (scripts/waiting_topics.mjs). Two halves: the listing itself, on
 * fixtures; and the issue step of BOTH workflows that write that issue, run for
 * real — the JavaScript embedded in the YAML, against a mock client — because
 * whichever job runs last replaces the body, and a list only one of them knew
 * about would vanish the first time the other met the same dead key.
 *
 * Run: node scripts/waiting_topics_test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { waitingTopics, workshopPageUrl, renderWaitingTopics } from './waiting_topics.mjs';
import { AUTO_TOPICS_NOTE, KEYWORD_TOPICS_NOTE } from './discover_openreview.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}

/* ------------------------------------------------------------ the listing -- */
const conferences = [{ id: 'corl', name: 'CoRL' }, { id: 'neurips', name: 'NeurIPS' }];
const entries = [
  { slug: 'neurips-2026-judged', raw: { name: 'A Judged Workshop', conference: 'neurips', year: 2026, topics: ['llms'], notes: AUTO_TOPICS_NOTE } },
  { slug: 'corl-2026-leap', raw: { name: 'Learning Effective Abstractions for Planning', conference: 'corl', year: 2026, topics: ['agents'], notes: KEYWORD_TOPICS_NOTE } },
  { slug: 'neurips-2027-later', raw: { name: 'Next Year, With a Note Appended', conference: 'neurips', year: 2027, topics: ['vision', 'video'], notes: `${KEYWORD_TOPICS_NOTE} Website removed on review.` } },
  { slug: 'icml-2026-curated', raw: { name: 'Curated by a Person', conference: 'icml', year: 2026, topics: ['theory'] } },
  { slug: 'icml-2026-quotes-it', raw: { name: 'A Person Quoting the Sentence', conference: 'icml', year: 2026, topics: ['theory'], notes: 'They are a keyword match on the title.' } },
];
const waiting = waitingTopics(entries, conferences);
check('only entries whose note says a judgment is owed — appended sentences included, a person\'s own note never',
  waiting.map((w) => w.slug).join(',') === 'neurips-2027-later,corl-2026-leap', waiting.map((w) => w.slug).join(','));
check('newest conference-year first, and a conference by its display name ("CoRL", not the id upper-cased)',
  waiting[0].year === 2027 && waiting[1].conference === 'CoRL');
check('a conference missing from conferences.yml degrades to its id', waitingTopics([entries[1]])[0].conference === 'CORL');

check('a page URL under the site root', workshopPageUrl('x', { siteUrl: 'https://aiworkshoptracker.com', siteBase: '/' }) === 'https://aiworkshoptracker.com/workshop/x/');
check('...and under a project-pages base, however the slashes were typed',
  workshopPageUrl('x', { siteUrl: 'https://owner.github.io/', siteBase: 'repo' }) === 'https://owner.github.io/repo/workshop/x/'
    && workshopPageUrl('x', { siteUrl: 'https://owner.github.io', siteBase: '/repo/' }) === 'https://owner.github.io/repo/workshop/x/');
check('no site URL, no link — a fork still gets names and slugs', workshopPageUrl('x', {}) === null);

const section = renderWaitingTopics(waiting, { siteUrl: 'https://aiworkshoptracker.com', siteBase: '/' });
check('the section counts them, links each page, and shows the keyword tags they carry for now',
  /^### Workshops waiting for a topic judgment \(2\)/.test(section)
    && section.includes('[Learning Effective Abstractions for Planning](https://aiworkshoptracker.com/workshop/corl-2026-leap/) — CoRL 2026, `corl-2026-leap`; tagged `agents` for now')
    && section.includes('tagged `vision`, `video` for now'));
check('it says nothing needs doing per workshop, and gives the one command that brings it forward',
  /Nothing needs doing per workshop/.test(section) && section.includes('node scripts/retag_topics.mjs --pending'));
check('without a site URL the names are bold rather than linked', renderWaitingTopics(waiting).includes('- **Learning Effective Abstractions for Planning** — CoRL 2026'));
check('nobody waiting is a sentence, not silence — in an issue about failures it is the good news',
  /^No workshop is waiting for a topic judgment/.test(renderWaitingTopics([])));

/* ------------------------------------- the issue step, run for real, twice -- */
const require = createRequire(import.meta.url);
async function runIssueStep(workflow, { status, report, open = [] }) {
  const wf = yaml.load(fs.readFileSync(path.join(ROOT, '.github', 'workflows', workflow), 'utf8'));
  const steps = Object.values(wf.jobs)[0].steps;
  const names = steps.map((s) => s.name ?? s.uses);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'waiting-topics-'));
  const statusFile = path.join(tmp, 'jev-status.jsonl');
  fs.writeFileSync(statusFile, status.map((l) => JSON.stringify(l)).join('\n'));
  if (report != null) fs.writeFileSync(path.join(tmp, 'waiting-topics.md'), report);
  const calls = [];
  const github = { rest: { issues: {
    listForRepo: async () => ({ data: open }),
    create: async (a) => calls.push({ kind: 'create', ...a }),
    update: async (a) => calls.push({ kind: 'update', ...a }),
  } } };
  const step = steps[names.indexOf('Open or close the "Jev did not answer" issue')];
  const fn = new Function('github', 'context', 'process', 'require', `return (async () => { ${step.with.script} })()`);
  await fn(github, { repo: { owner: 'o', repo: 'r' }, workflow: wf.name }, { env: { JEV_STATUS: statusFile, RUNNER_TEMP: tmp } }, require);
  fs.rmSync(tmp, { recursive: true, force: true });
  return { calls, names, steps };
}

const deadKey = [{ job: 'discovery neurips 2026', requests: 3, failures: 2, error: 'HTTP 401 (invalid api key)' }];
for (const workflow of ['discover.yml', 'series-audit.yml']) {
  const { calls, names, steps } = await runIssueStep(workflow, { status: deadKey, report: `${section}\n` });
  const list = names.indexOf('List workshops still waiting for a topic judgment');
  const issue = names.indexOf('Open or close the "Jev did not answer" issue');
  check(`${workflow}: lists the waiting workshops just before it writes the issue, even after a failed step`,
    list !== -1 && list === issue - 1 && steps[list].if === 'always()'
      && /node scripts\/waiting_topics\.mjs --report "\$RUNNER_TEMP\/waiting-topics\.md"/.test(steps[list].run));
  check(`${workflow}: a dead key opens the issue with the error AND the workshops it left waiting`,
    calls.length === 1 && calls[0].kind === 'create' && calls[0].title === 'Data health: Jev did not answer'
      && calls[0].body.includes('HTTP 401 (invalid api key)') && calls[0].body.includes('### Workshops waiting for a topic judgment (2)')
      && calls[0].body.includes('https://aiworkshoptracker.com/workshop/corl-2026-leap/'), JSON.stringify(calls).slice(0, 200));

  const again = await runIssueStep(workflow, { status: deadKey, report: `${section}\n`, open: [{ number: 7, title: 'Data health: Jev did not answer' }] });
  check(`${workflow}: an issue already open is rewritten in place, list included — the other job's run must not erase it`,
    again.calls.length === 1 && again.calls[0].kind === 'update' && again.calls[0].issue_number === 7 && again.calls[0].body.includes('corl-2026-leap'));

  const noList = await runIssueStep(workflow, { status: deadKey, report: null });
  check(`${workflow}: if the listing never ran the issue is still written, just without a list`,
    noList.calls.length === 1 && !noList.calls[0].body.includes('waiting for a topic judgment'));

  const healthy = await runIssueStep(workflow, { status: [{ job: 'x', requests: 9, failures: 0, error: null }], report: `${renderWaitingTopics([])}\n`, open: [{ number: 7, title: 'Data health: Jev did not answer' }] });
  check(`${workflow}: a run in which every request succeeded closes it, and writes nothing else`,
    healthy.calls.length === 1 && healthy.calls[0].state === 'closed' && healthy.calls[0].body === undefined);
}

const discoverText = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'discover.yml'), 'utf8');
check('discover.yml no longer tells the maintainer to run the sweep by hand — the job does it, and the issue says so',
  !/gives the ones left as `other` real topics/.test(discoverText) && /nothing needs doing per workshop/.test(discoverText));
check('...and in that job the listing reads the tree the --pending sweep left, so it comes after the sweep',
  discoverText.indexOf('retag_topics.mjs --pending ||') < discoverText.indexOf('waiting_topics.mjs --report'));

const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'validate.yml'), 'utf8');
check('CI runs this test', /waiting_topics_test\.mjs/.test(ci), 'the workflow lists tests by hand');

console.log(failed === 0 ? '\nWaiting-topics report OK.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
