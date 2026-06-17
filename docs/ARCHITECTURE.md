# Architecture & design notes

Why the site is built the way it is, and the behavior details that matter when
modifying it. For setup, deployment, and contribution, see the
[README](../README.md) and [CONTRIBUTING](../CONTRIBUTING.md); this document is
for people changing how the thing works.

Everything here serves one overriding goal: **zero hosting cost and near-zero
maintenance.** Most decisions are downstream of that.

## No backend, no database

The Git repo *is* the database. The site is fully static (Astro), so it hosts
free on GitHub Pages or Cloudflare Pages with nothing to run, patch, or pay for.
Workshop data lives in per-edition YAML files under `data/`; accepted-paper
lists are committed JSON caches under `cache/openreview/`. Builds read these at
build time and never touch a live API or a database.

The UI is deliberately three pages: a search-first homepage (a large search box
over the deadline board; searching swaps the board for faceted results), a
device-local **Saved** list, and **About**. Legacy `/archive`, `/search`,
`/contribute`, and `/calendar` URLs redirect into these.

## Search (Pagefind, static, dual-index)

Search is [Pagefind](https://pagefind.app/): a fully static index built at
deploy time, queried entirely in the browser — no search server. Two indexes
are maintained, one for workshop editions and one for the ~20k accepted-paper
titles, so results can be grouped per workshop with matching papers nested
beneath.

Behavior worth knowing before you touch the search code:

- **Faceting is exact and mutually consistent.** Conference / status / year /
  topic counts are computed client-side from build-time data, so selecting a
  value in one facet instantly re-counts the others. The filter bar works with
  no keyword typed at all (pure browse mode).
- **Multiple keywords are AND at both levels.** A workshop must contain all
  keywords, and a *listed* paper must individually match all of them. Workshops
  where the keywords only co-occur across different papers get a quiet link
  rather than a nested list.
- **Two ordering modes.** Filter-only browsing lists open calls first (soonest
  deadline on top, then upcoming-TBA, then this year's closed calls, then past
  editions newest-first). Typing keywords switches to relevance ranking. The
  result-count line always states which ordering is active.
- **The headline counts what is actually listed.** With keywords: "N workshops ·
  M matching papers · by relevance · page x/y", where N is distinct workshops
  shown and M is individual matching papers inside them. Browsing: "N workshops ·
  open calls first". Results paginate 50 per page; the board paginates 25, both
  with the same numbered pager.
- **Statuses are inferred, not just from dates.** Accepted papers in the cache
  prove a call closed, so status resolves to "Open call", "Deadline unknown"
  (venue never published one), or "Past" from dates *and* paper caches together.

### Surviving deploys

Pagefind loads its hashed index/filter data files lazily on first search, and
every deploy replaces them (and the site redeploys often: weekly rebuild plus
content pushes). A tab opened before a deploy would otherwise get zero results
for every filter. The client guards against this: in browse mode it knows the
exact expected count from build-time data, so zero results where >0 are expected
(or any thrown engine error) is treated as a stale index. It then re-imports the
engine in place (cache-busted) and reruns the search — no page reload — and only
if that also fails does it show an honest message with a reload button.

## Statuses are derived, never stored

`upcoming` / `deadline_passed` / `past` are computed from dates at build time. A
weekly scheduled rebuild keeps them current with zero commits, so an "Open call"
becomes "Past" on its own without anyone editing data.

Deadlines are stored in **UTC**. The importer converts any timezone OpenReview
reports — including AoE (UTC−12) — to the equivalent UTC instant before writing
(`parseGroupDeadline`/`msToDeadline` in `scripts/discover_openreview.mjs`), and
the issue-to-PR bot does the same for contributor submissions (AoE or any civil
timezone → UTC, DST-aware, original kept in `deadline_notes`), so every deadline
that reaches the dataset through either automated path is UTC; the data was also
migrated off a former UTC/AoE mix in one pass. AoE is still an *accepted* value
in the schema, so a hand-written YAML edit may use it (it's the ML convention for
date-only CFPs), and `validate.mjs` requires every deadline — top-level or
per-track — to carry an explicit `timezone`. Whatever the stored zone, the board
and workshop pages convert to the **viewer's local time** at display, so the
label is only reference.

## Multi-track workshops (per-track deadlines)

Some workshops split submissions into tracks with different deadlines (e.g. ECCV
MARINE: Full + Short). The importer detects this via `subTrackInfo()` (sub-track
child groups on OpenReview) and stores a `tracks: [{name, submission_deadline?,
timezone?}]` field; identical-deadline or single tracks collapse to a plain
`submission_deadline` instead. `resolveWorkshop` (lib/workshops.mjs) then derives,
at build time:

- **a rolling headline deadline** — the soonest track still in the future, so when
  an earlier track closes the next one becomes the headline on the next build;
- **status by actionability** — any future track → Open call; else any still-
  unannounced (TBA) track → Deadline unknown (deliberately *not* Past, since a
  track may still open, and the paper-count "call closed" heuristic is suppressed
  while a track is pending); else all announced-and-passed → Past.

The board, search, countdowns, and JSON API consume only the single derived
deadline/status, so they're unchanged; the workshop page additionally renders the
per-track breakdown. The rules are pinned by `scripts/tracks_test.mjs` (run in the
validate CI workflow).

## Back/forward navigation & the bfcache guard

Search state lives in the URL (`?q=…&conf=…&page=…`), so results are
reconstructable on any load. `hydrateFromUrl()` (index.astro) rebuilds the
search from the URL on first paint and runs the search *immediately* (the
non-debounced `pf.search`, since a lone debounced call on restore can be
superseded and swallowed). Results are rendered in a **deterministic order**:
Pagefind sorts by score, but ties (common) aren't ordered stably and its two
indexes load in parallel, so the same keyword could render differently each
run — the page re-sorts by score then by the result's fixed `id`, so identical
searches always produce identical order (guarded by a ui_test assertion).

Back/forward is handled on `pageshow`. A bfcache restore (`event.persisted`)
brings the page back fully intact — rendered results, JS state, listeners — so
re-running the search would be wasteful and can reorder Pagefind's merged
results; the handler therefore re-hydrates *only* when the restored view no
longer matches the URL (or results didn't survive). Separately, because
bfcache can serve a page from a build that predates a deploy (stale markup or
JS — e.g. an old header, or a pre-fix click handler), every page stamps a
`<meta name="build-id">` and, on a persisted restore, fetches the no-store
`/version.json`; if the live build id differs it reloads once. Same-build
restores stay fast and untouched. `BUILD_ID` is the commit SHA in CI.

## Favorites without accounts

Starring a workshop or paper (on the board, in search/filter results, or on a
workshop page) writes to the visitor's own `localStorage`
(`site/src/scripts/favorites.js`): no login, no server, no PII. The `/saved/`
page re-hydrates saved workshops from `/api/workshops.json` so their deadlines
stay live (open calls first), and clusters saved papers by conference
(alphabetical, latest year first within each). Every saved paper's title links
to its workshop page; an exact PDF link sits beside it, derived from the
OpenReview forum id and suppressed for the ~8% of papers with no PDF via
`/api/papers-without-pdf.json`. GoatCounter star events are the only signal
collected, to gauge whether the feature ever justifies real accounts.

Paper snapshots store a stable id (OpenReview forum id where available), the
title, the workshop slug, and the exact PDF url when known. A pre-2026 snapshot
shape (with a `url` field) still renders, so no migration is needed.

## Every content link opens a new tab

A single delegated click-time handler in the base layout opens all content links
in a new tab, including links rendered after page load (search results, the
saved page). Only the site header and same-page anchors navigate in place;
modified clicks (ctrl/cmd/shift/middle) keep native behavior. Deciding at click
time is what makes it cover dynamically rendered surfaces.

## OpenReview only, cached

Paper lists come from the OpenReview API via a monthly job that writes committed
JSON caches; builds never hit the live API. Non-OpenReview workshops just link
out — no scraping of other portals. (CVPR workshops use OpenReview for reviewing
only; their accepted papers live on CVF Open Access, so those entries track
deadlines and links rather than inline paper lists.)

## Calendar feeds instead of email

Static `.ics` feeds (all / per-conference / per-topic / per-workshop) with
built-in 7-day and 1-day alarms stand in for any notification backend. They are
**currently paused** via the `CALENDAR_ENABLED` flag in `site/src/lib/site.ts`
until imported dates are human-verified; while paused, feeds publish zero events
so earlier subscribers' calendars self-clean.

## Contributors are validated by CI, not by a human

Schema and sanity checks comment on PRs with exactly what to fix, and an issue
form auto-converts to PRs for non-technical contributors, so reviewing data
quality isn't a manual burden. See [Automation](../README.md#automation) for the
full workflow list.
