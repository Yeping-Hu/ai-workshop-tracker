/**
 * "Find workshops for your paper" — the pure logic behind the alerts Worker's
 * /match endpoint. Two typed judgments from Jev, both bounded by code:
 *
 *   1. Which topics is the paper about? One yes/no per topic over the title and
 *      abstract — the same vocabulary the workshops carry, with the
 *      descriptions from data/topics.yml travelling in the candidates feed.
 *   2. How well does the paper fit each open call? A Score over four named
 *      levels, asked over the paper plus a small batch of candidates, each
 *      described by its name, acronym, conference, topics and a sample of the
 *      titles its series has accepted before (lib/match_candidates.mjs).
 *
 * Code owns everything around those answers: which candidates to ask about
 * (topic overlap first, the rest as backfill, capped), how to batch them (Jev
 * reads literally and its accuracy falls as the state fills with detail the
 * question does not need — ten candidates is a page, not a corpus), the order
 * of the results (the Score's expected value), and what each match is said to
 * stand on. Nothing here is generated text: every sentence the page shows is a
 * template over these fields, so nothing can be invented about a workshop.
 *
 * Why a Score and not "which workshop is best". A Choice over forty calls would
 * force one winner and spread probability across near-equals; a per-call Score
 * is absolute, so several strong fits can all read as strong and a paper that
 * fits nothing reads as fitting nothing. That last case matters as much as the
 * first — TypeSafe's own note that a Choice is relative and a Score absolute.
 *
 * Runs in the Worker and under Node (scripts/alerts_fit_test.mjs). Imports only
 * the Jev client, which stays free of Node-only modules for exactly this reason.
 */
import { askJev, jevUsage } from '../lib/jev.mjs';

/** A title longer than this is a paragraph pasted in the wrong box. */
export const TITLE_MAX = 300;
/** ~1,000 tokens; an abstract runs 150–300 words. Bounds the model's state and the bill. */
export const ABSTRACT_MAX = 4000;
/**
 * Stage-2 cap. Forty candidates is four batches, so with Turnstile and the
 * feed fetch a request stays well under the 50 outbound calls a Worker on
 * Cloudflare's free plan may make — and it is more open calls than a paper
 * has plausible homes.
 */
export const CANDIDATES_MAX = 40;
/** When topic overlap finds fewer than this, backfill from the rest so a paper with an unusual subject still gets an answer. */
export const CANDIDATES_MIN = 8;
/** Candidates per request. */
export const BATCH = 10;
/** Matches returned. Beyond the tenth the fit is noise and the list is a wall. */
export const MATCHES_SHOWN = 10;
/** A paper topic counts at this probability — the same bar lib/jev_topics.mjs uses for a workshop. */
export const TOPIC_MIN = 0.5;
/** In order: the Score's levels, and what the page calls them. */
export const FIT_LEVELS = ['poor', 'possible', 'good', 'strong'];

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** The request body, checked: `{ ok: true, title, abstract }` or `{ ok: false, error }`. */
export function validateInput(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'bad_request' };
  if (typeof body.title !== 'string' || (body.abstract != null && typeof body.abstract !== 'string')) {
    return { ok: false, error: 'bad_request' };
  }
  const title = clean(body.title);
  const abstract = clean(body.abstract ?? '');
  if (title.length < 3) return { ok: false, error: 'bad_request' };
  if (title.length > TITLE_MAX || abstract.length > ABSTRACT_MAX) return { ok: false, error: 'too_long' };
  return { ok: true, title, abstract };
}

export function paperState({ title, abstract }) {
  return { paper: { title, abstract: abstract || '(no abstract given; judge from the title)' } };
}

/** Stage 1: one noul per topic. `other` is never asked; it is what nothing means. */
export function paperTopicQuestions(topics) {
  const q = {};
  for (const t of topics) {
    if (!t?.id || t.id === 'other') continue;
    const subject = t.description ? `"${t.label}" (${t.description})` : `"${t.label}"`;
    q[t.id] = {
      type: 'noul',
      instructions: `Is ${subject} one of the main topics of this paper? Judge from \`paper.title\` and \`paper.abstract\`.`,
      criteria: {
        true: 'The topic is central to what the paper studies or contributes.',
        false: 'The paper is about something else, or mentions the topic only in passing.',
      },
    };
  }
  return q;
}

