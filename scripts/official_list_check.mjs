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
 * competition — while the conference still hosts it under its own OpenReview
 * namespace. So `off-list` means "a human should look". The one signature it
 * does name is off the list AND outside the conference's namespace: the
 * organisers run the event on their own (UniReps 2026 and ML4PS 2026 both left
 * NeurIPS.cc within days of the accepted list appearing), and the expected
 * verdict is `not_on_official_list`. An acknowledgement recorded before such a
 * move is reported again, because its premise has changed.
 *
 * Usage:
 *   node scripts/official_list_check.mjs
 *   node scripts/official_list_check.mjs --conf neurips --year 2026
 *   node scripts/official_list_check.mjs --report official-list.md
 *   node scripts/official_list_check.mjs --report -        # stdout
 */
import fs from 'node:fs';
import { loadWorkshops, loadEditions, loadConferences } from '../lib/workshops.mjs';
import {
  extractListedWorkshops,
  statedWorkshopCount,
  selectAnnouncementCandidates,
  describeResponse,
  MIN_LISTED,
} from '../lib/official_list.mjs';
import { matchOfficialList, hostedByConference } from '../lib/official_match.mjs';
import { CONF_TEMPLATE } from './discover_openreview.mjs';

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
/**
 * How long to keep re-reading a CONFIGURED list that parses to nothing.
 *
 * A 200 that yields no list is not proof of a wrong URL. Both announcement blogs
 * this job reads sit on one shared host, and it has twice answered a runner with
 * a short body carrying no list while serving the real page to everyone else —
 * once for ~2.5 minutes, recovering with no change at either end. The previous
 * budget, a single retry five seconds later, could not outlast that and filed a
 * "the URL is probably wrong" issue against a URL that was fine.
 *
 * So: span minutes, not seconds. The cost of waiting is a slower weekly job; the
 * cost of not waiting is a false alarm that stands until the next Sunday.
 * Candidate probes pass their own empty budget — a missed proposal files
 * nothing, so it must not buy patience at this price.
 */
export const EMPTY_RETRY_BACKOFF_MS = [15_000, 60_000, 180_000];

const args = process.argv.slice(2);
const getArg = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const onlyConf = getArg('--conf');
const onlyYear = getArg('--year') ? Number(getArg('--year')) : null;
const reportPath = getArg('--report');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Every page this run has already fetched.
 *
 * `findCandidate` walks a conference's feed once per unconfigured edition-year,
 * so ICLR 2025 and ICLR 2024 each re-requested the same five feed pages: 22
 * requests to one shared host in nine seconds, nine of them byte-identical
 * repeats. Nothing in a run's lifetime changes underneath us, so the repeats
 * bought nothing and spent the request budget of a host that visibly rations it.
 *
 * Keyed on the URL and holding failures too — re-asking a host that just refused
 * us is the behaviour being removed, not a fallback. `fresh` is the one bypass,
 * and only the empty-parse retry uses it, which is the sole case where asking
 * the same URL again is the entire point.
 */
const pageCache = new Map();

/** Drop everything this run has fetched. For tests; a real run never needs it. */
export const resetPageCache = () => pageCache.clear();

export async function get(url, { fresh = false } = {}) {
  if (!fresh && pageCache.has(url)) return pageCache.get(url);
  const res = await fetchPage(url);
  pageCache.set(url, res);
  return res;
}

async function fetchPage(url) {
  // Plain fetch with escalating backoff. Deliberately NOT lib/openreview.mjs's
  // limiter: different hosts, and sharing that budget would slow the four
  // OpenReview jobs for a request that has nothing to do with them.
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          // A plain custom agent is enough for a blog, but some CDNs answer a
          // bot-shaped request with a 200 and an interstitial instead of the
          // page. Ask for HTML explicitly and identify honestly.
          'user-agent': 'aiworkshoptracker/official-list-check (+https://aiworkshoptracker.com)',
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'en',
        },
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, status: res.status };
      const body = await res.text();
      return { ok: true, body, status: res.status, bytes: body.length };
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep((attempt + 1) * 3000); // no pause after the last try
    }
  }
  return { ok: false, reason: String(lastErr?.message ?? lastErr) };
}

