/**
 * Topic tagging with Jev — the judgment behind `topics` on a freshly imported
 * entry, and the one the retag sweep re-applies. It is the FIRST guess; the
 * keyword table in discover_openreview.mjs stays as the fallback for when no
 * judgment can be had (lib/jev.mjs returned null) or Jev finds nothing.
 *
 * Why a model here at all. OpenReview exposes no venue description, so the
 * title and acronym are the only signal, and a regex table reading them sent
 * 157 of 944 entries (17%) to `other` — "RemembeRL", "Oops, I Erred", "AI for
 * Nucleic Acids". An `other`-only entry is invisible to every alerts subscriber
 * who picked topics (alerts/match.mjs matches on overlap) and sits in one
 * undifferentiated facet bucket. On ten such titles Jev tagged eight sensibly
 * (2026-09-18, jev-1.13.0); the table tagged none of them.
 *
 * One request per entry, one yes/no question per topic. Nouls rather than one
 * Choice because several topics may apply and each answer is absolute — a
 * Choice would force a single winner and spread probability across near-
 * synonyms (TypeSafe's own guidance: "use one per label when several may
 * apply"). `other` is never asked: it is what code writes when nothing clears
 * the bar. The threshold and the cap are code, not model output. The questions
 * are judged independently — the same probability comes back for a topic asked
 * alone, among four, or among all of them (measured 2026-09-19) — which is
 * what makes the vocabulary tunable: a new or reworded topic is one question
 * re-asked over the corpus (about two cents), not a full pass.
 *
 * The state carries the host conference's `full_name`, because Jev reads
 * literally: told to judge "only from the name and acronym", it ignored that a
 * CoRL workshop is about robots and scored "Learning from Corrections and
 * Interventions" 0.20 for robotics; with the conference described, 0.88.
 * Nothing here is per-conference — the row in conferences.yml describes itself.
 *
 * Pure apart from the two vocabulary loaders, which callers can inject;
 * scripts/jev_topics_test.mjs replays recorded answers offline.
 */
import { loadTopics, loadConferences } from './workshops.mjs';
import { askJev } from './jev.mjs';

/**
 * A topic counts when Jev puts the probability of "central theme" at least
 * here. Read against all 944 entries (2026-09-19): real topics land at 0.6 and
 * up and non-topics under 0.4, and the thin band between 0.5 and 0.6 — one tag
 * in six at the old bar of 0.5 — was right about half the time ("privacy" on a
 * safe-world-models workshop, "time series" on a challenge track). A wrong tag
 * costs more than a missing one: it files the workshop under a filter, a feed
 * and a subscriber's alerts where it does not belong.
 */
export const TOPIC_MIN = 0.6;
/**
 * ...but an entry with nothing over the bar takes its single best topic when
 * that one is at least this likely. The alternative is `other`, which says
 * nothing at all; one tag at even odds or better says something, and it is
 * only ever one.
 */
export const TOPIC_FLOOR = 0.5;
/**
 * What the schema allows. It was three, the keyword table's cap, and at three
 * a real topic was cut on 180 of 944 entries — every COLM workshop spends two
 * on language, every CVPR one on vision, before its actual subject. At five
 * the cap binds on 13.
 */
export const TOPIC_MAX = 5;

/** One noul per topic, `other` excluded. Exported so the sweep and the test share the wording. */
export function topicQuestions(topics) {
  const questions = {};
  for (const t of topics) {
    if (t.id === 'other') continue;
    const subject = t.description ? `"${t.label}" (${t.description})` : `"${t.label}"`;
    questions[t.id] = {
      type: 'noul',
      instructions:
        `Is ${subject} one of the main research topics of this workshop? Judge from \`workshop_name\` and ` +
        '`acronym`, and let the host `conference` inform the judgment: its `full_name` says which field the conference serves.',
      criteria: {
        true: 'The topic is a central theme of the workshop, not a passing mention.',
        false: 'The workshop is about something else, or the topic is only incidental.',
      },
    };
  }
  return questions;
}

/** The state one question set is asked over: the entry's identity plus the conference described by its own row. */
export function topicState({ name, acronym, conference, year }, conferences) {
  const c = conferences.find((x) => x.id === conference);
  return {
    workshop_name: name ?? '',
    acronym: acronym ?? '',
    conference: { name: c?.name ?? String(conference ?? ''), full_name: c?.full_name ?? '' },
    year: year ?? null,
  };
}

/**
 * Policy: ids whose probability clears `min`, strongest first, at most `max`;
 * when none does, the single strongest if it clears `floor`; [] otherwise.
 */
export function pickTopics(answers, { min = TOPIC_MIN, floor = TOPIC_FLOOR, max = TOPIC_MAX } = {}) {
  const ranked = Object.entries(answers ?? {})
    .map(([id, a]) => [id, typeof a?.noul === 'number' ? a.noul : -1])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const over = ranked.filter(([, p]) => p >= min);
  const picked = over.length ? over : ranked.slice(0, 1).filter(([, p]) => p >= floor);
  return picked.slice(0, max).map(([id]) => id);
}

/**
 * What Jev said about one entry: its topic list — [] when it answered and
 * nothing cleared the bar — or null when no judgment could be had at all. The
 * two are different facts and the full re-judge (retag_topics.mjs --all) needs
 * the difference: "nothing fits" sends the entry to the keyword table, as an
 * import would; "no answer" must leave a judged entry exactly as it is, or an
 * outage would overwrite the corpus with keyword guesses.
 */
export async function askTopics(entry, { ask = askJev, topics = loadTopics(), conferences = loadConferences() } = {}) {
  const questions = topicQuestions(topics);
  const res = await ask(topicState(entry, conferences), questions);
  if (!res) return null;
  // Answers come back under our own question ids, so this filter is only a
  // guard against a response shape we did not expect; it never invents an id.
  return pickTopics(res.answers).filter((id) => id in questions);
}

/**
 * Jev's topic list for one entry, or null when there is nothing to apply — no
 * judgment available, or no topic cleared the bar — so the caller falls back to
 * the keyword table. `entry` needs name, acronym, conference and year.
 */
export async function suggestTopics(entry, opts = {}) {
  const picked = await askTopics(entry, opts);
  return picked?.length ? picked : null;
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * What the retag sweep writes for one auto-suggested entry, or null to leave
 * it alone. `jev` is askTopics()'s answer (null = no judgment), `keywords` the
 * keyword table's guess for the same title (['other'] when it has none).
 *
 *   default  — only entries stored as ['other']: Jev's list, else the table's;
 *              nothing is written while the answer is still `other`.
 *   all      — every auto-suggested entry, re-derived as a fresh import would:
 *              Jev's list, the table's when Jev answered and nothing fit. No
 *              answer leaves the entry untouched, so an outage or a missing key
 *              can never trade a judged list for a keyword guess; an unchanged
 *              list is not rewritten.
 */
export function retagDecision(stored, jev, keywords, { all = false } = {}) {
  if (all && jev === null) return null;
  const next = jev?.length ? jev : keywords;
  if (!all && sameList(next, ['other'])) return null;
  return sameList(next, stored) ? null : next;
}
