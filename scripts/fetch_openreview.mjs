#!/usr/bin/env node
/**
 * Fetches accepted-paper lists from OpenReview for every workshop that has an
 * `openreview_venue_id`, and writes them to cache/openreview/<slug>.json.
 * The site build reads ONLY these committed caches — never the live API —
 * so builds are fast, deterministic, and immune to API downtime.
 *
 * Usage:
 *   node scripts/fetch_openreview.mjs            # fetch all venues missing a cache
 *   node scripts/fetch_openreview.mjs --recent   # (re)fetch current & previous year only
 *   node scripts/fetch_openreview.mjs --all      # (re)fetch everything
 *   node scripts/fetch_openreview.mjs --slug neurips-2024-math-ai
 *
 * Etiquette: paced by lib/openreview.mjs against the budget OpenReview
 * advertises on every response, descriptive User-Agent, per-venue failures are
 * logged and skipped (the job never hard-fails because one venue is down).
 * This job is monthly, but it spends the same per-IP budget as the daily
 * deadline jobs, so it goes through the same gate.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadWorkshops, CACHE_DIR } from '../lib/workshops.mjs';
import { openreviewFetch } from '../lib/openreview.mjs';

const API_V2 = 'https://api2.openreview.net';
const API_V1 = 'https://api.openreview.net';
const UA = 'ai-workshop-tracker/1.0 (open-source workshop aggregator; github)';
const PAGE = 1000;
const MAX_PAPERS = 3000;
// Abstracts are dropped by default to keep the repo small (titles+authors
// still power search). Re-enable with --abstracts 1500.
const abstractsFlag = process.argv.indexOf('--abstracts');
const ABSTRACT_MAX = abstractsFlag !== -1 ? Number(process.argv[abstractsFlag + 1]) || 0 : 0;

const args = process.argv.slice(2);
const mode = args.includes('--all') ? 'all' : args.includes('--recent') ? 'recent' : 'missing';
const onlySlug = args.includes('--slug') ? args[args.indexOf('--slug') + 1] : null;


async function getJson(url) {
  const res = await openreviewFetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function cleanAbstract(s) {
  if (ABSTRACT_MAX <= 0) return '';
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > ABSTRACT_MAX ? t.slice(0, ABSTRACT_MAX) + '…' : t;
}

/** Normalize one OpenReview note (v2: fields are {value}, v1: plain). */
function normalizeNote(note, apiVersion) {
  const c = note.content ?? {};
  const val = (k) => (apiVersion === 2 ? c[k]?.value : c[k]);
  const title = val('title');
  if (!title) return null;
  const pdf = val('pdf');
  const out = {
    title: String(title).trim(),
    authors: Array.isArray(val('authors')) ? val('authors') : [],
    forum_url: note.forum ? `https://openreview.net/forum?id=${note.forum}` : null,
    pdf_url: pdf ? `https://openreview.net/pdf?id=${note.forum ?? note.id}` : null,
  };
  const abstract = cleanAbstract(val('abstract'));
  if (abstract) out.abstract = abstract;
  return out;
}

async function fetchPaged(baseUrl, apiVersion) {
  const papers = [];
  for (let offset = 0; offset < MAX_PAPERS; offset += PAGE) {
    const data = await getJson(`${baseUrl}&limit=${PAGE}&offset=${offset}`);
    const notes = data.notes ?? [];
    for (const n of notes) {
      const p = normalizeNote(n, apiVersion);
      if (p) papers.push(p);
    }
    if (notes.length < PAGE) break;
  }
  return papers;
}

async function fetchVenue(venueId, year) {
  // API v2: accepted papers carry content.venueid = the venue id.
  let papers = await fetchPaged(
    `${API_V2}/notes?content.venueid=${encodeURIComponent(venueId)}`,
    2,
  );
  if (papers.length > 0) return { papers, api: 'v2' };
  // v2 query succeeded but no accepted papers are visible (yet). For modern
  // venues record an empty cache (the monthly refresh fills it once decisions
  // are out) instead of falling back to the long-gone v1 API.
  if (year >= 2024) return { papers: [], api: 'v2' };

  // API v1 fallback (mostly pre-2023 venues). Acceptance filtering on v1 is
  // venue-specific, so this may include non-accepted submissions — flagged in meta.
  for (const inv of ['Blind_Submission', 'Submission']) {
    papers = await fetchPaged(
      `${API_V1}/notes?invitation=${encodeURIComponent(`${venueId}/-/${inv}`)}`,
      1,
    );
    if (papers.length > 0) return { papers, api: 'v1', caveat: 'v1 invitation listing; may include non-accepted submissions' };
  }
  return { papers: [], api: null };
}

const all = loadWorkshops();
const currentYear = new Date().getUTCFullYear();
let targets = all.filter((w) => w.openreview_venue_id);
if (onlySlug) targets = targets.filter((w) => w.slug === onlySlug);
else if (mode === 'recent') targets = targets.filter((w) => w.year >= currentYear - 1);
else if (mode === 'missing')
  targets = targets.filter((w) => !fs.existsSync(path.join(CACHE_DIR, `${w.slug}.json`)));

console.log(`Fetching ${targets.length} venue(s) [mode=${onlySlug ? 'slug' : mode}]\n`);
fs.mkdirSync(CACHE_DIR, { recursive: true });

let changed = 0;
for (const w of targets) {
  process.stdout.write(`• ${w.slug}  (${w.openreview_venue_id}) … `);
  try {
    const { papers, api, caveat } = await fetchVenue(w.openreview_venue_id, w.year);
    if (!api) {
      console.log('no papers found on either API — skipped');
    } else {
      papers.sort((a, b) => a.title.localeCompare(b.title));
      const out = {
        venue_id: w.openreview_venue_id,
        source_api: api,
        ...(caveat ? { caveat } : {}),
        fetched_at: new Date().toISOString(),
        paper_count: papers.length,
        papers,
      };
      const file = path.join(CACHE_DIR, `${w.slug}.json`);
      const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      const next = JSON.stringify(out, null, 1) + '\n';
      // Only rewrite when the paper list itself changed (ignore fetched_at churn).
      const strip = (s) => s?.replace(/"fetched_at": "[^"]+",?\n?/, '');
      if (strip(before) !== strip(next)) {
        fs.writeFileSync(file, next);
        changed++;
        console.log(`${papers.length} papers (${api}) — written`);
      } else {
        console.log(`${papers.length} papers (${api}) — unchanged`);
      }
    }
  } catch (e) {
    console.log(`FAILED: ${e.message} — skipped`);
  }
}
console.log(`\nDone. ${changed} cache file(s) updated.`);