/** How the report explains each thing `describeResponse` can conclude. */
const WHAT_CAME_BACK = {
  refusal: 'a challenge or refusal page, not the list — the host is turning this runner away, which clears on its own',
  stub: 'too little text to be the page at all — a stub or a JavaScript shell',
  page: 'a real page, but no list could be extracted from it — this one is the extractor, not the URL',
};

/**
 * Read a page and refuse it unless it is plausibly a workshop list.
 *
 * `backoff` is the caller's patience, in milliseconds between re-reads, and it
 * is a parameter because the two callers are not equally invested: a configured
 * list that reads empty gets filed as a data-health issue, so it is worth
 * minutes; a candidate probe that reads empty proposes nothing, so it is worth
 * one attempt. It is also what lets the retry path be tested without waiting.
 */
export async function readList(url, entries, { conferenceWebsite = null, venueNamespace = null, backoff = EMPTY_RETRY_BACKOFF_MS } = {}) {
  let res;
  let items = [];
  let warnings = [];
  let attempts = 0;
  let waitedMs = 0;
  for (;;) {
    // Only a re-read bypasses the cache — a first read of a page some earlier
    // edition already fetched should reuse it, which is the point of the cache.
    res = await get(url, { fresh: attempts > 0 });
    attempts++;
    if (!res.ok) return { ok: false, reason: res.reason };
    ({ items, warnings } = extractListedWorkshops(res.body, { baseUrl: url }));
    if (items.length >= MIN_LISTED || attempts > backoff.length) break;
    await sleep(backoff[attempts - 1]);
    waitedMs += backoff[attempts - 1];
  }
  if (items.length < MIN_LISTED) {
    // A 200 that parses to nothing has two causes needing opposite fixes — a
    // wrong or restructured URL, and a host refusing this IP — and the count
    // alone separates them not at all. So report what actually arrived: its
    // title, its first words, and which of the two it looks like. Whoever reads
    // the issue should not have to re-run the fetch by hand to learn that much.
    const seen = describeResponse(res.body);
    return {
      ok: false,
      reason:
        `${items.length} items found, expected at least ${MIN_LISTED}` +
        ` — after ${attempts} attempt${attempts === 1 ? '' : 's'}` +
        `${waitedMs ? ` over ${Math.round(waitedMs / 1000)}s` : ''}` +
        ` (HTTP ${res.status}, ${res.bytes} bytes)`,
      detail: [
        `what came back: ${WHAT_CAME_BACK[seen.kind]}`,
        seen.title ? `its title: “${seen.title}”` : null,
        seen.sample ? `its first words (${seen.visibleChars} chars of visible text): “${seen.sample}”` : null,
        seen.kind === 'page'
          ? null
          : 'Re-run *Official workshop list check* before changing any config — this shape of failure has cleared on its own before.',
      ].filter(Boolean),
      warnings,
    };
  }
  const r = matchOfficialList(entries, items, { listUrl: url, conferenceWebsite, venueNamespace });
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
async function findCandidate(feedUrl, year, entries, conferenceWebsite = null, venueNamespace = null) {
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
      // One attempt. Most posts a feed yields are not the list and never will
      // be, and a probe that reads empty proposes nothing rather than filing
      // anything — so patience here buys a slower job and a bigger burst
      // against the very host that rations requests, and nothing else.
      const probe = await readList(c.url, entries, { conferenceWebsite, venueNamespace, backoff: [] });
      if (probe.ok) return { url: c.url, title: c.title, ...probe };
    }
  }
  return null;
}

function fmtCounts(c) {
  return `${c.listed} listed · ${c.tracked} tracked · ${c.matched} matched · ${c.offList} off-list · ${c.missing} missing${
    c.acked ? ` · ${c.acked} acknowledged` : ''
  }${c.independent ? ` · ${c.independent} acknowledged but no longer under the conference namespace` : ''}${
    c.marked ? ` · ${c.marked} already marked not running` : ''
  }`;
}