/** The paper's topics, strongest first: `[{ id, label, p }]` for every topic asked. */
export function paperTopics(answers, topics) {
  return topics
    .filter((t) => t.id !== 'other')
    .map((t) => ({ id: t.id, label: t.label, p: typeof answers?.[t.id]?.noul === 'number' ? answers[t.id].noul : 0 }))
    .sort((a, b) => b.p - a.p || a.id.localeCompare(b.id));
}

const soonest = (a, b) => (a.deadline_utc ?? '9999').localeCompare(b.deadline_utc ?? '9999') || a.slug.localeCompare(b.slug);

/**
 * Which open calls to ask about. Overlap = the sum of the paper's topic
 * probabilities (those over TOPIC_MIN) across the candidate's topics; the
 * overlapping calls come first, strongest overlap then soonest deadline. If
 * that finds fewer than `min`, the rest are appended by their best single topic
 * probability, so an unusual paper still meets the calls nearest its subject
 * rather than none. Capped at `max`.
 */
export function selectCandidates(candidates, topicProbs, { max = CANDIDATES_MAX, min = CANDIDATES_MIN, topicMin = TOPIC_MIN } = {}) {
  const p = new Map(topicProbs.map((t) => [t.id, t.p]));
  const overlap = (c) => (c.topics ?? []).reduce((n, t) => n + ((p.get(t.id) ?? 0) >= topicMin ? p.get(t.id) : 0), 0);
  const best = (c) => Math.max(0, ...(c.topics ?? []).map((t) => p.get(t.id) ?? 0));
  const scored = candidates.map((c) => ({ c, overlap: overlap(c), best: best(c) }));
  const hits = scored.filter((s) => s.overlap > 0).sort((a, b) => b.overlap - a.overlap || soonest(a.c, b.c));
  const rest = scored.filter((s) => s.overlap === 0).sort((a, b) => b.best - a.best || soonest(a.c, b.c));
  const picked = hits.length >= min ? hits : [...hits, ...rest.slice(0, min - hits.length)];
  return picked.slice(0, max).map((s) => s.c);
}

/** What the model sees of one candidate: identity, topics, evidence — nothing it does not need. */
export function candidateView(c) {
  return {
    name: c.name,
    acronym: c.acronym ?? '',
    conference: c.conference?.full_name ? `${c.conference.name} (${c.conference.full_name})` : String(c.conference?.name ?? ''),
    year: c.year,
    topics: (c.topics ?? []).map((t) => t.label),
    past_accepted_paper_titles: c.past_titles ?? [],
  };
}

/** Stage 2: one Score per candidate in the batch, each pointing at its own entry in `candidates`. */
export function fitQuestions(batch) {
  const q = {};
  batch.forEach((c, i) => {
    q[`fit_${i}`] = {
      type: 'score',
      instructions:
        `How well does the paper (\`paper.title\`, \`paper.abstract\`) fit the call for papers of the workshop described in ` +
        `\`candidates[${i}]\`: its name, its host conference, its topics, and the sample of titles it accepted before in ` +
        `\`candidates[${i}].past_accepted_paper_titles\` (empty for a first edition — then judge from the name and topics)?`,
      criteria: [
        { level: 'poor', description: 'A different field or problem; this paper would be out of place at that workshop.' },
        { level: 'possible', description: 'The same broad area, but not what the workshop is about; a stretch.' },
        { level: 'good', description: 'Squarely within the workshop\'s scope; a reasonable submission.' },
        { level: 'strong', description: 'Exactly what the workshop asks for; it would sit naturally among its past papers.' },
      ],
    };
  });
  return q;
}

/**
 * A Score answer as `{ level, score }`: `level` the most probable of FIT_LEVELS,
 * `score` the expected value on 0–1 for ordering. Null when the shape is not
 * one this reads, so a change upstream degrades to "unjudged".
 *
 * What the API actually returns (jev-1.13.0, 2026-09-19) is an object keyed by
 * level INDEX — `{"0": 0, "1": 0, "2": 0.09, "3": 0.91}` — beside a `legend`
 * mapping each index to its level. An array and an object keyed by level name
 * are accepted too. Reading only the latter two is how the matcher shipped
 * judging every candidate as "unjudged" and calling the model unavailable
 * while both requests had succeeded; the series audit's reader had the index
 * case, this one did not.
 */
