/**
 * The weekly series-identity audit: which pairs of entries to ask Jev about,
 * the question, and how an answer becomes a record in data/series_links.yml.
 *
 * Why this exists. computeRelations() links a series by an address it keeps —
 * one website, or one registered OpenReview stem within one conference — and
 * "What still does not link" (ARCHITECTURE.md) measured the two shapes that
 * leaves out: a series that moves conference AND domain at once (FM4LS at ICML
 * and NeurIPS, SPIGM), and one that renames its stem (ICLR's DPFM /
 * Data_Problems / DATA-FM — three identical names on three websites). 21 stems
 * over 49 entries sat there, some genuine series, some collisions (`aims` is
 * "AI Measurement Science" at COLM and "AI for Mechanism Design" at ICLR), and
 * the note's own condition for touching them was a pair-by-pair audit, "which
 * is most of why it has not been done". This is the audit, done by a reader
 * that costs three thousandths of a cent a pair.
 *
 * How it stays safe. Code chooses the candidates — the same two signals the
 * note names, a shared stem across conferences and agreeing names across years
 * in one conference — and Jev sees only those, never the corpus. Its answer is
 * a Score over three levels that ARE the three things one can do with a pair:
 * leave it (different), ask a person (unclear), link it (same_series). The
 * thresholds are code (LINK_MIN, REVIEW_MIN in lib/workshops.mjs), a pair is
 * asked once and re-asked only when either entry's identity changes (the hash
 * both files share), and a person's decision outranks any probability. The
 * build never sees this module: computeRelations() reads the file through
 * linkedPairs().
 *
 * Pure. The network is injected and the file is passed in and handed back, so
 * scripts/series_audit_test.mjs runs offline; scripts/series_audit.mjs does
 * the I/O.
 */
import * as yaml from 'js-yaml';
import {
  loadConferences,
  venueStem,
  nameTokens,
  namesAgree,
  pairKey,
  pairHash,
  LINK_MIN,
  REVIEW_MIN,
} from './workshops.mjs';
import { askJev, JEV_MODEL } from './jev.mjs';

/** Requests in flight at once. Jev allows 1,200 a minute; the backfill is ~1,800 pairs. */
export const AUDIT_CONCURRENCY = 8;

/**
 * Pairs worth asking about: not already related, and either
 *   - `stem`:  different conferences, the same registered short name — the
 *              moved-conference shape, and where every stem collision lives; or
 *   - `names`: one conference, different years, names that agree by the same
 *              guard Tier 3 uses (two shared tokens or Jaccard ≥ 0.5) — the
 *              renamed-stem shape.
 * Same-conference-year pairs are out of scope: those are tracks, and Tiers 1–2
 * own them. `relations` is computeRelations()' output (slug → related lists).
 */
export function candidatePairs(entries, relations) {
  const related = (a, b) => {
    const r = relations.get(a.slug);
    return !!r && [...r.relatedTracks, ...r.relatedEditions].some((x) => x.slug === b.slug);
  };
  const tokens = new Map(entries.map((e) => [e.slug, nameTokens(e.name ?? '')]));
  const stems = new Map(entries.map((e) => [e.slug, venueStem(e.openreview_venue_id)]));
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      if (a.conference === b.conference && a.year === b.year) continue;
      let why = null;
      if (a.conference !== b.conference && stems.get(a.slug) && stems.get(a.slug) === stems.get(b.slug)) why = 'stem';
      else if (a.conference === b.conference && namesAgree(tokens.get(a.slug), tokens.get(b.slug))) why = 'names';
      if (!why || related(a, b)) continue;
      out.push(a.slug < b.slug ? { a, b, why } : { a: b, b: a, why });
    }
  }
  return out;
}

/** The levels, in order — `same_series` is the last, and its index is what pSame() reads. */
export const SERIES_LEVELS = ['different', 'unclear', 'same_series'];

