#!/usr/bin/env node
/**
 * Discovers ALL workshop venues for a conference-year from OpenReview and
 * creates a YAML entry for each one that we don't already track.
 *
 * Everything written is taken from official OpenReview records: title,
 * acronym (subtitle), website, and the real submission deadline — parsed
 * from the venue's human-written `date` line or, when that is blank, from
 * the submission invitation's machine-readable `duedate` (expired
 * invitations included; it's the value shown next to the Submission button
 * on openreview.net). Nothing is estimated. Entries that still lack a
 * deadline are written with a comment template inviting contributors to
 * add it — the site's "know the deadline? Add it in one line" link lands
 * there — and the weekly backfill's rewrite removes the template the
 * moment a real deadline appears.
 *
 * Usage:
 *   node scripts/discover_openreview.mjs --conf icml --year 2026
 *   node scripts/discover_openreview.mjs --conf neurips --year 2025 --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { WORKSHOPS_DIR, listWorkshopFiles, readWorkshopFile } from '../lib/workshops.mjs';

// Prepended to new entries that lack a deadline, so anyone landing in the
// GitHub editor via the site's "know the deadline? Add it" link sees exactly
// what to type. The weekly backfill rewrites the file (yaml.dump) when it
// finds the real deadline, which removes this hint exactly when it becomes
// obsolete.
const DEADLINE_HINT = `# --- Missing: submission deadline -----------------------------------------
# Know it? Add two lines anywhere below, for example:
#   submission_deadline: 2026-09-15 23:59    # or just a date: 2026-09-15
#   timezone: AoE                            # AoE / UTC / America/Los_Angeles
# Then click "Commit changes..." -> "Propose changes" to open a pull request.
# It is validated automatically and usually merged within a day.
# ---------------------------------------------------------------------------
`;

const UA = 'ai-workshop-tracker/1.0 (open-source workshop aggregator; github)';
const CONF_TEMPLATE = {
  icml: 'ICML.cc/{year}/Workshop',
  iclr: 'ICLR.cc/{year}/Workshop',
  neurips: 'NeurIPS.cc/{year}/Workshop',
  icra: 'IEEE.org/ICRA/{year}/Workshop',
  iros: 'IEEE.org/IROS/{year}/Workshop',
  cvpr: 'thecvf.com/CVPR/{year}/Workshop',
  corl: 'robot-learning.org/CoRL/{year}/Workshop',
  colm: 'colmweb.org/COLM/{year}/Workshop',
  eccv: 'thecvf.com/ECCV/{year}/Workshop',
};

const args = process.argv.slice(2);
const getArg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const conf = getArg('--conf');
const year = Number(getArg('--year'));
const dryRun = args.includes('--dry-run');
if (!CONF_TEMPLATE[conf] || !Number.isInteger(year)) {
  console.error(`Usage: node scripts/discover_openreview.mjs --conf <${Object.keys(CONF_TEMPLATE).join('|')}> --year <YYYY> [--dry-run]`);
  process.exit(1);
}

const val = (c, k) => {
  const x = c?.[k];
  return x && typeof x === 'object' && 'value' in x ? x.value : x;
};

/** Map a venue title/subtitle to topic ids via keywords (fallback: other). */
const TOPIC_KEYWORDS = [
  [/math|reason/i, 'math-reasoning'],
  [/language model|\bllm|foundation model/i, 'llms'],
  [/\bnlp\b|natural language/i, 'nlp'],
  [/efficien|compress|quantiz|sparsi|small/i, 'efficiency'],
  [/system/i, 'systems'],
  [/agent/i, 'agents'],
  [/safe|align|trustworth|red.?team/i, 'safety-alignment'],
  [/interpret|explain|mechanis/i, 'interpretability'],
  [/health|medic|clinic|biomed/i, 'healthcare-bio'],
  [/genom|protein|molecul|drug/i, 'genomics'],
  [/scien/i, 'science-applications'],
  [/physic|astro|cosmo|quantum/i, 'physics'],
  [/climate|sustain|earth|weather/i, 'climate'],
  [/robot|embodied/i, 'robotics'],
  [/graph/i, 'graphs'],
  [/time.?series|temporal|forecast/i, 'time-series'],
  [/vision|video|image/i, 'vision'],
  [/speech|audio|music/i, 'speech-audio'],
  [/reinforcement|\brl\b/i, 'reinforcement-learning'],
  [/diffusion/i, 'diffusion'],
  [/generat/i, 'generative-models'],
  [/optimi/i, 'optimization'],
  [/theor/i, 'theory'],
  [/causal/i, 'causality'],
  [/privacy|secur/i, 'privacy'],
  [/federat/i, 'federated-learning'],
  [/fair|ethic|societ|responsib|govern/i, 'fairness'],
  [/benchmark|evaluat/i, 'evaluation-benchmarks'],
  [/dataset|data.?centric|data problem/i, 'datasets'],
  [/multi.?modal/i, 'multimodal'],
  [/tabular|table/i, 'tabular'],
  [/neuro|brain|cogniti/i, 'neuroscience'],
  [/educat|teach/i, 'education'],
];
function guessTopics(text) {
  const hits = [];
  for (const [re, id] of TOPIC_KEYWORDS) {
    if (re.test(text) && !hits.includes(id)) hits.push(id);
    if (hits.length === 3) break;
  }
  return hits.length ? hits : ['other'];
}

