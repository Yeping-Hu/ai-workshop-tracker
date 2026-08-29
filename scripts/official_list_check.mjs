#!/usr/bin/env node
/**
 * Reconcile the corpus against each conference-edition's OFFICIAL
 * accepted-workshop list, and report what disagrees.
 *
 * Why this exists. Every workshop record comes from an OpenReview venue group,
 * and OpenReview creates those during a conference's PROPOSAL phase — so a
 * REJECTED proposal keeps a live group with an open submission invitation and a
 * ticking duedate, indistinguishable from an accepted workshop. Discovery cannot
 * tell them apart and never could. The conference's own list is the only second
 * opinion that exists.
 *
 * This job is ADDITIVE and never destructive:
 *   - It does not touch OpenReview discovery, which keeps importing workshops for
 *     all nine conferences exactly as before, and remains the only thing that
 *     ever CREATES a record.
 *   - It writes nothing. Every finding is a line in a data-health issue for a
 *     human, matching how this repo treats every risky inference.
 *   - A conference-year with no `workshop_list_url` is simply not reconciled. It
 *     behaves exactly as it does today.
 *
 * And it never concludes "rejected" on its own, because an official list is
 * authoritative for PRESENCE, not for ABSENCE: a workshop can be running and
 * merely not be a "workshop" in that list's sense — an affinity event, a
 * competition, a co-located event in its own OpenReview namespace. UniReps 2026
 * is exactly that shape. So `off-list` means "a human should look".
 *
 * Usage:
 *   node scripts/official_list_check.mjs
 *   node scripts/official_list_check.mjs --conf neurips --year 2026
 *   node scripts/official_list_check.mjs --report official-list.md
 *   node scripts/official_list_check.mjs --report -        # stdout
 */
import fs from 'node:fs';
import { loadWorkshops, loadEditions, loadConferences, websiteKey } from '../lib/workshops.mjs';
import { extractListedWorkshops, statedWorkshopCount, selectAnnouncementCandidates, MIN_LISTED } from '../lib/official_list.mjs';
import { matchOfficialList } from '../lib/official_match.mjs';

/**
 * A page must account for at least this share of the entries we already track
 * for that conference-year. Together with MIN_LISTED this is what stops a
 * truncated read, a redirect to a login page, or a reformatted template being
 * interpreted as "the whole corpus was rejected" — the single worst thing this
 * check could produce. Same instinct as alerts' SNAPSHOT_SHRINK_GUARD.
 */
const MIN_MATCH_SHARE = 0.5;
/** How many pages of a conference's announcement feed to walk back. */
const FEED_PAGES = 5;

const args = process.argv.slice(2);
const getArg = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const onlyConf = getArg('--conf');
const onlyYear = getArg('--year') ? Number(getArg('--year')) : null;
const reportPath = getArg('--report');

async function get(url) {
  // Plain fetch with escalating backoff. Deliberately NOT lib/openreview.mjs's
  // limiter: different hosts, and sharing that budget would slow the four
  // OpenReview jobs for a request that has nothing to do with them.
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'aiworkshoptracker/official-list-check' } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
      return { ok: true, body: await res.text() };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, (attempt + 1) * 3000));
    }
  }
  return { ok: false, reason: String(lastErr?.message ?? lastErr) };
}

/** Read a page and refuse it unless it is plausibly a workshop list. */
async function readList(url, entries) {
  const res = await get(url);
  if (!res.ok) return { ok: false, reason: res.reason };
  const { items, warnings } = extractListedWorkshops(res.body, { baseUrl: url });
  if (items.length < MIN_LISTED) {
    return { ok: false, reason: `${items.length} items found, expected at least ${MIN_LISTED}`, warnings };
  }
  const r = matchOfficialList(entries, items, { listUrl: url });
  const share = entries.length ? r.counts.matched / Math.min(entries.length, items.length) : 1;
  if (share < MIN_MATCH_SHARE) {
    return {
      ok: false,
      reason: `only ${r.counts.matched} of ${items.length} listed workshops match anything we track — this does not look like ${entries[0]?.conference ?? 'this conference'}'s list`,
      warnings,
    };
  }
  return { ok: true, items, warnings, result: r, stated: statedWorkshopCount(res.body) };
}

