#!/usr/bin/env node
/**
 * What the search index actually contains — checked against the built Pagefind
 * fragments, corpus-wide, from the data.
 *
 * Pagefind indexes whatever text sits inside `[data-pf-ws]` / `[data-pf-papers]`
 * on each workshop page, and three things silently ruined that for every page:
 *
 *   1. Astro drops whitespace-only text between sibling elements and Pagefind
 *      adds a word boundary only at block elements, so the badge, pill and
 *      chips ran together in the indexed text ("ICRA 2026PastMultimodal") and
 *      every <dt> label onto its <dd> ("LocationVienna, AustriaSubmission
 *      portal"). Pagefind's segmenter still found the words, but the excerpt
 *      under every result is cut from that text, so that is what readers saw,
 *      and nonsense prefixes such as "2026past" matched hundreds of pages.
 *   2. Page chrome and machine-written notes were indexed on every page: the
 *      link row ("Copy as Markdown" matched all 938 workshops and filled the
 *      excerpts), the importer's "topics were auto-suggested … imprecise" note
 *      (927), its deadline stamp.
 *   3. The papers index carried no `topic` filter, so a Topic facet plus a
 *      keyword returned zero papers with no signal (`llm` alone: 254 documents).
 *
 * The page fixes all three (see the comment on the `data-pf-ws` root in
 * site/src/pages/workshop/[slug].astro). This is what keeps them fixed: the
 * fragments are decoded and compared with the SAME build's /api/workshops.json,
 * so a forgotten `{' '}`, a new chrome link or a dropped filter fails here
 * instead of quietly degrading search for everyone. Nothing is per-workshop —
 * every expectation is derived from the data.
 *
 * Needs a build (`npm run build --prefix site`); pr-build-check.yml runs it
 * right after building. Deliberately not part of `npm test` for that reason —
 * a silent pass when there is no build would read as coverage.
 *
 * Fragment format (Pagefind 1.x): gzip; the plaintext starts with the marker
 * `pagefind_dcd`, then JSON {url, content, word_count, filters, meta, anchors}.
 *
 * Run: node scripts/pagefind_index_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { loadConferences, loadTopics, loadPaperCache, listWorkshopFiles, readWorkshopFile } from '../lib/workshops.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'site', 'dist');
const MARKER = 'pagefind_dcd';

function readFragments(dir) {
  const abs = path.join(DIST, dir, 'fragment');
  if (!fs.existsSync(abs)) {
    console.log(`✗ ${path.relative(ROOT, abs)} is missing — run \`npm run build --prefix site\` first`);
    process.exit(1);
  }
  return fs
    .readdirSync(abs)
    .filter((f) => f.endsWith('.pf_fragment'))
    .map((f) => {
      const text = zlib.gunzipSync(fs.readFileSync(path.join(abs, f))).toString('utf8');
      return JSON.parse(text.startsWith(MARKER) ? text.slice(MARKER.length) : text);
    });
}

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const slugOf = (url) => (String(url).match(/\/workshop\/([^/?#]+)/) || [])[1] || null;
const sameSet = (a, b) => a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' ');

// Mirrors of isAutoTopicsNote / isBotDeadlineNote in site/src/lib/markdown.ts
// (TypeScript, so not importable here). They decide what the page hides from
// the index; the test needs the same line to know what must still be present.
const isMachineNote = (s) =>
  !s || /auto-suggested and may be imprecise|SEED DATA|^Auto-imported from the OpenReview venue record/.test(String(s).trim());
const isMachineDeadlineNote = (s) => !s || /^(OpenReview-synced|imported from OpenReview)\b/.test(String(s).trim());

// Literals that belong to the page, never to a workshop. If one of these is in
// a document, it is in ~every document and matches everything. The link texts
// keep their arrows: a contributor's note can legitimately say "this OpenReview
// venue was created early", and that must stay indexed.
const WS_CHROME = ['Official website ↗', 'OpenReview venue ↗', '✎ Edit this entry', 'Copy as Markdown', 'help us add it',
  'Help add it', 'Opens a short form', 'Add deadline to calendar',
  // The time-zone explainer (a details block under the countdown).
  'Anywhere on Earth', 'Right now:',
  // "Surprise me" on a page whose pool is the previous edition.
  'Curious what got in last time', 'Surprise me'];
const WS_STAMPS = ['OpenReview-synced', 'imported from OpenReview — check the website',
  'auto-suggested and may be imprecise', 'SEED DATA', 'Unverified seed entry',
  // The extension-rate line (lib/extensions.mjs) is derived, not written.
  'of workshop deadlines were extended', 'edition we tracked', 'editions we tracked'];
const PAPERS_CHROME = ['Fetched from OpenReview', 'Accepted papers (', '· PDF', 'Surprise me', 'at random'];

const api = JSON.parse(fs.readFileSync(path.join(DIST, 'api', 'workshops.json'), 'utf8')).workshops;
const bySlug = new Map(api.map((w) => [w.slug, w]));
const confName = new Map(loadConferences().map((c) => [c.id, c.name]));
const topicLabel = new Map(loadTopics().map((t) => [t.id, t.label]));
const notesOf = new Map(listWorkshopFiles().map((f) => {
  const { slug, raw } = readWorkshopFile(f);
  return [slug, raw?.notes ?? null];
}));
const labelsOf = (w) => (w.topics ?? []).map((t) => topicLabel.get(t) ?? t);

// One counter per rule; the report names the rule and up to five offenders.
const rules = new Map();
const rule = (name) => rules.get(name) ?? rules.set(name, { name, seen: 0, bad: [] }).get(name);
function expect(name, slug, ok, detail = '') {
  const r = rule(name);
  r.seen++;
  if (!ok) r.bad.push(detail ? `${slug} (${detail})` : slug);
}

// ---- workshop documents --------------------------------------------------
const wsFrags = readFragments('pagefind');
for (const j of wsFrags) {
  const slug = slugOf(j.url);
  const w = bySlug.get(slug);
  expect('every workshop document is a workshop the API knows', slug ?? j.url, !!w);
  if (!w) continue;
  const content = norm(j.content);
  const labels = labelsOf(w);

  // The topline is the first block: badge, pill, chips — each its own word.
  const head = [confName.get(w.conference) ?? w.conference, w.year, w.status_label, ...labels].join(' ');
  const after = content.slice(head.length, head.length + 1);
  expect('topline reads "<conf> <year> <status> <topic> <topic>" as separate words', slug,
    content.startsWith(head) && !/[A-Za-z0-9]/.test(after), content.slice(0, 60));
  expect('no year glued to a status label anywhere', slug,
    !/\b(19|20)\d\d(Open call|Past|Deadline unknown|Not running)/.test(content));
  expect("filters.topic equals the workshop's topic labels", slug, sameSet(j.filters?.topic ?? [], labels));

  // <dt> labels stay separate from their <dd> values.
  if (w.deadline_wall_clock) {
    expect('"Submission deadline" is separated from the date', slug,
      content.includes(`Submission deadline ${norm(w.deadline_wall_clock)}`));
  }
  if (w.location_label) {
    expect('"Location" is separated from the place', slug, content.includes(`Location ${norm(w.location_label)}`));
  }

  for (const lit of WS_CHROME) expect(`page chrome is not indexed: "${lit}"`, slug, !content.includes(lit));
  for (const lit of WS_STAMPS) expect(`machine-written notes are not indexed: "${lit}"`, slug, !content.includes(lit));

  // Positive control — what a person wrote must still be there, or the ignore
  // rule has grown past its brief.
  if (!isMachineDeadlineNote(w.deadline_notes)) {
    expect("a contributor's deadline note is still indexed", slug, content.includes(norm(w.deadline_notes)));
  }
  const notes = notesOf.get(slug);
  if (!isMachineNote(notes)) {
    expect("a contributor's note is still indexed", slug, content.includes(norm(notes)));
  }
}

// ---- papers documents -----------------------------------------------------
const paperFrags = readFragments('pagefind-papers');
for (const j of paperFrags) {
  const slug = slugOf(j.url);
  const w = bySlug.get(slug);
  expect('every papers document is a workshop the API knows', slug ?? j.url, !!w);
  if (!w) continue;
  const content = norm(j.content);
  expect('papers document is typed Papers', slug, sameSet(j.filters?.type ?? [], ['Papers']));
  expect("papers document carries the workshop's topic filter", slug, sameSet(j.filters?.topic ?? [], labelsOf(w)));
  // The first paper title must be the first thing in the document: anything
  // before it (a heading, the provenance line, a leaked filter label) is text
  // that would match every papers document.
  const first = (j.anchors ?? []).find((a) => a.element === 'h3' && String(a.id).startsWith('p-'));
  expect('papers document starts with its first paper title', slug,
    !!first && content.startsWith(norm(first.text)), content.slice(0, 60));
  for (const lit of PAPERS_CHROME) expect(`papers chrome is not indexed: "${lit}"`, slug, !content.includes(lit));
}

// ---- corpus ---------------------------------------------------------------
const withPapers = api.filter((w) => {
  const c = loadPaperCache(w.slug);
  return c && Array.isArray(c.papers) && c.papers.length > 0;
}).length;
const corpus = [
  ['one workshop document per workshop', wsFrags.length === api.length, `${wsFrags.length} documents, ${api.length} workshops`],
  ['one papers document per workshop with cached papers', paperFrags.length === withPapers, `${paperFrags.length} documents, ${withPapers} with papers`],
  ['positive control: some contributor-written deadline note exists to check',
    api.some((w) => !isMachineDeadlineNote(w.deadline_notes)), 'none in the corpus — the ignore rule is unchecked'],
];

// ---- report ---------------------------------------------------------------
let failed = 0;
for (const r of rules.values()) {
  const ok = r.bad.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${r.name} (${r.seen} checked)${ok ? '' : ` — ${r.bad.length} failing, e.g. ${r.bad.slice(0, 5).join('; ')}`}`);
}
for (const [label, ok, detail] of corpus) {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ` — ${detail}`}`);
}
console.log(failed ? `\n${failed} rule(s) failed — the search index does not contain what the page promises.` : '\nThe search index contains what the page promises.');
process.exit(failed ? 1 : 0);