const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

/**
 * Parse the deadline out of a group's `date` string, e.g.
 * "Submission Start: Mar 20 2026 12:00PM UTC-0, Submission Deadline: Apr 27 2026 12:00PM UTC-0"
 * Returns { submission_deadline, timezone } normalized to UTC (or AoE when the
 * venue used UTC-12), or null when absent/unparseable.
 */
export function parseGroupDeadline(dateStr) {
  if (typeof dateStr !== 'string') return null;
  const m = dateStr.match(
    /Submission Deadline:\s*([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(AM|PM))?\s*UTC\s*([+-]\d+(?:\.5)?)?/,
  );
  if (!m) return null;
  const [, mon, d, y, hh, mm, ap, off] = m;
  const month = MONTHS[mon];
  if (!month) return null;
  let hour = hh != null ? Number(hh) % 12 : 23;
  if (hh != null && ap === 'PM') hour += 12;
  const minute = hh != null ? Number(mm) : 59;
  const offset = off != null ? Number(off) : 0;
  const pad = (n) => String(n).padStart(2, '0');
  if (offset === -12) {
    // The venue used AoE — keep the wall-clock time as written.
    return { submission_deadline: `${y}-${pad(month)}-${pad(d)} ${pad(hour)}:${pad(minute)}`, timezone: 'AoE' };
  }
  // Normalize any other offset to UTC for exactness.
  const utcMs = Date.UTC(Number(y), month - 1, Number(d), hour, minute) - offset * 3_600_000;
  const dt = new Date(utcMs);
  return {
    submission_deadline: `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}`,
    timezone: 'UTC',
  };
}

const slugify = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'workshop';

/** Convert an OpenReview epoch-ms duedate to our deadline shape.
 *  If the wall clock at UTC-12 is exactly 23:59 the organizers meant AoE —
 *  keep that representation (community convention); otherwise store exact UTC. */
export function msToDeadline(ms) {
  if (!Number.isFinite(ms)) return null;
  const pad = (n) => String(n).padStart(2, '0');
  const aoe = new Date(ms - 12 * 3600 * 1000);
  if (aoe.getUTCHours() === 23 && aoe.getUTCMinutes() === 59) {
    return {
      submission_deadline: `${aoe.getUTCFullYear()}-${pad(aoe.getUTCMonth() + 1)}-${pad(aoe.getUTCDate())} 23:59`,
      timezone: 'AoE',
    };
  }
  const d = new Date(ms);
  return {
    submission_deadline: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    timezone: 'UTC',
  };
}

/** Fallback when the group's human-written `date` line is empty/unparseable:
 *  the submission *invitation* usually carries a machine-readable `duedate`
 *  (it's what renders next to the Submission button on openreview.net). */
export async function deadlineFromInvitation(g) {
  const invId = val(g.content ?? {}, 'submission_id') || `${g.id}/-/Submission`;
  const url = `https://api2.openreview.net/invitations?id=${encodeURIComponent(invId)}&expired=true`;
  // OpenReview rate-limits bulk callers (HTTP 429). A swallowed 429 looks
  // identical to "no deadline exists", which is how ECCV's WICV and ~20
  // siblings imported as "Deadline unknown" despite having a visible duedate.
  // Retry 429/5xx with backoff so throttling no longer masquerades as absence.
  const MAX = 4;
  for (let attempt = 0; attempt < MAX; attempt++) {
    try {
      await new Promise((r) => setTimeout(r, 150 + attempt * attempt * 600)); // 150ms, then backoff
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (res.status === 429 || res.status >= 500) {
        if (attempt < MAX - 1) continue; // retry
        throw new Error(`rate-limited (HTTP ${res.status}) after ${MAX} attempts for ${invId}`);
      }
      if (!res.ok) return null; // genuine miss (e.g. 404 — no submission invitation)
      const { invitations = [] } = await res.json();
      return msToDeadline(invitations[0]?.duedate);
    } catch (err) {
      if (attempt < MAX - 1) continue;
      // Surface persistent throttling instead of hiding it as "no deadline".
      console.warn(`  ⚠ deadline lookup failed for ${invId}: ${err.message}`);
      return null;
    }
  }
  return null;
}

async function main() {
  const prefix = CONF_TEMPLATE[conf].replace('{year}', String(year));
  const res = await fetch(
    `https://api2.openreview.net/groups?prefix=${encodeURIComponent(prefix + '/')}&limit=1000`,
    { headers: { 'User-Agent': UA, Accept: 'application/json' } },
  );
  if (!res.ok) throw new Error(`OpenReview HTTP ${res.status}`);
  const { groups = [] } = await res.json();
  const topRe = new RegExp(`^${prefix.replaceAll('.', '\\.')}/[^/]+$`);
  const allVenues = groups.filter((g) => topRe.test(g.id));
  // Workshops often register separate archival / non-archival track venues —
  // one workshop, two ids. Skip the track twin when its base is present.
  const TRACK_SUFFIX = /[_-](non[_-]?archival(?:[_-]track)?|archival[_-]?track|proceedings[_-]?track|pre[_-]?reviewed|abstract[_-]?(?:paper[_-]?)?track|extended[_-]?abstract[_-]?track)$/i;
  const tailOf = (id) => id.split('/').pop().toLowerCase();
  const tails = new Set(allVenues.map((g) => tailOf(g.id)));
  const venues = allVenues.filter((g) => {
    const t = tailOf(g.id);
    const m = TRACK_SUFFIX.exec(t);
    if (!m) return true;
    const base = t.replace(TRACK_SUFFIX, '');
    return !(tails.has(base) || tails.has(`${base}_archival_track`) || tails.has(`${base}_proceedings_track`) || tails.has(`${base}_main_track`));
  });
  if (venues.length < allVenues.length)
    console.log(`  (skipped ${allVenues.length - venues.length} archival/non-archival track twin(s))`);

  const known = new Map(); // venue_id -> { path, raw }
  for (const f of listWorkshopFiles()) {
    const e = readWorkshopFile(f);
    if (e.raw?.openreview_venue_id) known.set(e.raw.openreview_venue_id, { path: f, raw: e.raw });
  }
  const today = new Date().toISOString().slice(0, 10);
  let created = 0, skipped = 0, backfilled = 0;

  for (const g of venues) {
    if (known.has(g.id)) {
      // Backfill: organizers sometimes publish the deadline on OpenReview
      // after we imported the venue. Fill it in when it appears.
      const { path: fp, raw } = known.get(g.id);
      if (!raw.submission_deadline) {
        const dl = parseGroupDeadline(val(g.content ?? {}, 'date')) || (await deadlineFromInvitation(g));
        if (dl) {
          raw.submission_deadline = dl.submission_deadline;
          raw.timezone = dl.timezone;
          raw.deadline_notes = 'imported from OpenReview — check the website for extensions';
          if (!dryRun) fs.writeFileSync(fp, yaml.dump(raw, { lineWidth: 200, quotingType: '"' }));
          backfilled++;
        }
      }
      skipped++;
      continue;
    }
    const c = g.content ?? {};
    const tail = g.id.split('/').pop();
    const title = String(val(c, 'title') || tail).trim().slice(0, 200);
    let acronym = String(val(c, 'subtitle') || tail).trim();
    if (acronym.length > 40 || acronym === title) acronym = tail.slice(0, 40);
    const websiteRaw = String(val(c, 'website') || '').trim();
    const website = /^https?:\/\//.test(websiteRaw) ? websiteRaw.slice(0, 500) : null;
    const deadline = parseGroupDeadline(val(c, 'date')) || (await deadlineFromInvitation(g));

    const record = { name: title, acronym, conference: conf, year };
    if (website) record.website = website;
    record.topics = guessTopics(`${title} ${acronym}`);
    if (deadline) {
      record.submission_deadline = deadline.submission_deadline;
      record.timezone = deadline.timezone;
      record.deadline_notes = 'imported from OpenReview — check the website for extensions';
    }
    record.openreview_venue_id = g.id;
    record.submission_portal = 'openreview';
    record.notes = `Auto-imported from the OpenReview venue record on ${today} — please verify and enrich (topics are keyword-guessed).`;
    record.added = today;

    let base = `${conf}-${year}-${slugify(tail)}`;
    let file = `${base}.yml`;
    let i = 2;
    while (fs.existsSync(path.join(WORKSHOPS_DIR, file))) file = `${base}-${i++}.yml`;

    if (dryRun) {
      console.log(`[dry-run] would create ${file}  (${title.slice(0, 60)})`);
    } else {
      const body = yaml.dump(record, { lineWidth: 200, quotingType: '"' });
      fs.writeFileSync(path.join(WORKSHOPS_DIR, file), record.submission_deadline ? body : DEADLINE_HINT + body);
    }
    created++;
  }
  console.log(`${conf} ${year}: ${venues.length} venues on OpenReview — ${created} created, ${skipped} already tracked${backfilled ? `, ${backfilled} deadline(s) backfilled` : ''}.`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
