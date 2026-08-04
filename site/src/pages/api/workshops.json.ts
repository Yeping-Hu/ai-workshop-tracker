/**
 * Static JSON dump of all workshops — a zero-cost "API" for anyone who wants
 * to build on this data (CC-BY-4.0). Regenerated on every deploy.
 */
import type { APIRoute } from 'astro';
import { workshops } from '../../lib/data';
import { REPO_URL } from '../../lib/site';

export const GET: APIRoute = () => {
  const out = {
    generated_at: new Date().toISOString(),
    license: 'CC-BY-4.0',
    source: REPO_URL,
    count: workshops.length,
    workshops: workshops.map((w) => ({
      slug: w.slug,
      name: w.name,
      acronym: w.acronym || null,
      conference: w.conference,
      year: w.year,
      website: w.website,
      topics: w.topics ?? [],
      submission_deadline: w.submission_deadline ?? null,
      timezone: w.timezone ?? null,
      deadline_utc: w.deadlineIso,
      // Two-stage venues only: the mandatory abstract registration that gates
      // the paper deadline above (always UTC). `submission_deadline` remains the
      // paper deadline; `next_stage_utc` is whichever of the two is next.
      abstract_deadline: w.abstract_deadline ?? null,
      abstract_deadline_utc: w.abstractDeadlineUtcMs != null ? new Date(w.abstractDeadlineUtcMs).toISOString() : null,
      next_stage_utc: w.nextStageIso ?? null,
      next_stage_is_abstract: w.nextStageIsAbstract ?? false,
      deadline_notes: w.deadline_notes ?? null,
      notification_date: w.notification_date ?? null,
      workshop_date: w.workshop_date ?? null,
      status: w.status,
      status_label: w.statusLabel,
      submission_portal: w.submission_portal ?? null,
      openreview_venue_id: w.openreview_venue_id ?? null,
      proceedings_url: w.proceedings_url ?? null,
    })),
  };
  return new Response(JSON.stringify(out, null, 1), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
