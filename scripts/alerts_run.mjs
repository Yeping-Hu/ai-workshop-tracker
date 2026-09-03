#!/usr/bin/env node
/**
 * The email-alerts pipeline — the entrypoint the daily GitHub Action runs.
 *
 * Why a GitHub Action rather than a Worker cron (decision D4): this repo already
 * runs a fleet of scheduled data jobs, rendering hundreds of digests is not
 * something to squeeze into a Worker's CPU budget, and a failed Action emails
 * the maintainer — the repo's established alert channel.
 *
 * The Action is **stateless**. Every read and write goes through the Worker's
 * /admin/* endpoints, so this script never holds a database credential, never
 * holds the Resend key, and never mints a subscriber token. It renders emails
 * with placeholder links and the Worker substitutes real, per-recipient ones at
 * send time.
 *
 * Flow (docs/plans/email-alerts.md §6.2):
 *   1. fetch /api/workshops.json and project it
 *   2. GET the snapshot; seed silently on the first run, abort on a shrink
 *   3. classify events -> POST them -> PUT the new snapshot (in that order:
 *      a snapshot written before its events would lose them forever)
 *   4. urgent pass (every run)
 *   5. weekly pass (UTC Monday, or FORCE_WEEKLY): fetch the week's events,
 *      write data/changes.json, send the digests. The page is the published
 *      edition of the mail, so both come from that one fetch.
 *   6. maintenance
 *
 * NEVER log an address, a message body, or anything that reveals the size of
 * the list — the workflow log is public on a public repo. Dataset facts
 * (workshops, events, slugs) are fine; they are on the site already. See the
 * output section below, which enforces this rather than trusting each call.
 *
 * Env:
 *   ALERTS_API_BASE     required, e.g. https://api.aiworkshoptracker.com
 *   ALERTS_ADMIN_TOKEN  required, bearer for /admin/*
 *   WORKSHOPS_JSON_URL  optional override of the feed (tests)
 *   DRY_RUN=1           do everything except send, log urgents, write snapshot.
 *                       data/changes.json IS still written: it is a local file, not
 *                       a message, and the feed is true either way.
 *   FORCE_WEEKLY=1      run the weekly pass on a non-Monday
 *   ALERTS_VERBOSE=1    exact counts and per-recipient lines. Local use only —
 *                       never set this in a workflow, the logs are public
 *
 * Run: node scripts/alerts_run.mjs
 */
import {
  URGENT_WINDOW_MS,
  WEEKLY_DOW,
  SEND_CHUNK,
  SITE_ORIGIN,
} from '../alerts/config.mjs';
import { projectFeed, diffSnapshot, closingWithin, feedUnchanged } from '../alerts/diff.mjs';
import {
  normalizeSubscriber,
  matchingEvents,
  matchesSubscriber,
  isMailable,
  wantsUrgent,
  wantsStarredChanges,
  wantsWeekly,
} from '../alerts/match.mjs';
import { renderDigest, renderUrgent, renderStarredChanges } from '../alerts/render.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ids = JSON.parse(fs.readFileSync(path.join(ROOT, 'alerts', 'ids.json'), 'utf8'));

const API = (process.env.ALERTS_API_BASE || '').replace(/\/+$/, '');
const ADMIN = process.env.ALERTS_ADMIN_TOKEN || '';
const FEED = process.env.WORKSHOPS_JSON_URL || `${SITE_ORIGIN}/api/workshops.json`;
const DRY_RUN = process.env.DRY_RUN === '1';
const FORCE_WEEKLY = process.env.FORCE_WEEKLY === '1';
// How long to wait for the daily rebuild when the feed is still yesterday's.
// The cron offset assumes deploy.yml ran on time; on a busy day GitHub starts
// both jobs hours late and in either order. Bounded, and overridable to 0 so a
// local run never sits here.
const FEED_WAIT_MS = Number(process.env.ALERTS_FEED_WAIT_MS ?? 30 * 60_000);
const FEED_POLL_MS = Number(process.env.ALERTS_FEED_POLL_MS ?? 2 * 60_000);