async function main() {
  const all = loadWorkshops();
  const confById = new Map(loadConferences().map((c) => [c.id, c]));
  let editions = loadEditions().filter((e) => e.conference && e.year);
  if (onlyConf) editions = editions.filter((e) => e.conference === onlyConf);
  if (onlyYear) editions = editions.filter((e) => e.year === onlyYear);

  const sections = { offList: [], independent: [], missing: [], drifted: [], unreadable: [], candidates: [] };
  const headers = [];

  for (const ed of editions.sort((a, b) => b.year - a.year || a.conference.localeCompare(b.conference))) {
    const entries = all.filter((w) => w.conference === ed.conference && w.year === ed.year);
    if (!entries.length) continue;
    const confName = confById.get(ed.conference)?.name ?? ed.conference;
    const label = `${confName} ${ed.year}`;
    // The conference-year's own OpenReview namespace, the same one discovery
    // crawls. It is what separates an off-list event the conference hosts from
    // one the organisers run on their own — see hostedByConference().
    const venueNamespace = CONF_TEMPLATE[ed.conference]?.replace('{year}', String(ed.year)) ?? null;

    if (!ed.workshop_list_url) {
      // No list configured. Nothing is reconciled — and nothing is broken; the
      // OpenReview crawl for this conference-year runs exactly as before.
      const feed = confById.get(ed.conference)?.announcement_feed;
      if (!feed) continue;
      const cand = await findCandidate(feed, ed.year, entries, confById.get(ed.conference)?.website ?? null, venueNamespace);
      if (cand) {
        const disagrees = cand.stated != null && cand.stated !== cand.result.counts.listed;
        sections.candidates.push(
          `- [ ] **${label}** — [${cand.title}](${cand.url})\n` +
            `      - ${fmtCounts(cand.result.counts)}${cand.stated ? ` (the post itself says ${cand.stated})` : ''}\n` +
            // A candidate gets the same self-consistency flag a configured list
            // does. Reading it here, before adopting, is the cheapest moment to
            // notice that the page was only half understood.
            (disagrees
              ? `      - ⚠️ The post says **${cand.stated}** accepted workshops but ${cand.result.counts.listed} were extracted — read the page before adopting it.\n`
              : '') +
            (cand.result.counts.missing > 0 ? cand.warnings.map((w) => `      - ⚠️ ${w}\n`).join('') : '') +
            `      - Adopt it by adding \`workshop_list_url: "${cand.url}"\` to the \`${ed.conference} ${ed.year}\` row of \`data/editions.yml\`.`,
        );
      }
      continue;
    }

    const read = await readList(ed.workshop_list_url, entries, {
      conferenceWebsite: confById.get(ed.conference)?.website ?? null,
      venueNamespace,
    });
    if (!read.ok) {
      // This KEEPS the issue open, because one of its two causes — a wrong or
      // restructured URL — settles never. The other one, a host refusing this
      // runner, has settled by itself twice. The entry therefore has to carry
      // enough to tell them apart, which is what `detail` is; the section text
      // no longer asserts the first cause as though it were the only one.
      sections.unreadable.push(
        `- [ ] **${label}** — ${ed.workshop_list_url}\n      - ${read.reason}` +
          (read.detail ?? []).map((d) => `\n      - ${d}`).join(''),
      );
      continue;
    }
    const { result: r, stated } = read;
    let header = `### ${label}\n\n${fmtCounts(r.counts)}  \nList: ${ed.workshop_list_url}`;
    if (stated != null && stated !== r.counts.listed) {
      header += `\n\n> ⚠️ The post says **${stated}** accepted workshops but ${r.counts.listed} were extracted — the page shape may have changed.`;
    }
    // The extractor warns when it had to fall back past <li>. That is a useful
    // signal ONLY while the read looks doubtful: ICLR publishes its list as a
    // table every year, so surfacing it unconditionally would print the same
    // warning forever and teach the reader to skip warnings. A list where every
    // entry matched something we track was demonstrably read correctly,
    // whichever tag carried it.
    if (r.counts.missing > 0) for (const w of read.warnings) header += `\n\n> ⚠️ ${w}`;
    headers.push(header);

    // Ranked: an off-list entry still advertising an Open call is the one
    // actively misleading readers, so it goes first, soonest deadline first.
    const rank = (e) => (e.statusLabel === 'Open call' ? 0 : 1);
    for (const e of r.offList.sort(
      (a, b) => rank(a) - rank(b) || (a.deadlineUtcMs ?? Infinity) - (b.deadlineUtcMs ?? Infinity) || a.slug.localeCompare(b.slug),
    )) {
      const open = e.statusLabel === 'Open call';
      // Where the evidence already decides, the row says so instead of offering
      // two verdicts: a venue outside the conference's namespace is the
      // organisers' own statement that this is not the conference's workshop.
      const outside = hostedByConference(e.openreview_venue_id, venueNamespace) === false;
      sections.offList.push(
        `- [ ] \`data/workshops/${e.slug}.yml\` — **${e.name}** (${label})` +
          `${open ? ' — 🔴 still showing an Open call' : ` — _${e.statusLabel}_`}\n` +
          `      - deadline it advertises: ${e.deadlineWallClock ?? '(none)'}` +
          `${e.openreview_venue_id ? ` · venue \`${e.openreview_venue_id}\`` : ''}` +
          `${e.website ? ` · ${e.website}` : ' · no website recorded'}\n` +
          (outside
            ? `      - its venue is not under \`${venueNamespace}\` — off the list *and* outside the conference's OpenReview namespace is the independent-event signature: the organisers run it on their own\n` +
              `      - run *Record an official-list decision* with slug \`${e.slug}\`, action \`not_on_official_list\`, and a note saying where it runs now`
            : `      - **not running?** run *Record an official-list decision* with slug \`${e.slug}\`, action \`not_on_official_list\`\n` +
              `      - **running, just not on this list** (an affinity event or competition the conference hosts under its own namespace)? same workflow, action \`ack\``),
      );
    }

    for (const e of r.independent) {
      sections.independent.push(
        `- [ ] \`data/workshops/${e.slug}.yml\` — **${e.name}** (${label}) — _${e.statusLabel}_\n` +
          `      - acknowledged as absent from this list, but its venue \`${e.openreview_venue_id}\` is no longer under \`${venueNamespace}\`` +
          `${e.website ? ` · ${e.website}` : ''}\n` +
          `      - run *Record an official-list decision* with slug \`${e.slug}\`, action \`not_on_official_list\`, and a note saying where it runs now`,
      );
    }

    for (const m of r.missing) {
      sections.missing.push(
        `- [ ] **${m.title}** (${label})${m.section ? ` — _${m.section}_` : ''}\n` +
          `      - ${m.url}\n` +
          `      - Add it with the [Add a workshop](../../issues/new?template=add-workshop.yml) form. ` +
          `Some listed workshops have no OpenReview presence at all, so no crawl will ever find them.`,
      );
    }

    for (const d of r.drifted) {
      // Most drift is decidable from the two strings alone, so the report says
      // which it is and prints the one command — a row that still needs a
      // person's judgement is then the only one that looks like a question.
      const why =
        d.verdict === 'adopt' && d.field === 'name'
          ? 'the official title is the same name plus its subtitle'
          : d.verdict === 'adopt'
            ? "our stored URL is the conference's own site — a placeholder, not this workshop's homepage"
            : d.verdict === 'decline'
              ? 'ours already says more; theirs is acronym/venue-shaped, which is what the importer strips everywhere else'
              : 'two genuinely different values, and neither source is authoritative';
      const verdict =
        d.verdict === 'unclear' ? `**Your call** — ${why}.` : `**${d.verdict === 'adopt' ? 'Adopt' : 'Decline'}** — ${why}.`;
      const flag = d.verdict === 'decline' ? '--decline' : '--adopt';
      sections.drifted.push(
        `- [ ] \`data/workshops/${d.entry.slug}.yml\` — **${d.entry.name}** (${label}) — ${d.field}\n` +
          `      - ours: ${d.ours}\n      - official list: ${d.theirs}\n` +
          `      - ${verdict}\n` +
          `      - \`node scripts/apply_official_list.mjs --slug ${d.entry.slug} --field ${d.field} ${flag}\`` +
          (d.verdict === 'unclear' ? ' (or `--decline` to keep ours)' : ''),
      );
    }
  }

  const parts = [];
  // Same shape as the "deadlines to review" issue: a line saying what this is,
  // then checkbox items. Tick one off as you deal with it — the body is rebuilt
  // from scratch on every run, so a resolved item disappears on its own and the
  // ticks are only a working aid between runs.
  parts.push(
    'These entries disagree with the conference\'s own **accepted-workshop list**, or are workshops it names that we do not track. ' +
      'Nothing here is applied automatically.\n' +
      'A list is authoritative for what it *includes*, never for what it omits — affinity events and competitions the conference ' +
      'hosts under its own OpenReview namespace are legitimately absent from one. Off the list *and* outside that namespace is an ' +
      'independent event the organisers run on their own, and is recorded not running.',
  );
  if (headers.length) parts.push(headers.join('\n\n'));
  if (sections.offList.length) {
    parts.push(
      '### Tracked, but not on the official list\n\n' +
        '_OpenReview creates a venue group during a conference\'s **proposal** phase, so a rejected proposal keeps a live group ' +
        'with a ticking deadline — the site can end up advertising a call for a workshop that will never happen. But an official ' +
        'list is authoritative for presence, not absence: affinity events and competitions the conference hosts under its own ' +
        'OpenReview namespace are legitimately absent from it. An entry that is off the list *and* outside that namespace is an ' +
        'independent event, however co-located, and is recorded not running. Decide per entry; nothing here is applied automatically._\n\n' +
        sections.offList.join('\n'),
    );
  }
  if (sections.independent.length) {
    parts.push(
      '### Acknowledged as off-list, but no longer hosted by the conference\n\n' +
        '_These were acknowledged as running and merely absent from the list while their venue still sat under the conference\'s ' +
        'OpenReview namespace. It no longer does: the organisers have moved the event to their own namespace, which is what an ' +
        'independent event looks like. The acknowledgement\'s premise has changed, so it is reported again; the expected verdict ' +
        'is `not_on_official_list`, with a note saying where the event runs now._\n\n' +
        sections.independent.join('\n'),
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
        'This says nothing about the workshops themselves — it is the check that failed, not the corpus.\n' +
        'Two causes look identical from here and need opposite fixes: the URL is wrong or the page was restructured, which ' +
        'settles never; or the host turned this runner away, which settles by itself and has done. Each entry says what ' +
        'actually came back, which is the thing that tells them apart — **re-run the job before editing any config**._\n\n' +
        sections.unreadable.join('\n'),
    );
  }

  const actionable =
    sections.offList.length + sections.independent.length + sections.missing.length + sections.drifted.length +
    sections.unreadable.length + sections.candidates.length;
  const report = actionable ? parts.join('\n\n') : '';

  // `headers` only holds conference-years that were successfully READ, so an
  // empty one does not mean nothing was configured — it can equally mean every
  // configured list failed, which is the more urgent case and used to be
  // reported as the harmless one.
  const configured = editions.filter((e) => e.workshop_list_url).length;
  console.log(
    headers.length
      ? headers.join('\n\n').replace(/  \n/g, '\n')
      : configured
        ? `None of the ${configured} configured list(s) could be read — see the report.`
        : 'No conference-year has a workshop_list_url configured.',
  );
  console.log(`\n${actionable} item(s) need a human decision.`);

  if (reportPath === '-') console.log('\n----- report -----\n' + report);
  else if (reportPath) fs.writeFileSync(reportPath, report);
}

// Only run the CLI when invoked directly, so readList and the page cache can be
// imported in tests without the module parsing argv and walking two live blogs.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
