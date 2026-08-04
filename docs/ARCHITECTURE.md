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

The core UI is a small, fixed set of pages: a search-first homepage (a large
search box over the deadline board; searching swaps the board for faceted
results), a device-local **Saved** list, and **About**, plus a static
per-conference hub at `/conference/<id>/` (see *Discoverability* below). Legacy
`/archive`, `/search`, `/contribute`, and `/calendar` URLs redirect into these.

## Search (Pagefind, static, dual-index)

Search is [Pagefind](https://pagefind.app/): a fully static index built at
deploy time, queried entirely in the browser — no search server. Two indexes
are maintained, one for workshop editions and one for the ~20k accepted-paper
titles, so results can be grouped per workshop with matching papers nested
beneath.

Both indexes are loaded into one Pagefind engine: `pf.init()` for the primary
(workshops) index, then `await pf.mergeIndex(papers)` for the papers index, all
awaited inside a single-flight init promise so no search runs until the dual
index is ready (`ensurePagefind` in index.astro).

The subtle hazard is that Pagefind's `init()` / `mergeIndex()` are **not
idempotent — they append.** A dynamic `import()` of the same engine URL returns
the *same cached module*, backed by the *same Web Worker*, so re-running
init+merge on it loads the papers index a **second** time as duplicate
documents. Locally the duplicates share identical URLs and the per-result URL
de-duplication collapses them, so the counts still look right; on the live CDN
the two loads can resolve paper URLs under slightly different bases, de-dup
fails, and the **same query inflates** — e.g. `llm` climbing from 260 workshops
/ 2325 papers to 513 / 7894, and in the worst case *every* one of the 757
workshops appearing to match (with highlights on unrelated words). It is
intermittent and browser-/edge-dependent, shows up on warm or back/forward-
restored sessions, and the cold first load usually stays correct.

Because the precise live trigger was never reproducible (see the caveat at the
end of this section), this is defended in **layers** rather than trusting any
single guard:

1. **Merge once per worker.** `init()`+`mergeIndex()` run at most once per module
   instance (`pfInited` in `ensurePagefind`); a reused cached module is a no-op,
   so no path stacks a second papers index onto a live worker.
2. **Re-import a merge that looks wrong.** Immediately after merging,
   `mergeLooksClean()` reads `pf.filters().type` — query-independent, exact
   build-time counts — and if the Workshops/Papers totals are grossly off
   (a stacked double reports ~2×; a wipeout reports far too few) it re-imports
   the engine under a cache-busted URL, up to `PF_MERGE_TRIES` times, before any
   query runs.
3. **Every load failure cache-busts.** The failure/heal path always bumps the
   cache-bust so a retry imports a *fresh* URL instead of re-merging onto the
   same half-loaded worker.
4. **The count is immune to duplication regardless.** This is the load-bearing
   layer. `buildState` derives the headline only from distinct
   `/workshop/<slug>/` results: the slug is identical across any duplicate copy
   so duplicates collapse, any merged result whose URL *isn't* a workshop page
   (the artifact form that wouldn't collapse) is dropped from the count, and
   matched papers are de-duped by paper id **and** title. So however the merge
   misbehaves, "N workshops" equals the real distinct workshops and the paper
   count can't be inflated by copies.
5. **Latest-search-wins.** Each search bumps a generation counter (`searchGen`)
   and every `await` re-checks it, so the instant a newer search starts, older
   in-flight searches and their background count-refinements abandon themselves
   and only the most recent one paints. This fixed a bug where typing a keyword
   *without* pressing Enter could show different results than pressing it: each
   keystroke had been starting its own settling loop and they raced.

6. **Big result sets render the first page fast, and a stalled fetch can't hang
   the search.** `buildState` pulls every matched result's data fragment to group
   them by workshop and compute the exact "N workshops · M papers" headline.
   For a large result set that whole fetch+group pass is what the user waits on
   (it can be 5-18s of "Loading N…" over a slow CDN). So when a result set is big
   (more than `PAGE_SIZE * 2`), `runSearch` runs `buildState` **twice**: first
   over a capped slice — enough to fill page one, which is the same top workshops
   either way since results are score-sorted and each workshop's papers ride in
   its own result — and renders immediately (the count line reads "Counting…" and
   the pager is held back); then again over the whole set to finalize the exact
   count and pager. The second pass is resilient: if it stalls or fails, the
   already-shown first page stays. Restoring a deep-linked page (`pendingPage`)
   skips the two-phase split so it lands on the exact page at once. Separately,
   `fetchAllData` wraps the fetch in a 45s timeout — pure insurance against a
   request that truly never returns (a real search can legitimately take well
   over ten seconds, so the bar is high), throwing into the existing failure path
   (fresh engine import + one retry, then reload-the-page) only for the
   first-paint pass. Typing is also debounced — the `input` listener calls
   `runSearch()` (the 220ms `debouncedSearch`) rather than firing an immediate,
   uncoalesced `pf.search` per keystroke — so a multi-letter keyword no longer
   launches several heavy searches at once.

For field diagnosis, `buildState` writes `window.__aiwtSearchDiag`
(`{query, rawResults, droppedNonWorkshop, distinctWorkshops, ts}`) on every
search and logs a `[aiwt-search] merge anomaly` console warning whenever it has
to drop artifacts or the workshop count looks impossibly high. A ui_test also
probes the worker directly (total paper documents vs distinct paper pages, plus
an engine-level check that a second merge stacks while the guard keeps it
single), so a regression is caught even though the slug/URL de-dup would
otherwise mask it.

> **Caveat — not provably fixed at the root.** The underlying behavior — *why*
> the live CDN sometimes resolves the two indexes so a query over-matches — was
> never reproduced in testing (local or live, cold/warm/back-forward all
> returned correct counts; only real users on certain edges hit it). The layers
> above make the **displayed** counts immune to it and make every search path
> agree, and as of this writing the inflation no longer reproduces in the field.
> But that is a defense against the *symptom*, not proof the merge itself is
> clean. **If inflated counts or an Enter-vs-no-Enter discrepancy reappear, this
> is the place to revisit.** The missing diagnostic is the engine state at the
> moment it happens: capture `window.__aiwtSearchDiag` and the `[aiwt-search]`
> console warning from the affected browser — they show whether the raw merge
> over-matched (and by how much) beneath the now-corrected count.

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
every deploy replaces them (and the site redeploys often: daily rebuild plus
content pushes). A tab opened before a deploy would otherwise get zero results
for every filter. The client guards against this: in browse mode it knows the
exact expected count from build-time data, so zero results where >0 are expected
(or any thrown engine error) is treated as a stale index. It then re-imports the
engine in place (cache-busted) and reruns the search — no page reload — and only
if that also fails does it show an honest message with a reload button.

## Statuses are derived, never stored

`upcoming` / `deadline_passed` / `past` are computed from dates at build time. A
daily scheduled rebuild keeps them current with zero commits, so an "Open call"
becomes "Past" on its own (within a day) without anyone editing data.

When a workshop has no explicit `workshop_date`, its event date is **inferred** —
from its conference edition's end date (`data/editions.yml`), or, failing that,
the conference's typical month. That inference must never override a real
deadline: an **open (future) submission deadline always means "Open call", even
past the inferred event date** (`computeStatus` checks the deadline first). Without
this, a challenge/competition whose deadline runs past the main conference — e.g.
a CVPR Codabench competition due after the conference ends — would flip to "Past"
the moment the conference ended, despite still accepting submissions. Once the
deadline itself passes, the inferred date takes over and it becomes "Past" as
expected. Covered by `scripts/status_test.mjs`.

Deadlines are stored in **UTC**. The importer converts any timezone OpenReview
reports — including AoE (UTC−12) — to the equivalent UTC instant before writing
(`parseGroupDeadline`/`msToDeadline` in `scripts/discover_openreview.mjs`), and
the issue-to-PR and edit-to-PR bots do the same for contributor submissions
(AoE or any civil timezone → UTC, DST-aware, original kept in `deadline_notes`), so every deadline
that reaches the dataset through either automated path is UTC; the data was also
migrated off a former UTC/AoE mix in one pass. AoE is still an *accepted* value
in the schema, so a hand-written YAML edit may use it (it's the ML convention for
date-only CFPs), and `validate.mjs` requires every deadline — top-level or
per-track — to carry an explicit `timezone`. Whatever the stored zone, the board
and workshop pages convert to the **viewer's local time** at display, so the
label is only reference.

**Deadline sync (extensions).** A deadline the discovery bot imported is kept in
step with OpenReview on later weekly runs, so an organizer's extension flows in
without a hand edit. The mechanism is provenance-by-stamp: when the bot writes a
deadline it records the exact value in `deadline_notes` (`OpenReview-synced
<value> UTC …`), and a later run re-syncs **only** when the stored value still
equals that stamp. The moment a human edits the deadline — or the note — the
stamp no longer matches and the entry is **frozen**: the bot never touches it
again (this is how human curation always wins over the bot, by design). Re-syncs
are **later-only** by default (extensions; never earlier or to null — a
transient/garbled OpenReview read is the dangerous failure mode), require a
plausible parse (within ±2 years, year within 1 of the edition), and compare UTC
instants rather than raw strings. Pre-sync entries (the legacy `imported from
OpenReview …` marker, ≈700 of them, mostly past years that are never re-scanned)
are **adopted** non-destructively on first encounter — stamped once with their
current value, deadline untouched — and become eligible the next run. The toggle
`ALLOW_EARLIER` in `discover_openreview.mjs` opts into following earlier
corrections too. Every value change is appended to `$DEADLINE_CHANGELOG` and the
weekly workflow folds it into the commit message, so each automated edit is
recorded in history (`git log`) rather than applied silently. Two jobs sync
deadlines — the weekly discovery and the daily imminent re-check (next
paragraph); the monthly `openreview-refresh` still touches only the paper cache.

**Daily imminent re-check (fast extensions).** Extensions are time-sensitive —
they're announced right around the original date — so a separate daily job
(`scripts/recheck_imminent.mjs`, the `recheck-imminent` workflow) catches them
within ~24h instead of up to a week. It re-checks only the bot-managed deadlines
sitting in a band *around* today — `[now − 7 days, now + 14 days]` — computed
fresh each run from the data (there is no list to maintain; entries enter and
leave the window on their own). The forward half catches imminent deadlines; the
look-back half is the point — a workshop whose deadline passed a day or two ago
is still in the band, so a *post-deadline* extension (common) is picked up rather
than missed until the next weekly run. Each in-band entry is re-checked with one
direct OpenReview lookup by its stored `openreview_venue_id` — no enumeration —
and the **same gates apply**: later-only, plausibility, and freeze-on-touch via
the value stamp, so a hand-edited deadline is skipped (left for the cross-check)
and never overwritten. It only re-syncs entries that already carry a stamp;
**legacy adoption, multi-track descent, and discovery of new venues stay weekly**
(`discover_openreview.mjs`), which remains the backstop for anything outside the
band (e.g. an extension announced more than a week late). Cost is a handful of
lookups on a busy day, often zero off-season; changes are appended to
`$DEADLINE_CHANGELOG` and committed exactly like the weekly run. The band +
freeze selection is covered by `scripts/recheck_imminent_test.mjs`.

The `OpenReview-synced …` stamp lives in `deadline_notes` and is shown on a
workshop's **detail page** (with a "verify on the website" caveat), but **not on
the deadline board**: once the backlog was adopted nearly every entry carried
one, which crowded the list, so the board shows only the deadline and countdown
and the full note stays one click away.

Because a human edit freezes auto-sync, two tools cover the manual case. A
weekly **cross-check** (`scripts/deadline_crosscheck.mjs`, the `deadline-review`
workflow) compares upcoming and recently-passed deadlines against OpenReview using
the *same value precedence as every write path* — the venue group's free `date`
line first, the submission invitation's `duedate` only as a fallback — and keeps
ONE self-maintaining issue ("Data health:
deadlines to review", `data-health` label) listing only the cases the auto-sync
will *not* fix on its own: (1) **human-edited** deadlines that now disagree with
OpenReview (frozen, so the maintainer decides which to trust), and (2)
**bot-managed deadlines OpenReview moved earlier** (declined by the later-only
rule, so the maintainer confirms whether it's a real correction). Bot-managed
*later* moves aren't listed — they auto-sync — and legacy entries are skipped
(they adopt then sync), which also keeps the check from fetching their duedates.
The issue updates in place and closes itself when nothing's outstanding; each
item links the re-sync command to accept OpenReview's value. The classifier also
labels a divergence as a likely *timezone slip* (a near whole/half/quarter-hour
offset, ≤14h, not ~a day) vs. a real change, as a hint. Matching that precedence matters: on a two-stage venue the
invitation's `duedate` is the *abstract* date while the stored headline is the
paper deadline, so reading the invitation alone reported a phantom "moved earlier"
for every such workshop — noise that was also dangerous, since accepting it would
have replaced a paper deadline with an abstract-registration date. Lookups are
**batched**: one `/groups?prefix=<conf>/<year>/Workshop/` listing per
conference-year (each venue comes back with its content), then the venues whose
date line carries no deadline are fetched 40 invitation ids at a time. That took a
~190-request run down to ~9 and ended the rate-limit skips that were silently
dropping ~5% of entries per run — a skipped entry is simply not reviewed that
week, which is how a real change once went unreported. And an **on-demand
re-sync** (`scripts/resync_deadline.mjs --slug <slug>`, also a
`workflow_dispatch`) lets a maintainer re-pull one workshop's deadline straight
from OpenReview's duedate in either direction, re-stamping it for future
auto-sync — so fixing a stale or
mistyped deadline never requires hand-typing a UTC time.

OpenReview rate-limits bulk callers (HTTP 429), so the weekly run is tuned to
stay under the limit: the submission-invitation duedate (a network call) is
fetched only when a venue actually needs it — never for the common adopt/frozen
paths — both the group and invitation lookups retry 429/5xx with escalating
backoff, and the workflow spaces conferences apart so each starts with a
recovered budget. Without this the burst from the first conference throttles the
rest, and only it gets processed.

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

## Two-stage venues (abstract registration, then paper)

About 3% of OpenReview venues (6 of 229 sampled) gate paper submission behind an
earlier **mandatory abstract registration**. Their group `date` line carries both
components, e.g. `Abstract Registration: Aug 20 …, Submission Deadline: Aug 29 …`,
and `parseGroupDeadline()` deliberately anchors on *Submission Deadline* so the
stored headline is always the **paper** deadline — the last moment a submission can
land. The earlier date is stored separately in `abstract_deadline` (always UTC),
filled at import and kept current by the daily re-check.

The display rule exists to avoid a specific misreading. If the headline followed
the abstract date, a workshop would show "closed" while papers were still being
accepted, and the later switch to the paper date would look like an *extension*.
So:

- **the shown date never moves** — it is always the paper deadline;
- **the countdown follows whichever stage is next**, labelled `ABSTRACT T−` while
  the abstract stage is open (a `::before` override, so the per-second text rewrite
  can't erase the label), then plain `T−` afterwards;
- **both dates stay visible** — "Abstract due …" while open, "Abstract closed …"
  once passed, never hidden, so nothing can be mistaken for a deadline moving;
- **ordering follows the countdown**, so a row counting down 2 days can't sit below
  one counting down 5.

Deliberately *not* modelled as a `track`: tracks are parallel and their headline is
"soonest open track", which would reintroduce exactly the roll-forward this avoids.
Pinned by `scripts/abstract_deadline_test.mjs`.

## Deadline provenance (append-only observation log)

Every entry whose deadline the automation touches accumulates a
`deadline_history` of `{ value, recorded, timezone }`, oldest first, appended by
all seven write sites (see AUTOMATION.md). It answers "did this move, and when did
we notice?" without a database.

Three deliberate constraints:

- **`recorded` is when *we* observed a value**, not when the organizers changed it.
  We can't know the latter, so the UI states this outright rather than implying a
  precision we don't have.
- **Each entry carries its own `timezone`.** A wall-clock string only fixes an
  instant together with its zone, so re-reading an old value under a zone the entry
  has since changed to shifts it by up to 12 hours (AoE is UTC−12) — enough to
  misreport a delta by a day. It also makes a zone-only move (same wall clock, AoE
  → UTC) a real change rather than a no-op.
- **Only the latest transition is described, and only if it's honest.**
  `deriveDeadlineChange()` reports within a 14-day window and suppresses sub-hour
  deltas, so a timezone re-read never renders as "extended by 0 days".

The board shows one line (`→ Extended N days` / `△ Moved N days earlier` /
`Deadline just announced`); the workshop page adds a callout and a collapsed
history. Everything here is a read-only derivation — status, feeds and the JSON API
are untouched. Pinned by `scripts/deadline_history_test.mjs`.


## Back/forward navigation & the bfcache guard

Search state lives in the URL (`?q=…&conf=…&page=…`), so results are
reconstructable on any load. `hydrateFromUrl()` (index.astro) rebuilds the
search from the URL on first paint and runs the search *immediately* (the
non-debounced `pf.search`, since a lone debounced call on restore can be
superseded and swallowed). On such a first paint the engine itself still has to
load (~1-2s on a cold visit, or a full-reload back-navigation where the bfcache
didn't engage), so until the search resolves `#results` shows a pulsing **loading
skeleton** rather than a blank panel — injected synchronously before the engine
import (the main script is inline, so it lands on screen at first paint) and
replaced by the real list the moment results arrive. Results are rendered in a
**deterministic order**:
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

## External links open a new tab; internal navigation stays in place

A single delegated, click-time handler in the base layout decides link targets
by **host**. A link to a different host (a workshop's own website, an arXiv or
OpenReview PDF) opens in a **new tab**, so the tracker stays available behind it;
a link within the site (a workshop page, a nested paper anchor, the saved list)
navigates in the **same tab** — the standard expectation, and forcing new tabs
for in-site links just clutters the tab bar. Because the decision is made at
click time by comparing `a.host` to `location.host` — not baked into each link's
markup — it automatically covers links rendered after first paint (search
results, the saved page) with nothing to annotate per link. The site header and
same-page anchors are left to navigate in place, and modified clicks
(ctrl/cmd/shift/alt/middle) keep their native behavior.

External links open **programmatically** — `window.open(href, '_blank',
'noopener')` — rather than by setting `target="_blank"` on the element. Mutating
the DOM that way persisted into the back/forward cache, so a restored page came
back with links *(internal ones included)* stuck opening new tabs; opening
programmatically leaves the DOM untouched and keeps the behavior bfcache-safe.
Combined with search state living in the URL and being re-hydrated on a
back/forward restore (see *Back/forward navigation & the bfcache guard* above),
pressing Back brings the results view back **and** internal links still navigate
in the same tab.

This rule is **content-agnostic**, which is what keeps it stable as the data
grows. Host comparison at click time means a newly added workshop's external
website opens a new tab and its in-site page/paper links stay in-tab
automatically — adding workshops or papers never touches the link logic and
cannot change it. The behavior is pinned by `scripts/ui_test.mjs` (internal
workshop/paper titles, the board's workshop name, header nav, and a clicked
result all navigate same-tab; an external workshop website opens a new tab; and
after Back the results restore with internal links still in-tab), so a code
change that regressed any of it would fail the test. See commits `d3f66ce`
(host-based targeting) and `7d5f474` (bfcache-safe `window.open` and
restore-on-back).

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

## What the JSON API exposes for deadlines

`/api/workshops.json` is regenerated on every deploy and is the supported surface
for consumers. Alongside `submission_deadline` / `deadline_utc` (always the
**paper** deadline, so existing consumers keep their meaning) it carries the
two-stage fields: `abstract_deadline` and `abstract_deadline_utc` (null for
single-stage venues), plus `next_stage_utc` and `next_stage_is_abstract` — the
instant the site's countdown targets and which stage that is. `deadline_history`
is intentionally *not* published yet; it is a site-internal derivation for now.

## Contributors are validated by CI, not by a human

Schema and sanity checks comment on PRs with exactly what to fix, and issue
forms (add and edit) auto-convert to PRs for non-technical contributors, so reviewing data
quality isn't a manual burden. See [AUTOMATION.md](AUTOMATION.md) for the
full workflow list.

The add/edit issue forms collect topics as a **multi-select dropdown** and the
deadline as **year/month/day/hour/minute dropdowns**, so a contributor can't
mistype a topic id or a date format — the previous free-text fields put that
burden on CI to reject. GitHub issue templates are static YAML and can't read
`data/topics.yml` at render time, so the topic options are generated into both
templates (between `topic-options` marker comments) by
`scripts/gen_topic_options.mjs`; `scripts/topic_options_sync_test.mjs` fails CI
if a template drifts from the vocabulary. The deadline dropdowns feed
`assembleDeadline()` in `lib/dates.mjs`, the single place that turns the parts
into a `YYYY-MM-DD HH:MM` string (defaulting a missing time to 23:59 and
rejecting impossible dates like Feb 30); the existing timezone→UTC conversion is
unchanged, so there's still one source of truth for deadline math.

A bot-imported entry has its topics keyword-guessed from the venue title, so it
carries a short `notes` flag (`AUTO_TOPICS_NOTE` in `discover_openreview.mjs`:
"topics were auto-suggested — edits welcome"). It's deliberately topic-only (the
deadline has its own `deadline_notes` provenance) and carries no import date,
because the edit transform drops it — via `isAutoTopicsNote`, which also matches
the historical "Auto-imported … (topics are keyword-guessed)" wording — the
moment a human changes the topics through the picker. So it can't go stale: it's
shown exactly while the topics are still machine-guessed, and disappears once
they're curated.

The guesser (`guessTopics`) is purely keyword-based: OpenReview exposes no venue
description, so it regex-matches the title + acronym against a broad pattern table
(mapping only to `data/topics.yml` ids) and keeps up to three hits, falling back
to `['other']` when nothing matches. Because the title is the only signal, the
patterns are intentionally generous (e.g. "manipulation"/"humanoid" → robotics,
"visual"/"camera"/"perception" → vision); `scripts/topics_guess_test.mjs` locks in
the tricky cases. The patterns can be re-run over already-imported entries with
`scripts/retag_topics.mjs`, which re-guesses **only** entries still tagged
`['other']` with the auto-suggested note — so a human-curated topic set is never
overwritten — and rewrites just the topics. That's how a one-off matcher
improvement reclassifies the back catalogue without disturbing curated entries.

## Discoverability: structured data, conference hubs, and llms.txt

The dataset is the point of the site, so several build-time outputs exist purely
to make it findable and citable — by search engines and by AI assistants — with
no added runtime cost.

**Conference hub pages.** `/conference/<id>/`
(`site/src/pages/conference/[conf].astro`) is a static page per conference: every
tracked edition for that conference, grouped by year and, within each year,
ordered by status — open calls first, then deadline-unknown, then past, with the
soonest deadline breaking ties. It gives each conference one stable, crawlable
URL listing its workshops, plus a data-driven FAQ. `getStaticPaths` iterates
`conferences`, so a new conference gets a hub with no further edits. (Astro quirk:
`getStaticPaths` runs in an isolated scope and can't see module-level helpers, so
the status-rank comparator is defined inside it.)

**Structured data (JSON-LD).** Pages emit schema.org metadata through a named
`head` slot in `Base.astro`: each workshop page carries an `Event` (with its
conference as `superEvent`) plus a `BreadcrumbList`; each hub carries a `FAQPage`
plus a `BreadcrumbList`; the homepage carries a `Dataset` pointing at the
`/api/workshops.json` download. This targets machine extraction and Google
Dataset Search, not visual rich results — Google retired FAQ rich results in 2026
and `Event` rich results need a venue the dataset doesn't store, so the markup
earns its keep through AI extraction and Dataset eligibility. The visible HTML
stays the source of truth for what a reader (or model) actually sees.

**`llms.txt`.** `/llms.txt` (`site/src/pages/llms.txt.ts`, a static endpoint like
`rss.xml.ts`) is the [llms.txt](https://llmstxt.org/) summary: what the site is,
where the machine-readable JSON API and RSS feed live, the URL patterns for hubs
and workshop pages, and the conferences covered. Its conference list, full names,
ids, and counts are all derived from the data at build time, so it never drifts.

**"Browse by conference" footer.** `Base.astro` links to every hub from the
sitewide footer (iterating `conferences`), giving the hubs an internal link from
every page — the cheapest form of crawl discovery — and readers a quick switcher.

All of this is data-driven from `data/conferences.yml` plus the workshop data, so
a conference added per `skills/add-conference/` automatically gets its hub page,
footer link, breadcrumbs, and entries in the `Dataset` keywords and `llms.txt` on
the next build. Because statuses are derived at build time (above), the daily
rebuild keeps every derived value current.

## Known gap: the UI behavior suite (`ui_test.mjs`) is not in CI

`scripts/ui_test.mjs` is a headless-browser suite that locks the homepage's
runtime behavior — the dual-index search and its merge-immune counts, the
deterministic result order, the external-vs-internal link rule, and the
back/forward restore. **It is not run by any CI workflow.** It is a manual,
local check: build the site, serve `site/dist` with a raw concurrent static
server, then `node scripts/ui_test.mjs http://localhost:<port>`.

What this does and doesn't leave exposed: data/content changes can't reach the
code these tests guard and are already validated by `validate.yml`, so adding
workshops or papers is covered either way. The uncovered case is a **hand-edit
to the search / link / back-nav code that still compiles** — `deploy.yml` only
builds, so a behavior regression would build and ship with nothing flagging it.
Until the suite is wired in, that case relies on someone remembering to run it
(the tests pass today, so a green run is the baseline to protect).

If wiring it into CI later, two things need fixing first (both learned the hard
way here):

- The deploy-staleness test physically **moves** the Pagefind index/filter
  chunk files out of `dist` and only restores them at the very end, so a
  mid-test timeout leaves the working build corrupted (empty `pagefind/index`
  and `pagefind/filter`). Wrap the move/restore in `try/finally` so it always
  restores, regardless of how the test exits.
- The static server must serve Pagefind's chunks **raw and concurrently**.
  `astro preview` applies gzip `Content-Encoding` over the already-gzipped
  chunks, so the browser double-decodes and Pagefind throws "invalid gzip
  data"; single-threaded `python -m http.server` serves raw bytes but stalls
  under Pagefind's parallel chunk fetches (intermittent timeouts). A threaded
  HTTP/1.1 raw static server handles both.
