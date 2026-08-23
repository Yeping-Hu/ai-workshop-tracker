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
 * on openreview.net). Nothing is estimated. Every imported deadline is
 * stored in UTC: whatever offset the venue used (including AoE = UTC-12) is
 * converted to the equivalent UTC instant, so the dataset stays
 * timezone-consistent (the site converts to the viewer's local time at
 * display time regardless). When a workshop leaves its parent group empty
 * and splits submissions into sub-track children (e.g. MARINE/Full +
 * MARINE/Short), discovery descends one level and uses the earliest child
 * deadline plus an inherited website. Entries that still lack a deadline are
 * written with a comment template inviting contributors to add it (a fallback
 * for anyone editing the raw YAML; the site's "know the deadline? Help add it" link
 * opens the edit form), and the weekly backfill's rewrite removes the template
 * the moment a real deadline appears.
 *
 * Deadline sync (extensions): a deadline the bot imported is kept in step with
 * OpenReview on subsequent runs. Each write stamps the exact value into
 * `deadline_notes`; a later run re-syncs only when the stored value still equals
 * that stamp, so any human edit (to the value or the note) permanently freezes
 * the entry. Re-syncs are later-only by default (extensions; never earlier or to
 * null), require a plausible parse, and compare UTC instants. Pre-sync entries
 * (the legacy import marker) are adopted non-destructively — stamped once,
 * deadline untouched — and become eligible the next run. Every value change is
 * logged (stdout, and appended to $DEADLINE_CHANGELOG when set) so the workflow
 * can record each edit in the commit message rather than editing silently.
 *
 * Usage:
 *   node scripts/discover_openreview.mjs --conf icml --year 2026
 *   node scripts/discover_openreview.mjs --conf neurips --year 2025 --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';
import { WORKSHOPS_DIR, listWorkshopFiles, readWorkshopFile, recordDeadlineObservation, loadConferences, stripVenueFromName, cleanAcronym, normalizeAcronym } from '../lib/workshops.mjs';
import { resolveDeadlineUtcMs } from '../lib/dates.mjs';
import { openreviewFetch, recordUnverified, getUnverified } from '../lib/openreview.mjs';

// Prepended to new entries that lack a deadline, so anyone editing the raw YAML
// directly (e.g. via the raw-YAML link in the edit form's intro) sees exactly
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

// --- Deadline-sync provenance ------------------------------------------------
// Every deadline the bot writes is stamped into `deadline_notes` with the exact
// value written. On later runs the bot only re-syncs a deadline whose stored
// value STILL equals that stamp — so any human edit to the value (even one that
// leaves the note untouched) breaks the match and permanently freezes the entry.
const SYNC_NOTE_PREFIX = 'OpenReview-synced';
// The pre-sync import marker used historically (≈700 entries). Treated as
// bot-managed-but-unstamped: adopted non-destructively on first encounter.
export const LEGACY_IMPORT_NOTE = 'imported from OpenReview — check the website for extensions';
// Later-only by default: the bot moves a deadline LATER (the extension case it
// exists for) but never earlier or to null, because a transient/garbled read is
// the dangerous failure mode. Flip to true to also follow earlier corrections
// (riskier; leans on validate.mjs's sanity checks as the net).
const ALLOW_EARLIER = false;
const TWO_YEARS_MS = 2 * 366 * 86_400_000;

/** The note the bot stamps when it sets or updates a deadline. Embeds the exact
 *  value written (UTC) so a later human value-edit is detectable, plus the sync
 *  date for human context. Stays well under the schema's 300-char limit. */
export function syncNote(deadlineValue, today) {
  return `${SYNC_NOTE_PREFIX} ${deadlineValue} UTC (as of ${today}) — extensions on OpenReview are applied automatically; verify on the website.`;
}

/** If `notes` is a bot sync-note, return the deadline value the bot last wrote;
 *  otherwise null (human-written note, legacy marker, SEED estimate, empty…). */
export function syncedValue(notes) {
  if (typeof notes !== 'string') return null;
  const m = notes.match(/^OpenReview-synced (\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?) UTC\b/);
  return m ? m[1] : null;
}

// The note the bot leaves on a freshly imported entry: its topics were guessed
// from the venue title, not curated, so they may be off. It deliberately says
// nothing about the deadline (deadline_notes covers that) and carries no import
// date — the edit form drops it the moment a human curates the topics (see
// isAutoTopicsNote), so it can't go stale.
export const AUTO_TOPICS_NOTE = 'Topics were auto-suggested and may be imprecise — edits welcome.';

/** True if `notes` is the bot's auto-suggested-topics note — the current wording
 *  or the historical "Auto-imported … (topics are keyword-guessed)" form — so the
 *  edit form can drop it once a human curates the topics. */
export function isAutoTopicsNote(notes) {
  if (typeof notes !== 'string') return false;
  if (notes === AUTO_TOPICS_NOTE) return true;
  return /^Auto-imported from the OpenReview venue record on \d{4}-\d{2}-\d{2} — please verify and enrich \(topics are keyword-guessed\)\.?$/.test(notes.trim());
}

