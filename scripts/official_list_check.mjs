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
      await new Promise((r) => setTimeout(r, (attempt + 1) * 3000));
    }
  }
  return { ok: false, reason: String(lastErr?.message ?? lastErr) };
}

/** Read a page and refuse it unless it is plausibly a workshop list. */
async function readList(url, entries, { retryEmpty = true, conferenceWebsite = null } = {}) {
  const res = await get(url);
  if (!res.ok) return { ok: false, reason: res.reason };
  const { items, warnings } = extractListedWorkshops(res.body, { baseUrl: url });
  if (items.length < MIN_LISTED) {
    // A 200 that parses to nothing is usually a CDN interstitial or a truncated
    // response rather than a genuinely wrong URL, and those pass on a second
    // attempt. Retry ONCE, then report — with what we actually received, because
    // "0 items found" alone cannot distinguish a challenge page from a real page
    // we failed to parse, and that difference decides whether the fix is in the
    // config or in the extractor.
    if (retryEmpty) {
      await new Promise((r) => setTimeout(r, 5000));
      return readList(url, entries, { retryEmpty: false, conferenceWebsite });
    }
    return {
      ok: false,
      reason:
        `${items.length} items found, expected at least ${MIN_LISTED}` +
        ` (HTTP ${res.status}, ${res.bytes} bytes received${res.bytes < 5000 ? ' — too small to be the page, so probably an interstitial or a redirect' : ''})`,
      warnings,
    };
  }
  const r = matchOfficialList(entries, items, { listUrl: url, conferenceWebsite });
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
async function findCandidate(feedUrl, year, entries, conferenceWebsite = null) {
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
      const probe = await readList(c.url, entries, { conferenceWebsite });
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
      const cand = await findCandidate(feed, ed.year, entries, confById.get(ed.conference)?.website ?? null);
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
    });
    if (!read.ok) {
      // Unlike the deadline cross-check's transient "could not be checked", this
      // KEEPS the issue open: the cause there is rate-limiting that settles by
      // itself, here it is a wrong URL in config, which settles never.
      sections.unreadable.push(`- [ ] **${label}** — ${ed.workshop_list_url}\n      - ${read.reason}`);
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
      sections.offList.push(
        `- [ ] \`data/workshops/${e.slug}.yml\` — **${e.name}** (${label})` +
          `${open ? ' — 🔴 still showing an Open call' : ` — _${e.statusLabel}_`}\n` +
          `      - deadline it advertises: ${e.deadlineWallClock ?? '(none)'}` +
          `${e.openreview_venue_id ? ` · venue \`${e.openreview_venue_id}\`` : ''}` +
          `${e.website ? ` · ${e.website}` : ' · no website recorded'}\n` +
          `      - **not running?** run *Record an official-list decision* with slug \`${e.slug}\`, action \`not_on_official_list\`\n` +
          `      - **running, just not on this list** (affinity event, competition, co-located)? same workflow, action \`ack\``,
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
      'A list is authoritative for what it *includes*, never for what it omits — affinity events, competitions and co-located ' +
      'workshops are legitimately absent from one.',
  );
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

await main();