export function fitFromAnswer(answer) {
  const raw = answer?.probabilities;
  const probs = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? FIT_LEVELS.map((level, i) => raw[level] ?? raw[i] ?? raw[String(i)])
      : null;
  if (!probs || probs.length !== FIT_LEVELS.length || !probs.every((x) => typeof x === 'number' && x >= 0 && x <= 1)) return null;
  let top = 0;
  let expected = 0;
  probs.forEach((x, i) => {
    expected += (i * x) / (FIT_LEVELS.length - 1);
    if (x > probs[top]) top = i;
  });
  return { level: FIT_LEVELS[top], score: Math.round(expected * 100) / 100 };
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/**
 * The whole judgment for one paper. `feed` is /api/match-candidates.json;
 * `ask(state, questions)` is the Jev client with the Worker's key bound in.
 * Returns `{ ok: true, ... }` or `{ ok: false, error: 'unavailable' }` when
 * stage 1 got no answer. A stage-2 batch that gets no answer leaves its
 * candidates unjudged and marks the result `partial`, so a wobble at TypeSafe
 * costs a few rows rather than the whole answer.
 */
export async function matchPaper(paper, feed, { ask = askJev, batch = BATCH, shown = MATCHES_SHOWN } = {}) {
  const state = paperState(paper);
  const topics = Array.isArray(feed?.topics) ? feed.topics : [];
  // `detail` is the client's last error — "HTTP 401 (…)", "unreachable after
  // 4 attempts" — so an unavailable answer says why, to the page and to
  // whoever reads it. Never a token or the paper; the client keeps only the
  // status and the API's own message.
  const first = await ask(state, paperTopicQuestions(topics));
  if (!first) return { ok: false, error: 'unavailable', detail: jevUsage().lastError ?? null };
  const probs = paperTopics(first.answers, topics);

  const selected = selectCandidates(Array.isArray(feed?.candidates) ? feed.candidates : [], probs);
  const batches = chunk(selected, batch);
  const results = await Promise.all(
    batches.map((b) => ask({ ...state, candidates: b.map(candidateView) }, fitQuestions(b))),
  );
  let partial = false;
  const judged = [];
  batches.forEach((b, k) => {
    const res = results[k];
    if (!res) {
      partial = true;
      return;
    }
    b.forEach((c, i) => {
      const fit = fitFromAnswer(res.answers?.[`fit_${i}`]);
      if (fit) judged.push({ c, ...fit });
    });
  });
  if (selected.length && !judged.length) return { ok: false, error: 'unavailable', detail: jevUsage().lastError ?? null };

  judged.sort((a, b) => b.score - a.score || soonest(a.c, b.c));
  const matches = judged.slice(0, shown).map(({ c, level, score }) => ({
    slug: c.slug,
    url: c.url,
    name: c.name,
    short_name: c.short_name ?? c.acronym ?? c.name,
    conference: { id: c.conference?.id ?? null, name: c.conference?.name ?? '' },
    year: c.year,
    deadline_utc: c.deadline_utc ?? null,
    deadline_wall_clock: c.deadline_wall_clock ?? null,
    website: c.website ?? null,
    topics: (c.topics ?? []).map((t) => t.label),
    fit: level,
    score,
    // What the judgment stood on — shown, never hidden. A first edition has
    // only its name and topics, and the page says so.
    basis: (c.past_paper_count ?? 0) > 0 ? 'past_papers' : 'name_topics',
    past_paper_count: c.past_paper_count ?? 0,
  }));
  return {
    ok: true,
    model: first.model ?? null,
    paper_topics: probs.filter((t) => t.p >= TOPIC_MIN).slice(0, 5).map((t) => ({ id: t.id, label: t.label, p: Math.round(t.p * 100) / 100 })),
    considered: selected.length,
    open_calls: Array.isArray(feed?.candidates) ? feed.candidates.length : 0,
    partial,
    matches,
  };
}
