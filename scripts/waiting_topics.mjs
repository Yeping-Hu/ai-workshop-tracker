#!/usr/bin/env node
/**
 * Which workshops are still waiting for a topic judgment — the entries whose
 * note says their topics are a keyword match because Jev could not be asked
 * when they were imported (KEYWORD_TOPICS_NOTE in discover_openreview.mjs).
 *
 * It exists for one reader: the "Data health: Jev did not answer" issue. That
 * issue said a key or a balance needed looking at, and nothing about which
 * workshops were living on the keyword table's tags meanwhile — the question a
 * maintainer actually has when it arrives. discover.yml and series-audit.yml
 * both write that issue, and whichever runs last replaces the body, so both run
 * this just before and quote its report; a list only one of them knew about
 * would vanish the first time the other job met the same dead key.
 *
 * Reads the working tree and nothing else: no network, no key, nothing written
 * to data/. In discover.yml that is the tree AFTER the --pending sweep, so an
 * entry the same run managed to re-judge is already off the list. The report is
 * written even when it is empty, because "nobody is waiting" is worth saying in
 * an issue about failures, and is a different fact from "the listing never ran"
 * (no file).
 *
 * A workshop links to its page when SITE_URL is set, as deploy.yml sets it; a
 * fork that has not set one still gets names and slugs.
 *
 * Usage:
 *   node scripts/waiting_topics.mjs                  # print the list
 *   node scripts/waiting_topics.mjs --report <path>  # and write the issue section there
 */
import fs from 'node:fs';
import { listWorkshopFiles, readWorkshopFile, slugOfFile, loadConferences } from '../lib/workshops.mjs';
import { hasKeywordTopicsNote } from './discover_openreview.mjs';

/**
 * The waiting entries among `entries` ([{ slug, raw }]), newest conference-year
 * first, then by conference and slug. `conferences` (conferences.yml rows) gives
 * each its display name — "CoRL", not the id upper-cased.
 */
export function waitingTopics(entries, conferences = []) {
  const display = new Map(conferences.map((c) => [c.id, c.name]));
  return entries
    .filter(({ raw }) => hasKeywordTopicsNote(raw?.notes))
    .map(({ slug, raw }) => ({
      slug,
      name: String(raw.name ?? slug),
      conference: display.get(raw.conference) ?? String(raw.conference ?? '').toUpperCase(),
      year: raw.year ?? null,
      topics: Array.isArray(raw.topics) ? raw.topics.map(String) : [],
    }))
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.conference.localeCompare(b.conference) || a.slug.localeCompare(b.slug));
}

/** `https://site/base/workshop/<slug>/`, or null without a site URL. */
export function workshopPageUrl(slug, { siteUrl, siteBase = '/' } = {}) {
  if (!siteUrl) return null;
  const base = `/${String(siteBase).replace(/^\/+|\/+$/g, '')}/`.replace(/\/{2,}/g, '/');
  return `${String(siteUrl).replace(/\/+$/, '')}${base}workshop/${slug}/`;
}

/**
 * The section the issue quotes. Says what a maintainer needs and no more: who
 * is waiting, that it needs no action per workshop, and the one command that
 * brings it forward once the cause is fixed.
 */
export function renderWaitingTopics(waiting, site = {}) {
  if (!waiting.length) {
    return 'No workshop is waiting for a topic judgment: every entry imported while Jev could not be asked has since been re-judged.';
  }
  const lines = [
    `### Workshops waiting for a topic judgment (${waiting.length})`,
    '',
    'Imported while Jev could not be asked, so their topics are the keyword table\'s for now and their note says so. Nothing needs doing per workshop: the next weekly discovery run that reaches Jev re-judges them and takes them off this list. To bring that forward once the key or the balance is fixed:',
    '',
    '```',
    'node scripts/retag_topics.mjs --pending',
    '```',
    '',
  ];
  for (const w of waiting) {
    const url = workshopPageUrl(w.slug, site);
    const where = `${w.conference}${w.year ? ` ${w.year}` : ''}`;
    const tags = w.topics.length ? w.topics.map((t) => `\`${t}\``).join(', ') : 'no topics';
    lines.push(`- ${url ? `[${w.name}](${url})` : `**${w.name}**`} — ${where}, \`${w.slug}\`; tagged ${tags} for now`);
  }
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--report');
  const reportPath = at !== -1 ? args[at + 1] : null;
  const waiting = waitingTopics(listWorkshopFiles().map((f) => ({ slug: slugOfFile(f), raw: readWorkshopFile(f).raw })), loadConferences());
  const report = renderWaitingTopics(waiting, { siteUrl: process.env.SITE_URL, siteBase: process.env.SITE_BASE });
  console.log(report);
  if (reportPath) fs.writeFileSync(reportPath, `${report}\n`);
}