const NOW = new Date();
const NOW_MS = NOW.getTime();
const TODAY = NOW.toISOString().slice(0, 10);

/* ------------------------------------------------------------------ output */

/**
 * This runs in GitHub Actions on a **public** repository, so everything printed
 * here is world-readable. Three rules follow, and they are enforced at the
 * choke points below rather than left to each call site to remember.
 *
 * 1. No address, ever — `redact()`, applied to every route to stdout.
 * 2. No number derived from the subscriber list — `priv()`. Dataset numbers
 *    (workshops, events, slugs) stay exact: they are already published on the
 *    site, so hiding them would cost debuggability and protect nothing. The
 *    line to hold is *derived from the list*, not *is a number*.
 * 3. No per-recipient lines — see `perRecipient()`. Redacting the numbers on
 *    those is useless, because counting the lines recovers the subscriber
 *    count exactly.
 *
 * `ALERTS_VERBOSE=1` restores full detail and is never set by the workflow; it
 * is for running this locally, where the output is not published. Exact figures
 * are also available privately via scripts/alerts_stats.mjs, which is already
 * admin-token gated, so nothing is actually lost to the maintainer.
 */
const VERBOSE = process.env.ALERTS_VERBOSE === '1';

// Deliberately greedy. Over-redacting a log line costs nothing; a pattern with
// clever exceptions is one that eventually lets the wrong thing through.
const EMAIL_RE = /[^\s<>()[\]{},;:"']+@[^\s<>()[\]{},;:"']+\.[A-Za-z]{2,}/g;
const redact = (v) => (typeof v === 'string' ? v.replace(EMAIL_RE, '[redacted]') : v);

/** A count taken from the subscriber list. Qualitative unless run locally. */
const priv = (n) => (VERBOSE ? String(n) : Number(n) > 0 ? 'some' : 'none');

const log = (...a) => console.log(...a.map(redact));
const warn = (...a) => console.warn(...a.map(redact));
/** One line per recipient: emitted only when the output is not public. */
const perRecipient = (...a) => {
  if (VERBOSE) log(...a);
};
const die = (msg) => {
  console.error(`✗ ${redact(msg)}`);
  process.exit(1);
};

if (!API || !ADMIN) die('ALERTS_API_BASE and ALERTS_ADMIN_TOKEN must both be set.');

/* ------------------------------------------------------------- admin client */

/**
 * One call to the Worker. Retries transient failures — a single 502 on the
 * weekly run would otherwise drop that week's digest for everyone.
 */
async function admin(pathname, { method = 'GET', body = null, tries = 3 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(`${API}${pathname}`, {
        method,
        headers: {
          Authorization: `Bearer ${ADMIN}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${json?.error ?? ''}`.trim());
      return json;
    } catch (err) {
      lastErr = err;
      if (attempt < tries) await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  throw new Error(`${method} ${pathname} failed after ${tries} attempts: ${lastErr.message}`);
}

/** Send a batch of rendered messages. A no-op in DRY_RUN. */
async function send(messages, label) {
  if (!messages.length) return { accepted: 0, failed: 0, acceptedIndexes: [] };
  if (DRY_RUN) {
    log(`   [dry-run] would send ${priv(messages.length)} ${label} message(s)`);
    return { accepted: messages.length, failed: 0, acceptedIndexes: messages.map((_, i) => i) };
  }

  let accepted = 0;
  let failed = 0;
  const acceptedIndexes = [];
  for (let i = 0; i < messages.length; i += SEND_CHUNK) {
    const chunk = messages.slice(i, i + SEND_CHUNK);
    const res = await admin('/admin/send', { method: 'POST', body: { messages: chunk } });
    res.results.forEach((r, k) => {
      if (r?.ok) {
        accepted++;
        acceptedIndexes.push(i + k);
      } else {
        failed++;
        // The error text is a provider message, never a recipient.
        warn(`   ! ${label} message rejected: ${r?.error ?? 'unknown'}`);
      }
    });
  }
  return { accepted, failed, acceptedIndexes };
}

/* ------------------------------------------------------------------ helpers */

/** Live projections for a subscriber's starred slugs inside the urgent window,
 *  soonest first. Through `closingWithin` — the one definition of "imminent",
 *  shared with the digest — so its not_running gate applies here too: a
 *  rejected proposal keeps a ticking OpenReview deadline, and a private
 *  re-implementation once read that deadline and would have mailed "41h left"
 *  for a workshop that is not happening. */
function starredImminent(sub, workshops) {
  const mine = {};
  for (const slug of sub.starred_ws ?? []) if (workshops[slug]) mine[slug] = workshops[slug];
  return closingWithin(mine, NOW_MS, URGENT_WINDOW_MS)
    .map((w) => ({ ...w, deadline_key: w.next_stage_utc || w.deadline_utc }));
}

const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fetch and project the public feed; refuses an empty or failed read. */
async function fetchFeed() {
  const res = await fetch(FEED, { headers: { 'User-Agent': 'aiwt-alerts/1.0' } });
  if (!res.ok) die(`could not fetch ${FEED}: HTTP ${res.status}`);
  const live = projectFeed(await res.json());
  if (live.count === 0) die('the workshops feed contained no entries — refusing to proceed');
  return live;
}

/* --------------------------------------------------------------------- main */

/**
 * Write the public /changes/ feed: this week's events, as a committed file the
 * static site build can read.
 *
 * The site cannot reach D1 — it is a static build with no credentials, and the
 * events live nowhere else — so the alternative to a committed artifact is the
 * page recomputing its own diff from git history. That would be a SECOND
 * computation, and the page and the email would then be free to disagree about
 * what happened this week, which is the one thing this must not do.
 *
 * Only events are written, not workshop projections: the site already has every
 * workshop in data/, so the page joins on slug and takes names from the same
 * corpus the rest of the site uses. That keeps the file small and means a
 * workshop cannot be named one way here and another way three pages later.
 *
 * Written on every WEEKLY pass, including quiet ones — an empty `events` array
 * is the honest state for a quiet week, and skipping the write would leave the
 * previous edition on the page claiming to be the current one.
 */
function writeChangesArtifact({ since, events }) {
  const out = {
    generated_at: new Date(NOW_MS).toISOString(),
    since,
    events: events.map((e) => ({
      slug: e.slug,
      kind: e.kind,
      days: e.days ?? null,
      old_utc: e.old_utc ?? null,
      new_utc: e.new_utc ?? null,
    })),
  };
  // Written on a dry run too. DRY_RUN means "mail nobody and mutate nothing
  // upstream" — no send, no snapshot, no event POST, no urgent-log write. A
  // local file is none of those, and the edition it holds is a true statement
  // about its window either way: it comes from /admin/events, which a dry run
  // reads but never changes.
  //
  // That is what makes the page republishable without mailing anyone. Since the
  // write now lives in the weekly pass, an off-Monday republish needs
  // force_weekly as well: dispatch with dry_run AND force_weekly.
  const file = path.join(ROOT, 'data', 'changes.json');
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  log(`   ${DRY_RUN ? '[dry-run] ' : ''}wrote ${path.relative(ROOT, file)} (${out.events.length} event(s))`);
}

async function main() {
  log(`alerts run ${NOW.toISOString()}${DRY_RUN ? '  [DRY RUN]' : ''}`);

  /* 1. fetch + project ---------------------------------------------------- */
  let live = await fetchFeed();
  log(`1. feed: ${live.count} workshops (generated ${live.generated_at})`);

  /* 2-3. diff, record, snapshot ------------------------------------------- */
  const { snapshot } = await admin('/admin/kv/snapshot');
  // Self-heal before warn: an unchanged stamp means today's deploy has not
  // landed yet, so wait for it rather than record a quiet day that was really
  // an early start. If it never comes, proceed anyway — the diff is empty by
  // construction, urgent alerts still go out on the data we have, and
  // tomorrow's run picks up today's changes. Never a failure.
  if (feedUnchanged(snapshot, live) && FEED_WAIT_MS > 0) {
    log(`   feed unchanged since the last run — waiting up to ${Math.round(FEED_WAIT_MS / 60_000)} min for the daily rebuild`);
    const until = Date.now() + FEED_WAIT_MS;
    while (Date.now() < until && feedUnchanged(snapshot, live)) {
      await waitMs(Math.min(FEED_POLL_MS, Math.max(0, until - Date.now())));
      live = await fetchFeed();
    }
    if (feedUnchanged(snapshot, live)) {
      log(`::warning::alerts ran against a feed generated ${live.generated_at}, the same build as the last run — deploy.yml has not rebuilt today. Nothing is lost; the next run diffs both days.`);
    } else {
      log(`   feed rebuilt: ${live.count} workshops (generated ${live.generated_at})`);
    }
  }
  const diff = diffSnapshot(snapshot, live, TODAY);

  if (diff.status === 'abort') {
    // Loud failure, nothing written: a partial fetch must not fabricate events.
    die(`shrink guard: ${diff.reason}`);
  }

  if (diff.status === 'seed') {
    log(`2. ${diff.reason} — storing ${live.count} workshops, sending nothing this run`);
    if (!DRY_RUN) await admin('/admin/kv/snapshot', { method: 'PUT', body: { snapshot: live } });
    else log('   [dry-run] snapshot not written');
    // A seed run still has nothing to diff, but subscribers may well have a
    // starred deadline inside the urgent window right now, so the passes below
    // still run. `events` is simply empty.
  } else {
    const byKind = diff.events.reduce((m, e) => ({ ...m, [e.kind]: (m[e.kind] ?? 0) + 1 }), {});
    log(`2. diff: ${diff.events.length} event(s) ${JSON.stringify(byKind)}`);
    for (const e of diff.events) log(`   ${e.kind.padEnd(19)} ${e.slug}${e.days ? ` (${e.days}d)` : ''}`);

    if (diff.events.length && !DRY_RUN) {
      // Events first, snapshot second. The reverse order loses a day of events
      // permanently if the second call fails.
      await admin('/admin/events', { method: 'POST', body: { observed: TODAY, items: diff.events } });
    }
    if (!DRY_RUN) await admin('/admin/kv/snapshot', { method: 'PUT', body: { snapshot: live } });
    else log('   [dry-run] events and snapshot not written');
  }

  /* subscribers ----------------------------------------------------------- */
  const { subscribers: rows } = await admin('/admin/subscribers');
  const subs = rows.map(normalizeSubscriber).filter(isMailable);
  log(`3. subscribers: ${priv(subs.length)} mailable`);

  /* 4. urgent pass (every run) -------------------------------------------- */
  const urgentSubs = subs.filter(wantsUrgent);
  const candidates = [];
  for (const sub of urgentSubs) {
    for (const w of starredImminent(sub, live.workshops)) {
      candidates.push({ email: sub.email, slug: w.slug, deadline_utc: w.deadline_key });
    }
  }

  let urgentSent = 0;
  if (candidates.length) {
    // Drop anything already sent for this exact deadline VALUE. An extension
    // changes the value, which correctly re-arms the alert.
    const { items: fresh } = await admin('/admin/urgent-filter', { method: 'POST', body: { items: candidates } });
    const bySub = new Map();
    for (const it of fresh) {
      if (!bySub.has(it.email)) bySub.set(it.email, []);
      bySub.get(it.email).push(it);
    }

    const messages = [];
    const logRows = [];
    for (const sub of urgentSubs) {
      const mine = bySub.get(sub.email);
      if (!mine?.length) continue;
      // One combined message per subscriber, never one per workshop.
      const items = mine.map((it) => live.workshops[it.slug]).filter(Boolean);
      const mail = renderUrgent({ sub, tz: sub.tz, items, nowMs: NOW_MS, ids });
      if (!mail) continue;
      messages.push({ to: sub.email, subject: mail.subject, html: mail.html, text: mail.text });
      logRows.push(mine);
      perRecipient(`   urgent: ${mine.length} workshop(s) — ${mine.map((m) => m.slug).join(', ')}`);
    }

    const { accepted, failed, acceptedIndexes } = await send(messages, 'urgent');
    urgentSent = accepted;
    // Log only what the provider accepted: recording a failed send would
    // silently swallow that subscriber's alert for this deadline forever.
    const toLog = acceptedIndexes.flatMap((i) => logRows[i]);
    if (toLog.length && !DRY_RUN) await admin('/admin/urgent-log', { method: 'POST', body: { items: toLog } });
    log(`4. urgent: ${priv(accepted)} sent, ${priv(failed)} failed (${priv(candidates.length - fresh.length)} already sent earlier)`);
  } else {
    log('4. urgent: no starred deadline inside the window');
  }

  /* 4b. saved-workshop change alerts (every run) --------------------------- */
  // Same-day mail for the `starred_changes` cadence. Uses today's classified
  // events, which this run already computed — no extra fetch.
  const changeSubs = subs.filter(wantsStarredChanges);
  let changeSent = 0;
  if (changeSubs.length && diff.events.length) {
    const messages = [];
    const logRows = [];
    for (const sub of changeSubs) {
      const starred = new Set(sub.starred_ws ?? []);
      const mine = diff.events.filter((e) => starred.has(e.slug) && live.workshops[e.slug]);
      if (!mine.length) continue;

      // Deduped through urgent_log on the event's NEW value, under a distinct
      // slug prefix so it cannot collide with the 72h alert's own rows. A
      // re-run on the same day therefore sends nothing twice.
      const triples = mine.map((e) => ({
        email: sub.email,
        slug: `chg:${e.slug}`,
        deadline_utc: e.new_utc || e.observed,
      }));
      const { items: fresh } = await admin('/admin/urgent-filter', { method: 'POST', body: { items: triples } });
      if (!fresh.length) continue;
      const freshSlugs = new Set(fresh.map((t) => t.slug.replace(/^chg:/, '')));
      const events = mine.filter((e) => freshSlugs.has(e.slug));
      if (!events.length) continue;

      const mail = renderStarredChanges({ sub, tz: sub.tz, events, workshops: live.workshops, ids, nowMs: NOW_MS });
      if (!mail) continue;
      messages.push({ to: sub.email, subject: mail.subject, html: mail.html, text: mail.text });
      logRows.push(fresh);
      perRecipient(`   saved-change: ${events.length} event(s) — ${events.map((e) => e.slug).join(', ')}`);
    }

    const { accepted, failed, acceptedIndexes } = await send(messages, 'saved-change');
    changeSent = accepted;
    const toLog = acceptedIndexes.flatMap((i) => logRows[i]);
    if (toLog.length && !DRY_RUN) await admin('/admin/urgent-log', { method: 'POST', body: { items: toLog } });
    log(`4b. saved-workshop changes: ${priv(accepted)} sent, ${priv(failed)} failed`);
  } else {
    log(`4b. saved-workshop changes: nothing to report (${priv(changeSubs.length)} subscriber(s) opted in)`);
  }

  /* 5. weekly pass (Mondays) — the digest, and the page that mirrors it ------
   *
   * ONE fetch, two consumers, and deliberately inside this branch rather than
   * above it.
   *
   * /changes/ is not a live feed of the last seven days. It is the published
   * edition of the digest — the CTA on it says so ("this page, in your inbox
   * every Monday"), and the digest's own "and N more" links point at it as the
   * fuller version of the mail just received. So it must change when the mail
   * changes, and not otherwise: a subscriber who opens Monday's digest saying
   * "45 deadline changes" and clicks through on Thursday has to land on those
   * 45, not on a page that has since rolled forward to a different week and a
   * different count. Rewriting it daily made the email's own numbers wrong by
   * Tuesday.
   *
   * It is the same principle the page itself now follows in its filter and its
   * sort: a record of one week reads the same whenever it is opened. An
   * artifact rewritten daily cannot honour that no matter how the page renders
   * it.
   *
   * To republish between Mondays — after a bad feed, or to pick up a rendering
   * fix — dispatch with dry_run AND force_weekly: that rebuilds the edition and
   * commits it without mailing anyone.
   */
  const isWeeklyDay = NOW.getUTCDay() === WEEKLY_DOW;
  let digestsSent = 0;
  if (isWeeklyDay || FORCE_WEEKLY) {
    const since = new Date(NOW_MS - 7 * 86_400_000).toISOString().slice(0, 10);
    const { events } = await admin(`/admin/events?since=${since}`);
    log(`5. weekly: ${events.length} event(s) since ${since}`);
    writeChangesArtifact({ since, events });

    const messages = [];
    // `starred_changes` subscribers opted out of a scheduled summary entirely.
    const weeklySubs = subs.filter(wantsWeekly);
    for (const sub of weeklySubs) {
      const mine = matchingEvents(events, live.workshops, sub);
      // Sections 3 and 4 read the live projection rather than events, so the
      // projection is narrowed with the same tested matcher — a subscriber with
      // no events at all can still have deadlines closing this week.
      const scoped = Object.fromEntries(
        Object.entries(live.workshops).filter(([, w]) => matchesSubscriber(w, sub)),
      );
      const mail = renderDigest({ sub, tz: sub.tz, events: mine, workshops: scoped, nowMs: NOW_MS, ids });
      // An empty digest is skipped entirely — quiet weeks send nothing.
      if (!mail) continue;
      messages.push({ to: sub.email, subject: mail.subject, html: mail.html, text: mail.text });
      // One line per recipient, so it is suppressed unless run locally —
      // counting these lines would recover the subscriber count exactly.
      if (DRY_RUN) {
        perRecipient(`   digest #${messages.length}: "${mail.subject}" (${mine.length} matched event(s))`);
      }
    }

    const { accepted, failed } = await send(messages, 'digest');
    digestsSent = accepted;
    log(`5. weekly: ${priv(accepted)} sent, ${priv(failed)} failed, ${priv(weeklySubs.length - messages.length)} skipped (empty)`);
  } else {
    log(`5. weekly: not today (UTC day ${NOW.getUTCDay()}, weekly day is ${WEEKLY_DOW})`);
  }

  /* 6. maintenance -------------------------------------------------------- */
  if (!DRY_RUN) {
    const m = await admin('/admin/maintenance', { method: 'POST' });
    log(`6. maintenance: ${priv(m.rate_limit_rows)} rate-limit row(s), ${m.events_pruned} old event(s), ${priv(m.unconfirmed_pruned)} abandoned signup(s), ${priv(m.urgent_log_pruned)} expired urgent-log row(s)`);
  } else {
    log('6. [dry-run] maintenance skipped');
  }

  log(`done — ${priv(urgentSent)} urgent, ${priv(changeSent)} saved-change, ${priv(digestsSent)} digest(s)${DRY_RUN ? ' (dry run: nothing was sent)' : ''}`);
}

main().catch((err) => {
  // Fail loudly: GitHub's failure email is this repo's alerting channel.
  console.error(redact(`✗ alerts run failed: ${err.message}`));
  process.exit(1);
});