export function seriesQuestion() {
  return {
    type: 'score',
    instructions:
      'Are `workshop_a` and `workshop_b` two editions (or two tracks) of the same recurring workshop, run by the same ' +
      'community under a continuing identity? A shared short acronym alone does not make two workshops the same series: ' +
      'the full names and subject matter must describe the same recurring workshop.',
    criteria: [
      { level: 'different', description: 'Different workshops that happen to resemble each other — the same acronym used for unrelated topics, or two workshops in one field with different names and aims.' },
      { level: 'unclear', description: 'Plausibly related, but the names and subjects do not settle it; a person should check.' },
      { level: 'same_series', description: 'The same recurring workshop — possibly renamed, at a different conference, or on a new website.' },
    ],
  };
}

/** What one pair is judged on: identity fields only, each conference described by its own row. */
export function pairState(a, b, conferences) {
  const view = (e) => {
    const c = conferences.find((x) => x.id === e.conference);
    return {
      name: e.name ?? '',
      acronym: e.acronym ?? '',
      conference: { name: c?.name ?? String(e.conference ?? ''), full_name: c?.full_name ?? '' },
      year: e.year ?? null,
      website: e.website ?? '',
      openreview_short_name: venueStem(e.openreview_venue_id) ?? '',
      topics: Array.isArray(e.topics) ? e.topics : [],
    };
  };
  return { workshop_a: view(a), workshop_b: view(b) };
}

/**
 * The probability the model put on `same_series`. The API returns a Score's
 * per-level probabilities as an array in criteria order; an object keyed by
 * level name is accepted too, so a shape change upstream degrades to "no
 * answer" rather than to a wrong number.
 */
export function pSame(answer) {
  const p = answer?.probabilities;
  const i = SERIES_LEVELS.indexOf('same_series');
  const v = Array.isArray(p) ? p[i] : p && typeof p === 'object' ? (p.same_series ?? p[i]) : undefined;
  return typeof v === 'number' && v >= 0 && v <= 1 ? v : null;
}

/** link / review / no — the three outcomes a probability maps to in code. */
export function classify(same) {
  if (typeof same !== 'number') return 'no';
  if (same >= LINK_MIN) return 'link';
  if (same >= REVIEW_MIN) return 'review';
  return 'no';
}

const sortPairs = (arr) => [...arr].sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b));

/**
 * One audit pass. Prunes records whose slugs left the dataset, asks Jev about
 * every candidate pair that has no matching record (new, or an identity
 * changed, or the whole file was judged by a different model version), and
 * returns the file to write plus what happened. An unanswered pair (Jev
 * unavailable) is simply not recorded, so next week asks again.
 */
export async function auditSeries({
  entries,
  relations,
  links,
  ask = askJev,
  today = new Date().toISOString().slice(0, 10),
  conferences = loadConferences(),
  concurrency = AUDIT_CONCURRENCY,
  model = JEV_MODEL,
}) {
  const by = new Map(entries.map((e) => [e.slug, e]));
  const keep = (r) => by.has(r.a) && by.has(r.b);
  const pairs = (links.pairs ?? []).filter(keep);
  const decisions = (links.decisions ?? []).filter(keep);
  const pruned = (links.pairs?.length ?? 0) - pairs.length + ((links.decisions?.length ?? 0) - decisions.length);

  // A different pinned model means every recorded probability came from a
  // model that no longer answers; the file is re-judged, decisions kept.
  const stale = !!links.model && links.model !== model;
  const recorded = new Map(stale ? [] : pairs.map((p) => [pairKey(p.a, p.b), p]));
  const decided = new Map(decisions.map((d) => [pairKey(d.a, d.b), d]));

  const todo = [];
  for (const c of candidatePairs(entries, relations)) {
    const key = pairKey(c.a.slug, c.b.slug);
    if (decided.has(key)) continue;
    const hash = pairHash(c.a, c.b);
    if (recorded.get(key)?.hash === hash) continue;
    todo.push({ ...c, key, hash });
  }

  let answered = 0;
  const linkedNow = [];
  const question = { series: seriesQuestion() };
  for (let i = 0; i < todo.length; i += concurrency) {
    const chunk = todo.slice(i, i + concurrency);
    const results = await Promise.all(chunk.map((c) => ask(pairState(c.a, c.b, conferences), question)));
    results.forEach((res, k) => {
      const c = chunk[k];
      const same = res ? pSame(res.answers?.series) : null;
      if (same == null) return;
      answered++;
      const rec = { a: c.a.slug, b: c.b.slug, same: Math.round(same * 100) / 100, judged: today, hash: c.hash, via: c.why };
      const before = recorded.get(c.key);
      recorded.set(c.key, rec);
      if (classify(rec.same) === 'link' && classify(before?.same) !== 'link') linkedNow.push(rec);
    });
  }

  const outPairs = sortPairs([...recorded.values()]);
  const review = outPairs.filter(
    (p) => classify(p.same) === 'review' && !decided.has(pairKey(p.a, p.b)) && pairHash(by.get(p.a), by.get(p.b)) === p.hash,
  );
  return {
    links: { model, pairs: outPairs, decisions: sortPairs(decisions) },
    asked: todo.length,
    answered,
    pruned,
    stale,
    linkedNow,
    review,
  };
}