/**
 * Propose a list URL for a conference-year that has none. Proposes ONLY —
 * adopting it is a human's dispatch, because a mis-read page would declare the
 * whole corpus rejected.
 */
async function findCandidate(feedUrl, year, entries) {
  const seen = new Set();
  for (let page = 1; page <= FEED_PAGES; page++) {
    // WordPress feeds hold ten items; a weekly job against a busy blog needs to
    // walk back further than one page or it can miss the announcement entirely.
    const res = await get(page === 1 ? feedUrl : `${feedUrl}${feedUrl.includes('?') ? '&' : '?'}paged=${page}`);
    if (!res.ok) break;
    const candidates = selectAnnouncementCandidates(res.body, year);
    if (!/<(?:item|entry)>/i.test(res.body)) break;
    for (const c of candidates) {
      if (seen.has(c.url)) continue;
      seen.add(c.url);
      const probe = await readList(c.url, entries);
      if (probe.ok) return { url: c.url, title: c.title, ...probe };
    }
  }
  return null;
}

function fmtCounts(c) {
  return `${c.listed} listed · ${c.tracked} tracked · ${c.matched} matched · ${c.offList} off-list · ${c.missing} missing${
    c.acked ? ` · ${c.acked} acknowledged` : ''
  }${c.marked ? ` · ${c.marked} already marked not running` : ''}`;
}