/**
 * Decide whether a freshly fetched deadline should replace the stored one.
 * Pure value judgment over UTC instants (ms): the caller owns the separate
 * "is this entry bot-managed / human-untouched" gate and the plausibility
 * check. Comparing instants (not raw strings) means equal-moment/format noise
 * never counts as a change. Returns { update, reason }.
 *   null fetched | null stored -> no update
 *   equal instant              -> no update ("unchanged")
 *   fetched later than stored  -> update ("later")
 *   fetched earlier            -> update only if allowEarlier, else no ("earlier-blocked")
 */
export function decideDeadlineUpdate(storedMs, fetchedMs, { allowEarlier = false } = {}) {
  if (fetchedMs == null) return { update: false, reason: 'no-fetched' };
  if (storedMs == null) return { update: false, reason: 'no-stored' };
  if (fetchedMs === storedMs) return { update: false, reason: 'unchanged' };
  if (fetchedMs > storedMs) return { update: true, reason: 'later' };
  return allowEarlier ? { update: true, reason: 'earlier' } : { update: false, reason: 'earlier-blocked' };
}

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

const val = (c, k) => {
  const x = c?.[k];
  return x && typeof x === 'object' && 'value' in x ? x.value : x;
};

/** The `website` of an OpenReview group's content, validated: a bare http(s)
 *  URL, length-capped. Shared by every reader of the field — venue creation,
 *  the refresh of an existing entry, and the sub-track descent — so all three
 *  accept exactly the same shapes and can't drift apart. Returns null for a
 *  missing, blank, or non-URL value (organizers do occasionally type a bare
 *  hostname or an email address in there). */
/** Compare two URLs ignoring differences that aren't worth a human's attention:
 *  scheme, a leading "www.", a trailing slash, and case. */
export function normalizeWebsite(url) {
  if (!url) return null;
  const n = String(url).trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
  return n || null;
}

export function websiteFromContent(content) {
  const raw = String(val(content ?? {}, 'website') || '').trim();
  // Organizers occasionally put SEVERAL links in this one field (seen in the
  // wild: "http://competition.example; https://workshop.example"). Stored
  // verbatim that becomes a single broken href, so take the first well-formed
  // URL and leave any refinement to a human edit. Split on ';' and whitespace
  // only — commas occur inside legitimate URLs — then drop trailing punctuation
  // left behind by a comma- or period-separated list.
  const first = (raw.split(/[;\s]+/).find((t) => /^https?:\/\/\S+$/.test(t)) || '').replace(/[.,;]+$/, '');
  return /^https?:\/\/\S/.test(first) ? first.slice(0, 500) : null;
}

/** Map a venue title/subtitle to topic ids via keywords (fallback: other).
 *  OpenReview exposes no venue description, so the title + acronym is the only
 *  signal — hence the patterns are deliberately broad (e.g. "manipulation" and
 *  "humanoid" -> robotics, "visual"/"camera"/"perception" -> vision). Ordered
 *  so distinctive domains win the 3-slot budget over generic tags like
 *  evaluation/datasets. Maps only to ids in data/topics.yml. */
