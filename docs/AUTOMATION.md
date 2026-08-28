# Automation

Scheduled GitHub Actions keep the data fresh with near-zero maintenance. The
maintainer's whole job is to review PRs and skim a few auto-updated "Data health"
issues (~1–2 h/week in deadline season, ~0 otherwise).

**Publishing is zero-touch for OpenReview data.** The weekly discovery job, the
daily imminent-deadline re-check, and the monthly paper refresh validate their
changes and, on success, commit straight to `main` and trigger a deploy — newly
announced workshops appear on the site with no human action. If validation fails,
nothing is committed and GitHub emails the repo owner (that email is the alert
channel). Community submissions via the issue form still arrive as pull requests
for human review, as do dependency updates.

| Workflow | Trigger | What it does |
|---|---|---|
| `validate.yml` | PRs & pushes touching data | Schema + sanity checks; comments fixes on the PR |
| `pr-build-check.yml` | PRs & pushes to `main` | Builds the site, then runs the three browser suites — `ui_test.mjs` on the fork build, `alerts_ui_test.mjs` and `shipped_ui_test.mjs` on the alerts-configured one. The only job that asserts anything about the page it ships; it runs on pushes because work lands here without a PR |
| `smoke.yml` | after each deploy, daily, manual | Runs `scripts/smoke_test.mjs` against the **live** site — the only check that sees what a reader gets rather than a locally built artefact. Opens or updates a `smoke`-labelled issue on failure |
| `deploy.yml` | push to `main`, daily, manual | Build & deploy (daily run refreshes derived statuses) |
| `discover.yml` | weekly | Discovers new workshops/venues/deadlines from OpenReview, backfills a `website`/deadline/tracks that organizers published after the venue was imported, and syncs extensions (later-only) → commits to `main` |
| `recheck-imminent.yml` | daily | Re-checks only deadlines within `[−7d, +14d]` for extensions (one lookup each, later-only) → commits to `main` |
| `backfill-deadlines.yml` | daily | `scripts/backfill_deadlines.mjs` — fills a **blank** `submission_deadline` for OpenReview-linked, single-deadline entries (fill-only, never overwrites) → commits to `main` |
| `sync-tracks.yml` | daily | `scripts/sync_tracks.mjs` — refreshes the per-track deadlines of **multi-track** venues from their sub-track child groups (fill blanks, later-only per track), re-deriving the headline → commits to `main` |
| `openreview-refresh.yml` | monthly | Re-fetch paper caches for recent years → auto-PR on diff |
| `issue-to-pr.yml` | "Add a workshop" issue form | Converts the form to a YAML file + PR, validates, reports back |
| `edit-to-pr.yml` | "Edit a workshop" issue form | Applies the edit to the existing YAML + PR (timezone-safe), validates, reports back |
| `resync-deadline.yml` | manual | Re-pull one workshop's deadline from OpenReview's duedate (either direction) |
| `deadline-review.yml` | daily | One consolidated issue listing deadlines that need a human decision — daily because it is the only job that ever looks at a **human-edited** deadline, which freeze-on-touch excludes from every automatic sync. Comments when a workshop first appears, since editing an issue body notifies nobody. Also reports a `website` that changed on OpenReview (reported, never applied), and names any entry OpenReview could not answer for rather than counting it. |
| `stale-check.yml` | weekly | One consolidated issue listing entries needing follow-up |
| `link-check.yml` | monthly | One consolidated issue listing broken URLs Before running, `scripts/lychee_exclusions.mjs` appends every `review_ack.website` to `.lycheeignore`, so a URL deliberately removed as dead is not re-reported each month. |
| `alerts.yml` | daily, manual | `scripts/alerts_run.mjs` — diffs `/api/workshops.json` against yesterday's snapshot, records events, sends urgent starred-deadline alerts, and on Mondays the weekly digests. Commits nothing. |
| `alerts-worker-deploy.yml` | push touching `alerts/**` | `wrangler deploy` of the alerts Worker, after checking `alerts/ids.json` is in sync with the data vocabulary |
| `alerts-ci.yml` | PRs & pushes touching `alerts/**` or `scripts/alerts_*` | The four pure-logic alerts suites (tokens, diff, matching, rendering) plus the ids sync check |

## The alerts job is outside the data-write group

`alerts.yml` never commits to the repo, so it deliberately does **not** join the
`data-write` concurrency group described below — queueing it behind the data jobs
would only delay mail. It has its own `alerts` group so two runs can't overlap.

What it *does* need is ordering against `deploy.yml`: the diff must read the
`workshops.json` that today's rebuild produced, or it compares yesterday's feed
against yesterday's snapshot and reports nothing. `deploy.yml`'s daily cron is
05:17 UTC and the alerts cron is 06:30 UTC — 73 minutes later. **Moving either
cron means moving both.** Everything else about the job is stateless: it holds
no credentials beyond a bearer token, and all state lives in the Worker's
database. See [ALERTS.md](ALERTS.md).

## Every deadline write is logged