/** Record a person's verdict on one pair; a later verdict supersedes the earlier one. */
export function decide(links, a, b, verdict, today = new Date().toISOString().slice(0, 10)) {
  if (!['same', 'different'].includes(verdict)) throw new Error(`verdict must be "same" or "different", not "${verdict}"`);
  if (!a || !b || a === b) throw new Error('a decision needs two different slugs');
  const [x, y] = a < b ? [a, b] : [b, a];
  const decisions = (links.decisions ?? []).filter((d) => pairKey(d.a, d.b) !== pairKey(x, y));
  decisions.push({ a: x, b: y, verdict, recorded: today });
  return { ...links, decisions: sortPairs(decisions) };
}

const HEADER = `# Series links judged by Jev — Tier 5 of computeRelations() (docs/ARCHITECTURE.md,
# "Related entries"). WRITTEN BY scripts/series_audit.mjs — do not hand-edit.
#
# A pair links while \`same\` >= ${LINK_MIN} and \`hash\` still matches both entries'
# identity (name, acronym, website, stem, conference, year); a changed entry is
# re-asked. Pairs from ${REVIEW_MIN} up to ${LINK_MIN} are listed in the "workshop series to
# confirm" issue. To overrule the model in either direction, record a decision:
#   node scripts/series_audit.mjs --decide <slug-a> <slug-b> same|different
# or dispatch the "Audit workshop series" workflow with those inputs.
`;

/** The file's text. Flow style per record keeps ~1,800 pairs to one line each. */
export function serializeSeriesLinks(links) {
  return HEADER + yaml.dump({ model: links.model, pairs: links.pairs, decisions: links.decisions }, { lineWidth: 200, flowLevel: 2, noRefs: true });
}

/**
 * The review report — the body of the weekly issue. Empty string when there is
 * nothing to confirm, which is the workflow's cue to close the issue.
 */
export function renderReport({ review, linkedNow, by, today }) {
  const label = (slug) => {
    const e = by.get(slug);
    return e ? `**${e.name}** (${String(e.conference).toUpperCase()} ${e.year}${e.website ? `, ${e.website}` : ''})` : `\`${slug}\``;
  };
  const lines = [];
  if (review.length) {
    lines.push(
      `## Workshop series to confirm`,
      '',
      `Jev put ${review.length} pair(s) between ${REVIEW_MIN} and ${LINK_MIN} on "same series" — plausibly one workshop, not settled by the names. Nothing is linked until a person says so. Record each verdict by dispatching **Audit workshop series** with the two slugs, or locally:`,
      '',
      '```',
      'node scripts/series_audit.mjs --decide <slug-a> <slug-b> same|different',
      '```',
      '',
    );
    for (const p of review) {
      lines.push(`- ${label(p.a)} ~ ${label(p.b)} — same-series **${p.same.toFixed(2)}**, judged ${p.judged} (${p.via}); slugs \`${p.a}\` \`${p.b}\``);
    }
    lines.push('', `This issue is rewritten by every weekly run (${today}) and closes itself once every pair above has a decision or falls out of the band.`);
  }
  if (linkedNow.length) {
    lines.push('', `## Linked this run`, '', `${linkedNow.length} pair(s) at or above ${LINK_MIN}, now shown as "Other editions" on both pages:`, '');
    for (const p of linkedNow) lines.push(`- ${label(p.a)} ~ ${label(p.b)} — **${p.same.toFixed(2)}** (${p.via})`);
  }
  return lines.join('\n').trim();
}