async function main() {
  const all = loadWorkshops();
  const confById = new Map(loadConferences().map((c) => [c.id, c]));
  let editions = loadEditions().filter((e) => e.conference && e.year);
  if (onlyConf) editions = editions.filter((e) => e.conference === onlyConf);
  if (onlyYear) editions = editions.filter((e) => e.year === onlyYear);

  const sections = { offList: [], missing: [], drifted: [], unreadable: [], candidates: [] };
  const headers = [];

  for (const ed of editions.sort((a, b) => b.year - a.year || a.conference.localeCompare(b.conference))) {
    const entries = all.filter((w) => w.conference === ed.conference && w.year === ed.year);
    if (!entries.length) continue;
    const confName = confById.get(ed.conference)?.name ?? ed.conference;
    const label = `${confName} ${ed.year}`;

    if (!ed.workshop_list_url) {
      // No list configured. Nothing is reconciled — and nothing is broken; the
      // OpenReview crawl for this conference-year runs exactly as before.
      const feed = confById.get(ed.conference)?.announcement_feed;
      if (!feed) continue;
      const cand = await findCandidate(feed, ed.year, entries);
      if (cand) {
        sections.candidates.push(
          `- **${label}** — [${cand.title}](${cand.url})\n` +
            `  - ${fmtCounts(cand.result.counts)}${cand.stated ? ` (the post itself says ${cand.stated})` : ''}\n` +
            `  - Adopt it by adding \`workshop_list_url: "${cand.url}"\` to the \`${ed.conference} ${ed.year}\` row of \`data/editions.yml\`.`,
        );
      }
      continue;
    }

    const read = await readList(ed.workshop_list_url, entries);
    if (!read.ok) {
      // Unlike the deadline cross-check's transient "could not be checked", this
      // KEEPS the issue open: the cause there is rate-limiting that settles by
      // itself, here it is a wrong URL in config, which settles never.
      sections.unreadable.push(`- **${label}** — ${ed.workshop_list_url}\n  - ${read.reason}`);
      continue;
    }
    const { result: r, stated } = read;
    let header = `### ${label}\n\n${fmtCounts(r.counts)}  \nList: ${ed.workshop_list_url}`;
    if (stated != null && stated !== r.counts.listed) {
      header += `\n\n> ⚠️ The post says **${stated}** accepted workshops but ${r.counts.listed} were extracted — the page shape may have changed.`;
    }
    for (const w of read.warnings) header += `\n\n> ⚠️ ${w}`;
    headers.push(header);

    // Ranked: an off-list entry still advertising an Open call is the one
    // actively misleading readers, so it goes first, soonest deadline first.
    const rank = (e) => (e.statusLabel === 'Open call' ? 0 : 1);
    for (const e of r.offList.sort(
      (a, b) => rank(a) - rank(b) || (a.deadlineUtcMs ?? Infinity) - (b.deadlineUtcMs ?? Infinity) || a.slug.localeCompare(b.slug),
    )) {
      const open = e.statusLabel === 'Open call';
      sections.offList.push(
        `- ${open ? '🔴 **still showing an Open call**' : `_${e.statusLabel}_`} — \`data/workshops/${e.slug}.yml\`` +
          ` — ${e.name}\n` +
          `  - deadline it advertises: ${e.deadlineWallClock ?? '(none)'}` +
          `${e.openreview_venue_id ? ` · venue \`${e.openreview_venue_id}\`` : ''}` +
          `${e.website ? ` · ${e.website}` : ' · no website recorded'}\n` +
          `  - **not running?** run *Mark a workshop not running* with slug \`${e.slug}\`, action \`not_on_official_list\`\n` +
          `  - **running, just not on this list** (affinity event, competition, co-located)? same workflow, action \`ack\``,
      );
    }

    for (const m of r.missing) {
      sections.missing.push(
        `- **${label}** — ${m.title}${m.section ? ` _(${m.section})_` : ''}\n  - ${m.url}\n` +
          `  - Add it with the [Add a workshop](../../issues/new?template=add-workshop.yml) form. ` +
          `Some listed workshops have no OpenReview presence at all, so no crawl will ever find them.`,
      );
    }

    for (const d of r.drifted) {
      sections.drifted.push(
        `- \`data/workshops/${d.entry.slug}.yml\` — ${d.field}\n` +
          `  - ours: ${d.ours}\n  - official list: ${d.theirs}\n` +
          `  - Adopt it, or record \`review_ack.${d.field}\` to decline it.`,
      );
    }
  }

  const parts = [];
  if (headers.length) parts.push(headers.join('\n\n'));
  if (sections.offList.length) {
    parts.push(
      '### Tracked, but not on the official list\n\n' +
        '_OpenReview creates a venue group during a conference\'s **proposal** phase, so a rejected proposal keeps a live group ' +
        'with a ticking deadline — the site can end up advertising a call for a workshop that will never happen. But an official ' +
        'list is authoritative for presence, not absence: affinity events, competitions and co-located workshops are legitimately ' +
        'absent from it. Decide per entry; nothing here is applied automatically._\n\n' +
        sections.offList.join('\n'),
    );
  }
  if (sections.missing.length) {
    parts.push('### On the official list, missing from the tracker\n\n' + sections.missing.join('\n'));
  }
  if (sections.drifted.length) {
    parts.push('### Title or website differs from the official list\n\n' + sections.drifted.join('\n'));
  }
  if (sections.candidates.length) {
    parts.push(
      '### Candidate official list found\n\n' +
        '_Discovered from the conference\'s announcement feed and checked against the corpus. Proposed, never adopted: a ' +
        'mis-read page would report every workshop as rejected._\n\n' +
        sections.candidates.join('\n'),
    );
  }
  if (sections.unreadable.length) {
    parts.push(
      '### Official list could not be read\n\n' +
        '_The configured URL did not yield a usable workshop list, so that conference-year was **not checked at all**. ' +
        'Unlike a throttled API this does not settle by itself — the URL is probably wrong or the page was restructured._\n\n' +
        sections.unreadable.join('\n'),
    );
  }

  const actionable =
    sections.offList.length + sections.missing.length + sections.drifted.length + sections.unreadable.length + sections.candidates.length;
  const report = actionable ? parts.join('\n\n') : '';

  console.log(headers.length ? headers.join('\n\n').replace(/  \n/g, '\n') : 'No conference-year has a workshop_list_url configured.');
  console.log(`\n${actionable} item(s) need a human decision.`);

  if (reportPath === '-') console.log('\n----- report -----\n' + report);
  else if (reportPath) fs.writeFileSync(reportPath, report);
}

await main();
