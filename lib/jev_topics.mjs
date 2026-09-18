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
 * the bar. The threshold and the cap are code, not model output.
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
 * here. Half — more likely than not — read against the corpus: real topics
 * landed at 0.6–0.9 and non-topics at 0.1–0.4, with little in between, so the
 * exact value matters less than the ordering.
 */
export const TOPIC_MIN = 0.5;
/** Same cap the keyword table kept; the schema allows up to five. */
export const TOPIC_MAX = 3;

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

/** Policy: ids whose probability clears `min`, strongest first, at most `max`; [] when none. */
export function pickTopics(answers, { min = TOPIC_MIN, max = TOPIC_MAX } = {}) {
  return Object.entries(answers ?? {})
    .map(([id, a]) => [id, typeof a?.noul === 'number' ? a.noul : -1])
    .filter(([, p]) => p >= min)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([id]) => id);
}

/**
 * Jev's topic list for one entry, or null when there is nothing to apply — no
 * judgment available, or no topic cleared the bar — so the caller falls back to
 * the keyword table. `entry` needs name, acronym, conference and year.
 */
export async function suggestTopics(entry, { ask = askJev, topics = loadTopics(), conferences = loadConferences() } = {}) {
  const questions = topicQuestions(topics);
  const res = await ask(topicState(entry, conferences), questions);
  if (!res) return null;
  // Answers come back under our own question ids, so this filter is only a
  // guard against a response shape we did not expect; it never invents an id.
  const picked = pickTopics(res.answers).filter((id) => id in questions);
  return picked.length ? picked : null;
}
