/**
 * Static JSON dump of all workshops — a zero-cost "API" for anyone who wants
 * to build on this data (CC-BY-4.0). Regenerated on every deploy.
 */
import type { APIRoute } from 'astro';
import { workshops, conferenceById, workshopShortName } from '../../lib/data';
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
      // The site's own one-line identity for this workshop: venue noise removed
      // and, where a workshop is split across tracks, the track that tells it
      // apart. Sibling tracks share an acronym upstream — 15 pairs currently do
      // — so `acronym || name` alone cannot distinguish them, and it cannot be
      // reconstructed from this payload either. Emitting it keeps every consumer
      // (including this project's own alerts digest) naming a workshop the way
      // the site does.
      short_name: workshopShortName(w, conferenceById.get(w.conference)?.name ?? w.conference).full,
      track_label: w.trackLabel ?? null,
      conference: w.conference,
      year: w.year,
      website: w.website,
      topics: w.topics ?? [],
      // Whole-corpus derivations. A client cannot work these out from one row:
      // `location_distinguishes` depends on how many places the whole
      // conference-year runs in, and `deadline_change` on the entry's history.
      // Published so the saved list can render exactly what the board renders,
      // instead of drifting into a thinner second implementation of the row.
      location: w.location ?? null,
      location_label: w.locationLabel ?? null,
      location_distinguishes: !!w.locationDistinguishes,
      deadline_change: w.deadlineChange ?? null,
      submission_deadline: w.submission_deadline ?? null,
      timezone: w.timezone ?? null,
      deadline_utc: w.deadlineIso,
      // The formatted strings the board prints. Published so a client rendering
      // a row shows "Sep 26, 2026, 12:59 UTC" rather than re-printing the raw
      // stored value, which is the same instant written a different way.
      deadline_wall_clock: w.deadlineWallClock ?? null,
      abstract_deadline_wall_clock: w.abstractDeadlineWallClock ?? null,
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
