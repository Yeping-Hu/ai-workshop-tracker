/**
 * Static .ics calendar feeds, generated at build time:
 *   /feeds/all.ics            every deadline
 *   /feeds/<conference>.ics   one conference
 *   /feeds/topic-<id>.ics     one topic
 *   /feeds/ws-<slug>.ics      a single workshop's deadline
 * Includes deadlines that are upcoming or passed within the last 30 days.
 */
import type { APIRoute } from 'astro';
import { workshops, conferences, topics, conferenceById } from '../../lib/data';
import { CALENDAR_ENABLED } from '../../lib/site';
// @ts-ignore - shared plain-JS module at the repo root
import { buildIcs } from '../../../../lib/ics.mjs';

const WINDOW_MS = 30 * 86_400_000;
const NOW = Date.now();
const feedable = workshops.filter(
  (w) =>
    // A calendar reminder for an edition that is not taking place is worse than
    // no reminder at all.
    w.status !== 'not_running' &&
    w.deadlineUtcMs != null &&
    w.deadlineUtcMs > NOW - WINDOW_MS &&
    w.submission_deadline,
);

function toEvent(w: Record<string, any>) {
  const conf = conferenceById.get(w.conference);
  return {
    uid: `${w.slug}@ai-workshop-tracker`,
    dateYmd: String(w.submission_deadline).slice(0, 10),
    summary: `${w.acronym || w.name} deadline (${conf?.name ?? w.conference} ${w.year})`,
    description: `${w.name}\nDeadline: ${w.deadlineWallClock}${w.deadline_notes ? `\nNote: ${w.deadline_notes}` : ''}\n${w.website}`,
    url: w.website,
  };
}

const FEEDS: Record<string, { name: string; items: Record<string, any>[] }> = {
  all: { name: 'AI workshop deadlines — all', items: feedable },
};
for (const c of conferences) {
  const items = feedable.filter((w) => w.conference === c.id);
  if (items.length) FEEDS[c.id] = { name: `AI workshop deadlines — ${c.name}`, items };
}
for (const t of topics) {
  const items = feedable.filter((w) => (w.topics ?? []).includes(t.id));
  if (items.length) FEEDS[`topic-${t.id}`] = { name: `AI workshop deadlines — ${t.label}`, items };
}
for (const w of feedable) {
  FEEDS[`ws-${w.slug}`] = { name: `${w.acronym || w.name} (${w.year}) deadline`, items: [w] };
}

export function getStaticPaths() {
  return Object.keys(FEEDS).map((feed) => ({ params: { feed } }));
}

export const GET: APIRoute = ({ params }) => {
  const feed = FEEDS[params.feed as string];
  // While paused, publish zero events so subscribed calendars clear out.
  const events = CALENDAR_ENABLED ? feed.items.map(toEvent) : [];
  const name = CALENDAR_ENABLED ? feed.name : `${feed.name} (paused)`;
  const body = buildIcs(name, events, new Date());
  return new Response(body, {
    headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
  });
};