All nine places that write a `submission_deadline` — the three in the weekly
importer, the daily re-check, the daily blank-fill, the daily multi-track sync, the
manual re-sync, and both issue forms (add and edit) — record to that entry's
`deadline_history`. Eight of them call `recordDeadlineObservation()`; the two that
*create* an entry (the importer's new-venue path and the add form) set the first
log entry directly, because the helper seeds from the value being replaced and so
correctly reports "no change" when nothing is being replaced. The log is what powers the "Extended by N days"
note on the board and the history on each workshop page. Two consequences worth
knowing:

- **`recorded` is when *we* observed a value**, never when the organizers changed
  it — we cannot know the latter, and the UI says so explicitly.
- **The hook goes immediately before the write**, so the outgoing value is still
  readable and can be seeded with the date from its own `(as of …)` stamp.

A job that only writes on change (the re-check) therefore logs only real moves; a
no-op re-observation is discarded, so the log doesn't grow on unchanged entries.


## A partial crawl fails loudly

The discovery crawl runs each conference-year separately so one bad cycle — a
throttled conference, a renamed venue — doesn't cost the other seventeen. It used
to do that with `|| true`, which also swallowed real crashes: a missing import
introduced on 2026-08-04 went unnoticed until 08-11, when the run finished **15 of
18** cycles and still reported success. Failures are now collected, warned about
per cycle, retried once, and the job fails at the end only if a cycle failed
*twice* — and always *after* validating and publishing whatever the crawl did
find, so a partial result still ships rather than being thrown away.

The retry is cycle-level, and complements the venue-level one next to it rather
than duplicating it. The unverified list a venue lands on is written at the END of
a cycle, so a cycle that *throws* — usually OpenReview answering 429 to the venue
listing — never appears in it and was never retried. That is what turned
2026-08-23 red for `icra-2026`, which then succeeded immediately on a manual
re-run. The cycle retry runs after the whole crawl and the venue re-check, by
which point the rate budget has recovered.

The class of bug that hid there is also checked directly now:
`scripts/imports_test.mjs` (run in `validate.yml`) fails if a module calls one of
our own exported helpers without importing it. That mistake only throws when the
calling branch runs, which for discovery meant "the first time a workshop's
deadline appears on OpenReview" — rare enough to stay green for a week.


## The data jobs are serialised

Every workflow that commits to `main` shares
`concurrency: { group: data-write, cancel-in-progress: false }`, so they queue
rather than overlap. They each check out `main`, compute, commit and push; if a
sibling pushes in between, the push is rejected as a non-fast-forward and the job
fails with its work computed but unpublished — which is exactly what happened when
the re-check and the blank-fill were dispatched together. Queuing rather than
cancelling matters: a cancelled run would silently skip a data write.

Every push is also wrapped in a bounded rebase-retry (3 attempts, fetch and rebase
between, backing off 5s then 10s), because the group can't prevent a move from
outside it — a merge, an admin push, or a re-run. The crons are 30 minutes apart,
but discovery can take ~35 minutes on a slow OpenReview day and a manual dispatch
ignores the schedule entirely.


## OpenReview's rate limit

Every OpenReview response carries its own limit, and the crawler is expected to
respect it rather than discover it by being refused:

```
ratelimit-policy: 20;w=60        20 requests per 60 seconds
x-ratelimit-remaining: 19
ratelimit-reset: 60
```

`lib/openreview.mjs` is the single gate every OpenReview request passes through.
It reads those headers, spends the advertised budget, and pauses only at the
window boundary — so a healthy crawl runs at full permitted speed and is never
slowed for the sake of caution. `scripts/openreview_rate_test.mjs` pins both
halves: it waits when the budget is gone, and it does **not** wait when there is
room, because a limiter that throttles a healthy connection is its own bug.

**This was learned the hard way, twice.** The first symptom was ECCV's WICV and
around twenty siblings importing as "Deadline unknown" despite having a visible
duedate; the fix then was retries with backoff, which treated the symptom. The
second was 15 throttled venues in one run on 2026-08-18. The cause both times
was the same: one path paced at 350ms and the other not at all, roughly 340
requests a minute against a ceiling of 20. The retries then spent themselves
inside a window that was already exhausted.

It matters beyond discovery. `deadlineFromInvitation` is also called by
`backfill_deadlines.mjs`, `deadline_crosscheck.mjs`, `recheck_imminent.mjs` and
`resync_deadline.mjs`, three of them on daily crons and all sharing one per-IP
budget.

### When a venue still cannot be checked

A failed lookup is **recorded, never treated as absent** — `null` for a deadline
and `[]` for sub-tracks are otherwise indistinguishable from "there is nothing
here", which is precisely how a throttled venue used to be filed as fully
checked. Instead:

1. The venue is appended to `$OPENREVIEW_UNVERIFIED` (a file, because the
   workflow runs each conference-year as its own `node` process — the same
   idiom as `$DEADLINE_CHANGELOG`).
2. The cycle summary says so: `116 venues — … , 2 UNVERIFIED`.
3. After all 18 cycles, discovery re-runs for just the affected
   conference-years, by which point the budget has recovered. Re-running
   discovery *is* the retry because it is idempotent and honours the later-only
   rule and the human-edit freeze — `resync_deadline.mjs` must not be used here,
   as it deliberately bypasses both.
4. Whatever fails twice opens **"Data health: venues not verified"**
   (label `data-health`), edited in place and **closed automatically** once a
   later run verifies everything. It needs no action unless it persists for
   several weeks, which would point at something other than rate limiting.

## What a new entry inherits automatically

Nothing in this cycle's work needs hand-maintaining per workshop or per
conference:

- **A new conference** in `data/conferences.yml` immediately gets its own
  `/conference/<id>/` page, a link in the homepage hero strip, and a link in the
  footer — all three iterate the conference list, so there is no second place to
  update.
- **A new workshop** gets `deadline_history` from the moment it is created,
  whichever route it arrives by: the importer seeds it for a discovered venue, and
  the add form seeds it for a contributed one (so the board's "Deadline just
  announced" note appears either way). Editing a deadline through the edit form
  logs the move too, so a human change is as traceable as a bot one.
- **A two-stage venue** gets `abstract_deadline` filled at import and kept current
  by the daily re-check; the countdown labelling and ordering follow from the field
  with no per-entry configuration.
- **A new edition or a new track** joins its series with nothing to wire up. The
  links between a workshop's tracks and its other years are recomputed from the
  whole corpus on every build (ARCHITECTURE.md, "Related entries"), so next year's
  entry links itself to the previous ones *and* they link back to it — no stored
  relation to go stale, and no hand-editing on either side. Three things can do
  the linking, all derived from what the importer already stores: the same
  website, the same site with names that agree, or the same short name
  registered on OpenReview. A series that moves to a new year-named site, or
  renames itself past recognition while keeping its venue id, still links.

- **A venue-prefixed name or acronym is normalised on arrival**, by every route.
  OpenReview venue titles routinely lead with the conference and year ("COLM 2026
  Workshop on Efficient Reasoning"), its `subtitle` field is frequently just the
  venue ("NeurIPS 2025"), and contributors paste the workshop's own CFP heading,
  which has the same shapes. `stripVenueFromName()` and `cleanAcronym()` in
  `lib/workshops.mjs` are applied by `discover_openreview.mjs` *and* by
  `issue_to_yaml.mjs`, so neither the entry nor the slug derived from it carries
  the venue twice. Doing this at entry rather than in CI is deliberate: the slug
  becomes a filename and a public URL, and unlike a name it cannot be corrected
  later without breaking links.
- **Sibling tracks name themselves apart.** Two tracks of one workshop share an
  acronym upstream, which would give them the same page title and merge them into
  one group on `/saved/`. The distinguishing label is derived from the venue id
  (`venueFamily().suffixLabel`), never typed into YAML — see ARCHITECTURE.md,
  "A workshop's one-line identity".
- **A merged-away duplicate stays merged.** When one workshop arrives under two
  OpenReview groups, the surviving entry lists the abandoned id in
  `merged_venue_ids` and discovery skips it. Without that, deleting the duplicate
  file would simply let the next weekly crawl re-create it.

Contributors adding a workshop by hand should leave `deadline_history` out
entirely — `_template.yml` says so, and the automation fills it in.

### Re-running the one-time name sweep

`scripts/strip_venue_names.mjs` swept the entries that predated the import-time
normalisation. It is a no-op on a clean tree and should stay one: preview with
`node scripts/strip_venue_names.mjs`, apply with `--write`. If
`acronym_identity_test.mjs` ever reports that a name repeats its own
conference-year, that is the script to run — but ask first how the entry got past
the importer, because that is the actual defect.


## Adding a conference

Adding a conference takes ~10 minutes end to end: `skills/add-conference/`
documents the full procedure (feasibility probe → `node scripts/add_conference.mjs`
to wire all touchpoints → import → verify → ship), with a bundled OpenReview
probe script. The same folder zips into a Claude skill for use in fresh sessions.

## Bulk-importing real workshop lists

`scripts/discover_openreview.mjs` enumerates every workshop venue for a conference-year straight from OpenReview and creates an entry per venue — official title, acronym, website, and the **real submission deadline**, taken from the venue's date line or, when that is blank, from the submission invitation's machine-readable `duedate` (expired invitations included; nothing is estimated). Venues with no published deadline anywhere get an in-file comment template, and their pages show a "know the deadline? Help add it" link to the timezone-safe edit form (that in-file template remains as a raw-YAML fallback):

```bash
node scripts/discover_openreview.mjs --conf neurips --year 2026
```

Run it when a conference announces its accepted workshop list (NeurIPS announces ~July, ICLR ~January, ICML ~March). The repo ships with all of 2024-2026 imported (~330 editions). To populate accepted-paper caches for them, run `node scripts/fetch_openreview.mjs` (fetches everything missing; the monthly workflow keeps recent years fresh).