const TOPIC_KEYWORDS = [
  // Distinctive domains first.
  [/language model|\bllms?\b|foundation model|\bgpt\b|in.?context learning|instruction.?tun|prompt(ing|s)?\b/i, 'llms'],
  [/\bnlp\b|natural language|tokeniz|multilingual|machine translation|summariz|dialogue|linguistic|named entity|sentiment/i, 'nlp'],
  [/\bvision\b|\bvisual\b|\bimages?\b|\bvideos?\b|camera|perception|\b3d\b|reconstruct|segmentation|object detection|scene understand|rendering|neural field|\bnerf\b|gaussian splat|\bpose\b|point cloud|optical flow|structure.?from.?motion|\bsfm\b|super.?resolution|(pattern|object|action|face|image|gesture) recognition/i, 'vision'],
  [/\brobot|embodied|manipulat|humanoid|locomot|dexter|grasp|legged|quadruped|teleop|sim.?to.?real|sim2real|\bslam\b|autonomous (driv|vehicle|grand challenge|system)|self.?driv|\bdriving\b|autopilot|\buav\b|\bdrone|whole.?body|motion planning|bimanual|tactile|navigation|aerial/i, 'robotics'],
  [/multi.?modal|vision.?language|\bvlm\b|cross.?modal|image.?text/i, 'multimodal'],
  [/speech|\baudio\b|\bmusic\b|\bvoice\b|acoustic|\basr\b|\bsound\b/i, 'speech-audio'],
  [/genom|protein|molecul|\brna\b|\bdna\b|drug discov|bioinformatic|cell biology/i, 'genomics'],
  [/health|medic|clinic|biomed|radiolog|patholog|\behr\b|diagnos|surger|\bdisease\b|healthcare/i, 'healthcare-bio'],
  [/neuro|\bbrain\b|cogniti|\beeg\b|\bfmri\b/i, 'neuroscience'],
  [/\bphysic|astro|cosmo|quantum|particle physics|high.?energy/i, 'physics'],
  [/climate|sustainab|\bearth\b|weather|carbon|renewable|ecolog/i, 'climate'],
  [/\bgraphs?\b|\bgnn\b|geometric deep|knowledge graph|node classif|non.?euclidean|topolog/i, 'graphs'],
  [/time.?series|temporal|forecast|anomaly detection/i, 'time-series'],
  [/tabular|\btables?\b|structured data/i, 'tabular'],
  // Methods.
  [/\bmath|reasoning|theorem|\bproof|formal (verif|method)|\blogic\b/i, 'math-reasoning'],
  [/diffusion|score.?based|denoising/i, 'diffusion'],
  [/generat|\bgans?\b|\bvae\b|synthesis|content creation|text.?to.?image|creativ|flow.?based/i, 'generative-models'],
  [/reinforcement|\brl\b|policy (gradient|optimization|learning)|reward (model|shaping|design)|bandit|q.?learning|actor.?critic|markov decision/i, 'reinforcement-learning'],
  [/optimi|gradient descent|\bconvex|\bsgd\b|second.?order method|minimax/i, 'optimization'],
  [/theor(y|etical)|generalization bound|pac.?learning|learning theory|statistical learning/i, 'theory'],
  [/causal|treatment effect|counterfactual|confound/i, 'causality'],
  [/federat|decentralized learning/i, 'federated-learning'],
  // Cross-cutting concerns.
  [/\bagent|agentic|multi.?agent|tool.?use|\bplanning\b|decision.?making/i, 'agents'],
  [/efficien|compress|quantiz|sparsi|distillation|pruning|low.?rank|on.?device|edge (computing|device)|small (model|language)|low.?resource|limited resource|scarce/i, 'efficiency'],
  [/\bsystems?\b|mlsys|(ml|ai|model|serving|training|compute|data)[- ]?infrastructure|\bserving\b|inference (engine|system)|distributed (training|system)|compiler|mlops/i, 'systems'],
  [/interpret|explain|mechanis|model internal|probing|transparen|attribution|saliency|model behavior/i, 'interpretability'],
  [/\bsafe|alignment|trustworth|red.?team|jailbreak|guardrail|harmful|misuse/i, 'safety-alignment'],
  [/privacy|\bsecur|differential privacy|membership inference|adversarial attack|cryptograph|encrypt/i, 'privacy'],
  [/robust|distribution shift|out.?of.?distribution|\bood\b|domain (shift|adaptation|generaliz)|test.?time (adaptation|training)|corruption|covariate shift|reliab/i, 'robustness'],
  [/\bfair|ethic|societ|responsib|govern|\bbias\b|discrimination|accountab|human.?centered|\bhci\b/i, 'fairness'],
  // Generic / application tags last so they don't crowd out a domain tag.
  [/\bai for science|scientific (discovery|machine|comput)|physics.?inform|materials (science|discovery)|chemistr|astronom|aerospace|remote sensing|earth observ|geospatial|satellite|scientific/i, 'science-applications'],
  [/benchmark|evaluat|leaderboard|\bchallenge\b|competition|\bmetrics?\b/i, 'evaluation-benchmarks'],
  [/dataset|data.?centric|data quality|data curation|corpus|data problem/i, 'datasets'],
  [/educat|teach|tutoring|\bk.?12\b/i, 'education'],
];

/** Up to 3 topic ids whose keywords appear in `text`, in priority order; falls
 *  back to ['other'] when nothing matches. Exported so the re-tag pass and tests
 *  share the exact logic. */
