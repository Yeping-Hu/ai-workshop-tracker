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
 *   5. weekly pass (UTC Monday, or FORCE_WEEKLY)
 *   6. maintenance
 *
 * NEVER log an email address or a message body. Counts and slugs only — the
 * workflow log is public on a public repo.
 *
 * Env:
 *   ALERTS_API_BASE     required, e.g. https://api.aiworkshoptracker.com
 *   ALERTS_ADMIN_TOKEN  required, bearer for /admin/*
 *   WORKSHOPS_JSON_URL  optional override of the feed (tests)
 *   DRY_RUN=1           do everything except send, log urgents, write snapshot
 *   FORCE_WEEKLY=1      run the weekly pass on a non-Monday
 *
 * Run: node scripts/alerts_run.mjs
 */
import {
  URGENT_WINDOW_MS,
  WEEKLY_DOW,
  SEND_CHUNK,
  SITE_ORIGIN,
} from '../alerts/config.mjs';
import { projectFeed, diffSnapshot } from '../alerts/diff.mjs';
import {
  normalizeSubscriber,
  matchingEvents,
  matchesSubscriber,
  isMailable,
  wantsUrgent,
} from '../alerts/match.mjs';
import { renderDigest, renderUrgent } from '../alerts/render.mjs';
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

const NOW = new Date();
const NOW_MS = NOW.getTime();
const TODAY = NOW.toISOString().slice(0, 10);

const log = (...a) => console.log(...a);
const die = (msg) => {
  console.error(`✗ ${msg}`);
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
    log(`   [dry-run] would send ${messages.length} ${label} message(s)`);
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
        console.warn(`   ! ${label} message rejected: ${r?.error ?? 'unknown'}`);
      }
    });
  }
  return { accepted, failed, acceptedIndexes };
}

/* ------------------------------------------------------------------ helpers */

/** Live projections for a subscriber's starred slugs, with a parsed next stage. */
function starredImminent(sub, workshops) {
  const out = [];
  for (const slug of sub.starred_ws ?? []) {
    const w = workshops[slug];
    if (!w) continue;
    const iso = w.next_stage_utc || w.deadline_utc;
    if (!iso) continue;
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) continue;
    if (ms >= NOW_MS && ms < NOW_MS + URGENT_WINDOW_MS) out.push({ ...w, next_ms: ms, deadline_key: iso });
  }
  return out.sort((a, b) => a.next_ms - b.next_ms);
}

/* --------------------------------------------------------------------- main */

async function main() {
  log(`alerts run ${NOW.toISOString()}${DRY_RUN ? '  [DRY RUN]' : ''}`);

  /* 1. fetch + project ---------------------------------------------------- */
  const res = await fetch(FEED, { headers: { 'User-Agent': 'aiwt-alerts/1.0' } });
  if (!res.ok) die(`could not fetch ${FEED}: HTTP ${res.status}`);
  const feed = await res.json();
  const live = projectFeed(feed);
  if (live.count === 0) die('the workshops feed contained no entries — refusing to proceed');
  log(`1. feed: ${live.count} workshops (generated ${live.generated_at})`);

  /* 2-3. diff, record, snapshot ------------------------------------------- */
  const { snapshot } = await admin('/admin/kv/snapshot');
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
  log(`3. subscribers: ${subs.length} mailable`);

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
      const mail = renderUrgent({ sub, items, nowMs: NOW_MS, ids });
      if (!mail) continue;
      messages.push({ to: sub.email, subject: mail.subject, html: mail.html, text: mail.text });
      logRows.push(mine);
      log(`   urgent: ${mine.length} workshop(s) — ${mine.map((m) => m.slug).join(', ')}`);
    }

    const { accepted, failed, acceptedIndexes } = await send(messages, 'urgent');
    urgentSent = accepted;
    // Log only what the provider accepted: recording a failed send would
    // silently swallow that subscriber's alert for this deadline forever.
    const toLog = acceptedIndexes.flatMap((i) => logRows[i]);
    if (toLog.length && !DRY_RUN) await admin('/admin/urgent-log', { method: 'POST', body: { items: toLog } });
    log(`4. urgent: ${accepted} sent, ${failed} failed (${candidates.length - fresh.length} already sent earlier)`);
  } else {
    log('4. urgent: no starred deadline inside the window');
  }

  /* 5. weekly pass (Mondays) ---------------------------------------------- */
  const isWeeklyDay = NOW.getUTCDay() === WEEKLY_DOW;
  let digestsSent = 0;
  if (isWeeklyDay || FORCE_WEEKLY) {
    const since = new Date(NOW_MS - 7 * 86_400_000).toISOString().slice(0, 10);
    const { events } = await admin(`/admin/events?since=${since}`);
    log(`5. weekly: ${events.length} event(s) since ${since}`);

    const messages = [];
    for (const sub of subs) {
      const mine = matchingEvents(events, live.workshops, sub);
      // Sections 3 and 4 read the live projection rather than events, so the
      // projection is narrowed with the same tested matcher — a subscriber with
      // no events at all can still have deadlines closing this week.
      const scoped = Object.fromEntries(
        Object.entries(live.workshops).filter(([, w]) => matchesSubscriber(w, sub)),
      );
      const mail = renderDigest({ sub, events: mine, workshops: scoped, nowMs: NOW_MS, ids });
      // An empty digest is skipped entirely — quiet weeks send nothing.
      if (!mail) continue;
      messages.push({ to: sub.email, subject: mail.subject, html: mail.html, text: mail.text });
      if (DRY_RUN) {
        // Subjects and counts are safe to print; addresses and bodies are not.
        log(`   digest #${messages.length}: "${mail.subject}" (${mine.length} matched event(s))`);
      }
    }

    const { accepted, failed } = await send(messages, 'digest');
    digestsSent = accepted;
    log(`5. weekly: ${accepted} sent, ${failed} failed, ${subs.length - messages.length} skipped (empty)`);
  } else {
    log(`5. weekly: not today (UTC day ${NOW.getUTCDay()}, weekly day is ${WEEKLY_DOW})`);
  }

  /* 6. maintenance -------------------------------------------------------- */
  if (!DRY_RUN) {
    const m = await admin('/admin/maintenance', { method: 'POST' });
    log(`6. maintenance: ${m.rate_limit_rows} rate-limit row(s), ${m.events_pruned} old event(s), ${m.unconfirmed_pruned} abandoned signup(s)`);
  } else {
    log('6. [dry-run] maintenance skipped');
  }

  log(`done — ${urgentSent} urgent, ${digestsSent} digest(s)${DRY_RUN ? ' (dry run: nothing was sent)' : ''}`);
}

main().catch((err) => {
  // Fail loudly: GitHub's failure email is this repo's alerting channel.
  console.error(`✗ alerts run failed: ${err.message}`);
  process.exit(1);
});