export function guessTopics(text) {
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
 * Returns { submission_deadline, timezone } with the instant always normalized
 * to UTC (any offset, including AoE = UTC-12, is converted — the moment is
 * unchanged, only the representation), or null when absent/unparseable.
 */
// The date grammar OpenReview uses inside a group's free `date` line, e.g.
//   "Submission Start: Jul 01 2026 11:59PM UTC-0, Abstract Registration: Jul 15
//    2026 11:59PM UTC-0, Submission Deadline: Jul 20 2026 11:59PM UTC-0"
// Shared so every labelled component is parsed identically.
const LABELLED_DATE = String.raw`\s*([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(AM|PM))?\s*UTC\s*([+-]\d+(?:\.5)?)?`;

function parseLabelledDate(dateStr, label) {
  if (typeof dateStr !== 'string') return null;
  const m = dateStr.match(new RegExp(label + ':' + LABELLED_DATE));
  if (!m) return null;
  const [, mon, d, y, hh, mm, ap, off] = m;
  const month = MONTHS[mon];
  if (!month) return null;
  let hour = hh != null ? Number(hh) % 12 : 23;
  if (hh != null && ap === 'PM') hour += 12;
  const minute = hh != null ? Number(mm) : 59;
  const offset = off != null ? Number(off) : 0;
  const pad = (n) => String(n).padStart(2, '0');
  // Normalize every offset (including AoE = UTC-12) to exact UTC, so all
  // stored deadlines share one timezone. The instant is unchanged.
  const utcMs = Date.UTC(Number(y), month - 1, Number(d), hour, minute) - offset * 3_600_000;
  const dt = new Date(utcMs);
  return {
    submission_deadline: `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}`,
    timezone: 'UTC',
  };
}

/** The venue's PAPER deadline ("Submission Deadline:"). This is the headline
 *  deadline for every workshop, including the ~3% of venues that also gate on an
 *  earlier abstract registration — the last moment a paper can be submitted. */
export function parseGroupDeadline(dateStr) {
  return parseLabelledDate(dateStr, 'Submission Deadline');
}

/** The earlier, mandatory abstract-registration deadline of a two-stage venue
 *  ("Abstract Registration:"), or null for the ordinary single-stage case.
 *  Deliberately NOT used as the headline: it is surfaced alongside the paper
 *  deadline so the countdown never rolls forward and mimic an extension. Note
 *  this is the same date the `<venue>/-/Submission` invitation's duedate carries
 *  on such venues, which is exactly why the invitation must not be read alone. */
/** Minimum gap for an abstract registration to be a real gate rather than a
 *  formality. Organizers sometimes fill the field a minute before the paper
 *  deadline (NeurIPS EconML: abstract 11:59, paper 12:00), which is not a
 *  two-stage process — surfacing it would put an "ABSTRACT" countdown on the page
 *  that expires sixty seconds before the real one. */
export const MIN_ABSTRACT_GAP_MS = 60 * 60 * 1000;

/** The abstract-registration value when it is far enough ahead of the paper
 *  deadline to matter, otherwise null. Callers store null by REMOVING the field,
 *  so a venue that collapses its two stages stops advertising one. */
export function meaningfulAbstractDeadline(abstractValue, paperValue) {
  if (!abstractValue) return null;
  if (!paperValue) return abstractValue;
  const a = resolveDeadlineUtcMs(abstractValue, 'UTC');
  const p = resolveDeadlineUtcMs(paperValue, 'UTC');
  if (!Number.isFinite(a) || !Number.isFinite(p)) return null;
  return p - a >= MIN_ABSTRACT_GAP_MS ? abstractValue : null;
}

export function parseGroupAbstractDeadline(dateStr) {
  return parseLabelledDate(dateStr, 'Abstract Registration');
}

const slugify = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'workshop';

/** Convert an OpenReview epoch-ms duedate to our deadline shape, always as
 *  exact UTC so every stored deadline shares one timezone (the instant is the
 *  true value from OpenReview either way). */
export function msToDeadline(ms) {
  if (!Number.isFinite(ms)) return null;
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date(ms);
  return {
    submission_deadline: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    timezone: 'UTC',
  };
}

/** Fallback when the group's human-written `date` line is empty/unparseable:
 *  the submission *invitation* usually carries a machine-readable `duedate`
 *  (it's what renders next to the Submission button on openreview.net). */
/**
 * Where the workshop is, as OpenReview publishes it.
 *
 * Free (already in the group content, so no extra request — which matters now
 * the crawler lives inside a 20-per-minute budget) and free text: one city
 * arrives as "Pittsburgh", "Pittsburgh, PA" and "Pittsburgh, Pennsylvania,
 * United States". Stored exactly as given; lib/workshops.mjs folds the
 * spellings together for display, so improving that never needs a data change.
 */
export function locationFromContent(content) {
  const v = val(content ?? {}, 'location');
  const s = typeof v === 'string' ? v.trim() : '';
  return s && s.length <= 200 ? s : null;
}

export async function deadlineFromInvitation(g) {
  const invId = val(g.content ?? {}, 'submission_id') || `${g.id}/-/Submission`;
  const url = `https://api2.openreview.net/invitations?id=${encodeURIComponent(invId)}&expired=true`;
  // OpenReview rate-limits bulk callers (HTTP 429). A swallowed 429 looks
  // identical to "no deadline exists", which is how ECCV's WICV and ~20
  // siblings imported as "Deadline unknown" despite having a visible duedate.
  // Retry 429/5xx with backoff so throttling no longer masquerades as absence.
  // Pacing now comes from lib/openreview.mjs, which spends the budget the
  // server advertises. The retry below is only a backstop for the case where
  // the server 429s despite its own headers saying there was room.
  const MAX = 3;
  for (let attempt = 0; attempt < MAX; attempt++) {
    try {
      if (attempt) await new Promise((r) => setTimeout(r, attempt * attempt * 1000));
      const res = await openreviewFetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (res.status === 429 || res.status >= 500) {
        if (attempt < MAX - 1) continue; // retry
        throw new Error(`rate-limited (HTTP ${res.status}) after ${MAX} attempts for ${invId}`);
      }
      if (!res.ok) return null; // genuine miss (e.g. 404 — no submission invitation)
      const { invitations = [] } = await res.json();
      return msToDeadline(invitations[0]?.duedate);
    } catch (err) {
      if (attempt < MAX - 1) continue;
      // Record it. Returning null alone is indistinguishable from "no deadline
      // exists", which is exactly how ~20 ECCV siblings once imported blank.
      recordUnverified(invId, `deadline lookup: ${err.message}`);
      console.warn(`  ⚠ deadline lookup failed for ${invId}: ${err.message}`);
      return null;
    }
  }
  return null;
}

/** Fetch OpenReview groups under a prefix, retrying on 429/5xx (same
 *  rate-limit hardening as the deadline lookup). Returns [] on persistent
 *  failure rather than throwing, so a throttled sub-track probe degrades to
 *  "no sub-tracks" instead of crashing the whole import. */
export async function fetchGroups(prefix) {
  const url = `https://api2.openreview.net/groups?prefix=${encodeURIComponent(prefix)}&limit=1000`;
  const MAX = 3;
  for (let attempt = 0; attempt < MAX; attempt++) {
    try {
      if (attempt) await new Promise((r) => setTimeout(r, attempt * attempt * 1000));
      const res = await openreviewFetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (res.status === 429 || res.status >= 500) {
        if (attempt < MAX - 1) continue;
        throw new Error(`HTTP ${res.status} after retries`);
      }
      if (!res.ok) return [];
      const { groups = [] } = await res.json();
      return groups;
    } catch (err) {
      if (attempt < MAX - 1) continue;
      // `[]` reads downstream as "no sub-tracks", so a throttled probe would
      // otherwise be filed as a fully checked venue.
      recordUnverified(prefix, `group lookup: ${err.message}`);
      console.warn(`  ⚠ group lookup failed for ${prefix}: ${err.message}`);
      return [];
    }
  }
  return [];
}

/** Some workshops split submissions into sub-track child groups (e.g.
 *  MARINE/Full + MARINE/Short, or Long/Short paper tracks) and leave the
 *  parent group empty — no date, no website, no submission_id. Descend one
 *  level: collect each child's invitation deadline and website. Returns the
 *  EARLIEST deadline across tracks (so "one track open, one TBA" surfaces the
 *  real soonest deadline, not "unknown") plus a website inherited from a
 *  child. Returns {deadline:null, website:null} when there are no such
 *  children, so callers fall through to the normal "Deadline unknown" path. */
export async function subTrackInfo(g, fetchGroups) {
  let children = [];
  try {
    children = (await fetchGroups(`${g.id}/`)).filter(
      (c) => c.id !== g.id && c.id.startsWith(`${g.id}/`) && val(c.content ?? {}, 'submission_id'),
    );
  } catch {
    return { deadline: null, website: null, tracks: [] };
  }
  if (!children.length) return { deadline: null, website: null, tracks: [] };
  let best = null, website = null;
  const tracks = [];
  for (const c of children) {
    if (!website) {
      website = websiteFromContent(c.content ?? {});
    }
    const dl = parseGroupDeadline(val(c.content ?? {}, 'date')) || (await deadlineFromInvitation(c));
    // Track name: the segment after the parent (e.g. ".../MARINE/Full" -> "Full").
    const name = c.id.slice(g.id.length + 1).replace(/[_/]+/g, ' ').trim() || c.id.split('/').pop();
    tracks.push({ name, deadline: dl }); // dl may be null = TBA track
    if (dl && (!best || dl.submission_deadline < best.submission_deadline)) best = dl;
  }
  // Collapse: if every track shares one deadline (or there's only one), it's
  // not really multi-track — let the caller treat it as a plain workshop.
  const dated = tracks.filter((t) => t.deadline);
  const allSame =
    dated.length === tracks.length &&
    dated.every((t) => t.deadline.submission_deadline === dated[0].deadline.submission_deadline);
  const multiTrack = tracks.length > 1 && !allSame;
  return { deadline: best, website, tracks: multiTrack ? tracks : [] };
}

/** Convert subTrackInfo's track list into the stored `tracks` YAML shape:
 *  [{name, submission_deadline?, timezone?}]. TBA tracks keep just a name. */
export function tracksToYaml(tracks) {
  return (tracks || []).map((t) =>
    t.deadline
      ? { name: t.name, submission_deadline: t.deadline.submission_deadline, timezone: t.deadline.timezone }
      : { name: t.name },
  );
}

/**
 * Merge OpenReview's current per-track deadlines (as produced by
 * subTrackInfo -> tracksToYaml) into the stored `tracks` array, matched by
 * track name. This is the multi-track counterpart of decideDeadlineUpdate: it
 * applies the same human-safe, later-only policy PER TRACK —
 *   - stored track blank              -> fill with OpenReview's value
 *   - dated, OpenReview later          -> update (the extension case)      [later-only unless allowEarlier]
 *   - dated, OpenReview earlier         -> keep (earlier-blocked)
 *   - dated, equal instant              -> keep (unchanged)
 *   - OpenReview lists a track we don't  -> add it
 *   - a stored track OpenReview omits     -> keep as-is (never dropped, so a
 *                                            throttled/partial read can't erase a good value)
 * Pure — no network. The caller supplies the fetched OpenReview tracks and owns
 * both the entry-level "is this bot-managed / human-untouched" gate and any
 * plausibility filtering (mirroring how the single-deadline sync is structured).
 * Returns { tracks, changes }; changes is a human-readable "<name>: from -> to"
 * list, empty when nothing moved (so the caller can skip a no-op write).
 */
export function mergeTracks(storedTracks, openreviewTracks, { allowEarlier = false } = {}) {
  const changes = [];
  const byName = new Map();
  const order = [];
  for (const t of storedTracks || []) {
    if (!byName.has(t.name)) order.push(t.name);
    byName.set(t.name, { ...t });
  }
  for (const ot of openreviewTracks || []) {
    if (!ot || !ot.submission_deadline) continue; // still TBA on OpenReview -> nothing to apply
    const cur = byName.get(ot.name);
    if (!cur) {
      byName.set(ot.name, { name: ot.name, submission_deadline: ot.submission_deadline, timezone: ot.timezone || 'UTC' });
      order.push(ot.name);
      changes.push(`${ot.name}: (new track) -> ${ot.submission_deadline} UTC`);
    } else if (!cur.submission_deadline) {
      cur.submission_deadline = ot.submission_deadline;
      cur.timezone = ot.timezone || 'UTC';
      changes.push(`${ot.name}: (blank) -> ${ot.submission_deadline} UTC`);
    } else {
      const storedMs = resolveDeadlineUtcMs(cur.submission_deadline, cur.timezone || 'UTC');
      const fetchedMs = resolveDeadlineUtcMs(ot.submission_deadline, ot.timezone || 'UTC');
      const decision = decideDeadlineUpdate(storedMs, fetchedMs, { allowEarlier });
      if (decision.update) {
        const from = cur.submission_deadline;
        cur.submission_deadline = ot.submission_deadline;
        cur.timezone = ot.timezone || 'UTC';
        changes.push(`${ot.name}: ${from} -> ${ot.submission_deadline} UTC (${decision.reason})`);
      }
    }
  }
  return { tracks: order.map((n) => byName.get(n)), changes };
}

async function main({ conf, year, dryRun }) {
  const prefix = CONF_TEMPLATE[conf].replace('{year}', String(year));
  // Through the limiter like everything else — and being the first request of
  // a cycle, it is what teaches the limiter the current budget before the
  // per-venue burst starts.
  const res = await openreviewFetch(
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
  // Venue ids that are a *duplicate* group for a workshop already tracked
  // elsewhere. Organizers occasionally create two groups for one workshop, and
  // both get imported as separate entries showing contradictory deadlines. The
  // surviving entry records the abandoned id in `merged_venue_ids`, and this is
  // what keeps a re-crawl from simply re-creating what a merge removed.
  const merged = new Map(); // venue_id -> slug it was merged into
  for (const f of listWorkshopFiles()) {
    const e = readWorkshopFile(f);
    if (e.raw?.openreview_venue_id) known.set(e.raw.openreview_venue_id, { path: f, raw: e.raw });
    for (const id of e.raw?.merged_venue_ids ?? []) merged.set(String(id), path.basename(f, '.yml'));
  }
  const today = new Date().toISOString().slice(0, 10);
  let created = 0, skipped = 0, backfilled = 0, updated = 0, adopted = 0;
  const changes = []; // human-readable "old -> new" lines for the commit log

  for (const g of venues) {
    if (merged.has(g.id) && !known.has(g.id)) {
      console.log(`  – ${g.id}: merged into ${merged.get(g.id)}, not re-created`);
      skipped++;
      continue;
    }
    if (known.has(g.id)) {
      const { path: fp, raw } = known.get(g.id);
      let changed = false;
      // OpenReview's current deadline: the group's `date` line is free (already
      // in hand), but the submission invitation's duedate costs a network call,
      // so it is fetched LAZILY — only when a branch actually needs the value.
      // Adopting a legacy entry and skipping a human-frozen one need no value at
      // all, so those paths make ZERO invitation calls. That is what keeps the
      // weekly run (overwhelmingly adoptions right now) inside OpenReview's rate
      // limit, instead of burning one wasted call per venue and getting throttled
      // partway through the conference list.
      let freshDl = parseGroupDeadline(val(g.content ?? {}, 'date'));
      let invTried = false;
      const ensureDl = async () => {
        if (!freshDl && !invTried) { invTried = true; freshDl = await deadlineFromInvitation(g); }
        return freshDl;
      };

      // (A) Backfill missing fields. Organizers sometimes publish the deadline
      // (or a website / sub-tracks) on OpenReview after we imported the venue.
      // The deadline is only ever *filled when absent* here — never overwritten.
      if (!raw.submission_deadline || !raw.website || !raw.tracks) {
        // The venue's OWN website, taken first because it is free (already in
        // hand, like the `date` line) and because it is the common case: the
        // creation path reads this field, so a venue whose organizers fill it in
        // AFTER our import would otherwise never pick it up — a child's website
        // only covers the empty-parent/sub-track shape, so a plain venue stayed
        // blank forever and needed a human edit. Fill-only: a website already in
        // the file (human-added or earlier sync) is left alone.
        const ownWebsite = websiteFromContent(g.content ?? {});
        // Don't re-add a URL that was deliberately removed. `review_ack.website`
        // records an OpenReview value reviewed and declined — including a dead
        // link deleted so the page shows the "help us add it" prompt instead. It
        // is value-specific: if OpenReview later publishes a DIFFERENT site, that
        // one is filled in as normal.
        const declinedWebsite = raw.review_ack?.website;
        const declined = declinedWebsite && normalizeWebsite(declinedWebsite) === normalizeWebsite(ownWebsite);
        if (!raw.website && ownWebsite && !declined) { raw.website = ownWebsite; changed = true; }

        let dl = !raw.submission_deadline ? await ensureDl() : null;
        let subWebsite = null, subTracks = [];
        if (!dl || !raw.website || !raw.tracks) {
          const sub = await subTrackInfo(g, fetchGroups);
          if (!dl && sub.deadline) { dl = sub.deadline; freshDl = freshDl || sub.deadline; }
          subWebsite = sub.website;
          subTracks = tracksToYaml(sub.tracks);
        }
        if (!raw.submission_deadline && dl) {
          recordDeadlineObservation(raw, dl.submission_deadline, today, dl.timezone);
          raw.submission_deadline = dl.submission_deadline;
          raw.timezone = dl.timezone;
          raw.deadline_notes = syncNote(dl.submission_deadline, today);
          changed = true;
          backfilled++;
        }
        if (!raw.website && subWebsite) { raw.website = subWebsite; changed = true; }
        if (!raw.tracks && subTracks.length) { raw.tracks = subTracks; changed = true; }
      }

      // (A2) Two-stage venues: keep the mandatory abstract-registration date in
      // step with OpenReview. Free (parsed from the group `date` line already in
      // hand) and informational — the headline stays the paper deadline — so it
      // is simply mirrored whenever it differs. Never deleted when absent: a
      // date a human added by hand is not silently dropped.
      {
        const abs = parseGroupAbstractDeadline(val(g.content ?? {}, 'date'));
        if (abs && abs.submission_deadline !== (raw.abstract_deadline ?? null)) {
          raw.abstract_deadline = abs.submission_deadline;
          changed = true;
          changes.push(`${raw.conference} ${raw.year} · ${path.basename(fp)}: abstract registration -> ${abs.submission_deadline} UTC`);
        }
      }

      // (A3) Mirror the location, same shape and reasoning as (A2): free — it is
      // in the group content already fetched — and informational, so it is
      // simply kept in step whenever it differs. Never deleted when OpenReview
      // stops reporting one, so a value a human typed is not silently dropped.
      {
        const loc = locationFromContent(g.content ?? {});
        if (loc && loc !== (raw.location ?? null)) {
          raw.location = loc;
          changed = true;
          changes.push(`${raw.conference} ${raw.year} · ${path.basename(fp)}: location -> ${loc}`);
        }
      }

      // (B) Keep an existing *bot-managed, human-untouched* deadline in sync with
      // OpenReview. A deadline counts as bot-managed only if its note still holds
      // the value the bot last wrote (syncedValue) or the pre-sync legacy marker.
      // The instant a human edits the value or note, that match breaks and the
      // entry freezes — the bot never touches it again. Updates are later-only by
      // default, require a plausible non-null parse, and compare UTC instants
      // (never raw strings), so a transient/garbled read can't clobber a good value.
      if (raw.submission_deadline) {
        const lastBot = syncedValue(raw.deadline_notes);
        const isLegacy = raw.deadline_notes === LEGACY_IMPORT_NOTE;
        if (lastBot == null && isLegacy) {
          // First encounter of a legacy-marked entry: adopt it non-destructively
          // — stamp the current value so future human edits become detectable.
          // The deadline itself is left exactly as-is on this pass; real syncing
          // begins next run, once there is a stamp to compare against. No
          // invitation fetch happens here — adoption never uses OpenReview's value.
          raw.deadline_notes = syncNote(raw.submission_deadline, today);
          changed = true;
          adopted++;
        } else if (lastBot != null && lastBot === raw.submission_deadline) {
          // Stamped and untouched since: safe to compare against OpenReview.
          const fetched = await ensureDl();
          const storedMs = resolveDeadlineUtcMs(raw.submission_deadline, raw.timezone || 'UTC');
          const fetchedMs = fetched ? resolveDeadlineUtcMs(fetched.submission_deadline, fetched.timezone || 'UTC') : null;
          const fetchedYear = fetched ? Number(String(fetched.submission_deadline).slice(0, 4)) : null;
          // Skip absurd values rather than failing validate for the whole run.
          const plausible =
            fetchedMs != null &&
            fetchedMs - Date.now() <= TWO_YEARS_MS &&
            fetchedYear != null && Math.abs(fetchedYear - raw.year) <= 1;
          const decision = plausible
            ? decideDeadlineUpdate(storedMs, fetchedMs, { allowEarlier: ALLOW_EARLIER })
            : { update: false, reason: 'implausible' };
          if (decision.update) {
            const from = raw.submission_deadline;
            recordDeadlineObservation(raw, fetched.submission_deadline, today, fetched.timezone);
            raw.submission_deadline = fetched.submission_deadline;
            raw.timezone = fetched.timezone;
            raw.deadline_notes = syncNote(fetched.submission_deadline, today);
            changed = true;
            updated++;
            changes.push(`${conf} ${raw.year} · ${path.basename(fp)}: ${from} UTC -> ${fetched.submission_deadline} UTC (${decision.reason})`);
          } else if (!plausible && fetched) {
            console.warn(`  ⚠ ${path.basename(fp)}: OpenReview deadline "${fetched.submission_deadline}" looks implausible — left unchanged`);
          }
        }
        // else: a non-bot note, or the value no longer matches the stamp => a
        // human curated this deadline. Frozen: leave it alone, no network call.
      }

      if (changed && !dryRun) fs.writeFileSync(fp, yaml.dump(raw, { lineWidth: 200, quotingType: '"' }));
      skipped++;
      continue;
    }
    const c = g.content ?? {};
    const tail = g.id.split('/').pop();
    // OpenReview venue titles routinely repeat the conference and year the
    // entry is already filed under; every surface that shows the name says that
    // already. Strip it here so it never reaches the YAML in the first place.
    const confMeta = loadConferences().find((x) => x.id === conf) ?? {};
    const title = stripVenueFromName(String(val(c, 'title') || tail).trim().slice(0, 200), {
      confName: confMeta.name ?? conf,
      confFullName: confMeta.full_name,
      year,
    });
    let acronym = String(val(c, 'subtitle') || tail).trim();
    if (acronym.length > 40 || acronym === title) acronym = tail.slice(0, 40);
    acronym = normalizeAcronym(acronym, {
      confName: confMeta.name ?? conf,
      confFullName: confMeta.full_name,
      year,
      conf,
    });
    let website = websiteFromContent(c);
    let deadline = parseGroupDeadline(val(c, 'date')) || (await deadlineFromInvitation(g));
    let tracks = [];
    // Empty parent with sub-track children (e.g. MARINE/Full + MARINE/Short):
    // inherit the earliest child deadline, a child website, and record the
    // per-track breakdown so the page can show each track honestly.
    if (!deadline || !website) {
      const sub = await subTrackInfo(g, fetchGroups);
      if (!deadline && sub.deadline) deadline = sub.deadline;
      if (!website && sub.website) website = sub.website;
      tracks = tracksToYaml(sub.tracks);
    }

    const record = { name: title, acronym, conference: conf, year };
    // Omit rather than store "" — matches the entries a human would write.
    if (!record.acronym) delete record.acronym;
    if (website) record.website = website;
    const loc = locationFromContent(g.content ?? {});
    if (loc) record.location = loc;
    record.topics = guessTopics(`${title} ${acronym}`);
    if (deadline) {
      record.submission_deadline = deadline.submission_deadline;
      record.timezone = deadline.timezone;
      record.deadline_notes = syncNote(deadline.submission_deadline, today);
      record.deadline_history = [{ value: deadline.submission_deadline, recorded: today, timezone: deadline.timezone }];
    }
    // Two-stage venue: record the mandatory abstract-registration date too. The
    // headline above stays the PAPER deadline ("Submission Deadline:").
    {
      const abs = parseGroupAbstractDeadline(val(c, 'date'));
      if (abs) record.abstract_deadline = abs.submission_deadline;
    }
    if (tracks.length) record.tracks = tracks;
    record.openreview_venue_id = g.id;
    record.submission_portal = 'openreview';
    record.notes = AUTO_TOPICS_NOTE;
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
  if (changes.length && process.env.DEADLINE_CHANGELOG) {
    fs.appendFileSync(process.env.DEADLINE_CHANGELOG, changes.map((c) => `- ${c}`).join('\n') + '\n');
  }
  // Anything the crawler could not actually reach. Reported next to the
  // totals, because "116 venues, 116 already tracked" read as a complete pass
  // even on the run where five of them were never checked at all.
  const missed = getUnverified();
  if (missed.length && process.env.OPENREVIEW_UNVERIFIED) {
    // A file, not module state: the workflow runs each conference-year as its
    // own `node` process, mirroring how $DEADLINE_CHANGELOG is accumulated.
    fs.appendFileSync(
      process.env.OPENREVIEW_UNVERIFIED,
      missed.map((m) => `${conf}	${year}	${m.id}	${m.reason}`).join('\n') + '\n',
    );
  }
  console.log(
    `${conf} ${year}: ${venues.length} venues on OpenReview — ${created} created, ${skipped} already tracked` +
    `${backfilled ? `, ${backfilled} deadline(s) backfilled` : ''}` +
    `${updated ? `, ${updated} deadline(s) re-synced` : ''}` +
    `${adopted ? `, ${adopted} legacy note(s) adopted` : ''}` +
    `${missed.length ? `, ${missed.length} UNVERIFIED (see warnings)` : ''}.`,
  );
  for (const c of changes) console.log(`    ↳ ${c}`);
  for (const m of missed) console.log(`    ⚠ unverified: ${m.id} — ${m.reason}`);
}

// Only run the CLI when invoked directly, so the exported helpers
// (parseGroupDeadline, msToDeadline, subTrackInfo…) can be imported in tests
// without the module parsing argv and exiting.
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const getArg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
  const conf = getArg('--conf');
  const year = Number(getArg('--year'));
  const dryRun = args.includes('--dry-run');
  if (!CONF_TEMPLATE[conf] || !Number.isInteger(year)) {
    console.error(`Usage: node scripts/discover_openreview.mjs --conf <${Object.keys(CONF_TEMPLATE).join('|')}> --year <YYYY> [--dry-run]`);
    process.exit(1);
  }
  main({ conf, year, dryRun }).catch((e) => { console.error(e.message); process.exit(1); });
}
