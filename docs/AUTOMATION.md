# Automation

Scheduled GitHub Actions do the routine data work unattended, so the maintainer's
job is the part that needs judgement: reviewing PRs and working through the
auto-updated "Data health" issues (~1–2 h/week in deadline season, less
otherwise).

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
| `openreview-refresh.yml` | monthly | Re-fetch paper caches for recent years (`scripts/fetch_openreview.mjs --recent`) → commits to `main` |
| `issue-to-pr.yml` | "Add a workshop" issue form | Converts the form to a YAML file + PR, validates, reports back |
| `edit-to-pr.yml` | "Edit a workshop" issue form | Applies the edit to the existing YAML + PR (timezone-safe), validates, reports back |
| `resync-deadline.yml` | manual | Re-pull one workshop's deadline from OpenReview's duedate (either direction) |
| `deadline-review.yml` | daily | One consolidated issue listing deadlines that need a human decision — including ones OpenReview reopened after they had closed, where the site says shut and OpenReview says open — daily because it is the only job that ever looks at a **human-edited** deadline, which freeze-on-touch excludes from every automatic sync. Comments when a workshop first appears, since editing an issue body notifies nobody. Also reports a `website` that changed on OpenReview (reported, never applied), and names any entry OpenReview could not answer for rather than counting it. |
| `official-list-check.yml` | weekly | Reconciles the corpus against each conference-edition's **official accepted-workshop list** (`data/editions.yml` → `workshop_list_url`), and proposes one from the conference's `announcement_feed` where none is configured. One consolidated issue: entries we track that are not on the list (ranked so a still-open call comes first), listed workshops we do not track, and title/website drift. Reports only — see below. |
| `official-list-decision.yml` | manual | Records one decision the official-list report asked for — `not_running` / `review_ack.official_list` via `scripts/mark_not_running.mjs`, or adopting/declining a drifted name or website via `scripts/apply_official_list.mjs` → commits to `main` |
| `stale-check.yml` | weekly | One consolidated issue listing entries needing follow-up |
| `link-check.yml` | monthly | One consolidated issue listing broken URLs Before running, `scripts/lychee_exclusions.mjs` appends every `review_ack.website` to `.lycheeignore`, so a URL deliberately removed as dead is not re-reported each month. |
| `alerts.yml` | daily, manual | `scripts/alerts_run.mjs` — diffs `/api/workshops.json` against yesterday's snapshot, records events, sends urgent starred-deadline alerts, and on Mondays the weekly digests, committing that week's `data/changes.json` for the `/changes/` page. |
| `alerts-worker-deploy.yml` | push touching `alerts/**`, `lib/identity.mjs` or `lib/events.mjs`; manual | `wrangler deploy` of the alerts Worker, after checking `alerts/ids.json` is in sync with the data vocabulary. The two `lib/` files are inside the Worker bundle |
| `alerts-ci.yml` | PRs & pushes touching `alerts/**`, `scripts/alerts_*`, the `lib/` files the Worker bundles, the two site sync scripts, or the conference/topic vocabularies | The eleven pure-logic alerts suites (tokens, diff, matching, rendering, sending, rate limits, mail, star-merge, session, dashboard, log hygiene) plus the ids sync check |

## An OpenReview venue is not proof a workshop was accepted

Every workshop record comes from an OpenReview venue group. OpenReview creates
those during a conference's **proposal** phase, so a **rejected** proposal keeps a
live group with an open `/-/Submission` invitation and a duedate that ticks down
exactly like an accepted workshop's. Discovery cannot tell them apart, and until
`official-list-check.yml` there was no second opinion anywhere in the pipeline:
NeurIPS 2026 accepted 102 workshops, OpenReview exposed 119 venue groups, and the
site advertised an Open call for a workshop whose own website had 404'd.

Three things follow, and they are the whole design:

- **Discovery is unchanged and stays the only thing that creates a record.** The
  reconciliation is additive. A conference-year with no configured list — and no
  announcement feed to propose one — is simply not reconciled, exactly as before.
- **The check reports; it never applies.** An official list is authoritative for
  *presence*, not for *absence*. A workshop can be running and merely not be a
  "workshop" in that list's sense: affinity events (WiML, QueerInAI, LXAI…),
  competitions, and co-located workshops in their own OpenReview namespace are
  all legitimately off-list. UniReps 2026 is exactly that shape — a live site, a
  4th edition, absent from the 102. So off-list means *a human should look*, and
  the two verdicts are recorded by dispatching `official-list-decision.yml`:
  `not_running` for an edition that is not happening, `review_ack.official_list`
  for one that is and should stop being reported.
- **A name or website that disagrees with the list is classified, not just
  reported.** Three real NeurIPS 2026 cases were three different situations, so
  "always adopt the list" is wrong: our stub name loses to the official title
  (AgenticOS), our venue-noisy name loses to it (BabyVLM), and our real name
  BEATS `AI4Mat-NeurIPS-2026`, which is acronym+venue+year — the very shape
  `stripVenueFromName` strips everywhere else. `classifyNameDrift` decides from
  the two token sets alone (`nameTokens` already discards venue words and the
  year); `classifyWebsiteDrift` adopts only when our stored URL is the
  conference's own site, i.e. a placeholder. Anything else stays a person's call.
  Note the fix for a venue-noisy stored name is to take the official title, NOT
  to widen the stripper: roughly one stored name in seven carries a conference
  name or year and nearly all do so legitimately ("4th CoRL Workshop on…",
  "co-located with NeurIPS 2025"), so a stripper aggressive enough to catch the
  handful of bad ones would mangle correct ones.
- **A marked entry is never deleted.** Its OpenReview group is still live, so the
  next weekly crawl would re-create a deleted file — the same lesson
  `merged_venue_ids` records for duplicates. Keeping the file is what makes the
  decision stick, and it keeps the page alive for anyone who already starred or
  linked it. Eight scripts skip a marked entry — six through the exported
  `isNotRunning()` predicate, plus `stale_check.mjs` (which reads the derived
  status) and `lychee_exclusions.mjs` (a deliberately dependency-free line scan,
  so a tombstoned workshop's dead homepage is not reported broken every month).
  Two of those filters (`deadline_crosscheck.mjs`, `stale_check.mjs`) are
  load-bearing rather than tidiness, since without them marking an entry would
  move it off the board and into a daily issue forever.

**"Could not be read" is a failure of the check, never a verdict on the corpus.**
Both announcement blogs sit on one shared host, and it has twice answered a
GitHub runner with a short 200 carrying no list while serving the real page to
everyone else — once recovering on its own two and a half minutes later, with
nothing changed at either end. The check filed "the URL is probably wrong"
against two URLs that were correct, and because the job is weekly it stood for
days. Zero items has two causes needing opposite fixes, so the report now says
which one it is: `describeResponse` classifies what actually arrived as a
`refusal` (a wall — wait and re-run), a `stub` (too little text to be the page),
or a `page` (real, so the bug is the extractor), and quotes its title and first
words. A configured list is re-read across `EMPTY_RETRY_BACKOFF_MS` — minutes,
not the five seconds that could not outlast the refusal actually observed —
while a candidate probe gets one attempt, since a missed proposal files nothing.
Every page a run fetches is cached, because walking each conference's feed once
per unconfigured edition-year spent 22 requests on that one host in nine
seconds, nine of them exact repeats; it is 14 now, and the burst was itself a
reason to be rationed.

**Adopting from one source declines the other.** Taking the official list's title
or URL implicitly rejects OpenReview's, and the daily cross-check cannot know
that — it would open a fresh "renamed on OpenReview" row the next morning for a
decision just made deliberately, in a *different* issue. `--adopt` therefore also
records the displaced upstream value as `review_ack[field]`, which is exactly that
field's job. The decision is `declinedUpstreamValue()` in
`deadline_crosscheck.mjs`, expressed in terms of the very `titleDrift` /
`websiteDrift` rules that would fire, because a second implementation of "does
this count as drift" would eventually disagree with the report it exists to quiet.
`--adopt` is idempotent for the same reason: re-running it on an entry already
adopted reconciles the OpenReview side rather than exiting as a no-op.

**Some lists link an OpenReview group rather than a homepage.** Four of ICLR
2024's twenty do. That is not a website — `websiteKey()` drops the query string,
so every such link normalises to the single key `openreview.net/group`: they
matched each other, the header's count disagreed with the list it printed, and
each produced a row advising that our website should be `openreview.net`. The id
is now parsed out and used as a **match tier ahead of the URL tier** (a venue id
is the corpus's own primary key), matched listings are tracked by index rather
than by a normalised key so two can never collide, and such a link can never be
evidence that a stored `website` is wrong.

**Finding the list is automatic; adopting it is not.** `conferences.yml` carries
an optional `announcement_feed` (NeurIPS and ICLR publish one), and the weekly job
walks it — following `?paged=N`, since a ten-item window is too tight for a weekly
cadence — for a post whose title names workshops and the year, excluding
competitions, tutorials, newsletters and calls for proposals. Each candidate is
parsed and checked against the corpus, and proposed only if it clears both guards:
at least `MIN_LISTED` items **and** at least half of them matching workshops we
already track. Adopting it is still one human dispatch, because a page that reads
as empty or wrong would report the entire corpus as rejected — by far the worst
thing this check could produce. That is also why no `{year}` URL template is used
as a fallback: the templated schedule pages are JS-rendered and yield zero
anchors, which is indistinguishable from "everything was rejected".

## The alerts job is outside the data-write group

`alerts.yml` commits exactly one file — `data/changes.json`, on the weekly pass —
and still deliberately does **not** join the `data-write` concurrency group
described below: queueing it behind a slow discovery run would only delay mail,
and the shared publish action's rebase-retry absorbs a collision with a data job.
It has its own `alerts` group so two runs can't overlap.

What it *does* need is ordering against `deploy.yml`: the diff must read the
`workshops.json` that today's rebuild produced, or it compares yesterday's feed
against yesterday's snapshot and reports nothing. `deploy.yml`'s daily cron is
05:17 UTC and the alerts cron is 06:30 UTC — 73 minutes later. **Moving either
cron means moving both.** The offset only orders the schedules, not the runs —
GitHub's cron drifts by hours on a busy day — so the job also compares the
feed's build stamp with the snapshot's and waits up to thirty minutes for a
rebuild before it decides the day was quiet (ALERTS.md, "Daily operation").
Everything else about the job is stateless: it holds no credentials beyond a
bearer token, and all state lives in the Worker's database. See
[ALERTS.md](ALERTS.md).

## Every deadline write is logged

All nine places that write a `submission_deadline` — the three in the weekly
importer, the daily re-check, the daily blank-fill, the daily multi-track sync, the
manual re-sync, and both issue forms (add and edit) — record to that entry's
`deadline_history`. Seven of them call `recordDeadlineObservation()`; the two that
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

The commit-push-dispatch sequence itself is one composite action,
`.github/actions/publish-data`, that every committing workflow calls with its
paths, subject and change log — eight copies of the same shell block used to sit
in eight files. It also carries the `gh workflow run deploy.yml` that follows a
successful push: a push made with `GITHUB_TOKEN` does not trigger `on: push`, so
without it new data would sit on `main` unbuilt until the next daily deploy.

Every job carries a `timeout-minutes` well under GitHub's six-hour default —
150 for discovery, 45 for the other network jobs — so a hung OpenReview socket
cannot hold the `data-write` lock for the rest of the day. The bounds are
generous on purpose: a killed run loses its computed work, which is worse than a
slow one.


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

### Maintainer sweeps (idempotent, run by hand)

Each of these re-applies a rule the importer already enforces on arrival to the
entries that predate it. All are no-ops on a clean tree and safe to re-run; each
takes `--dry-run` (or prints a preview by default) and writes only what changed.

| Script | Re-applies | When to run |
|---|---|---|
| `scripts/strip_venue_names.mjs` (`--write` to apply) | the venue-stripping of `name` | if `acronym_identity_test.mjs` reports a name repeating its own conference-year — and ask first how the entry got past the importer, because that is the actual defect |
| `scripts/normalize_stored_identity.mjs` | the full identity normalisation (`name` + `acronym`) | when `identity_fixed_point_test.mjs` fails; its message names this script |
| `scripts/backfill_websites.mjs` | filling a **blank** `website` from the venue's OpenReview field, through the same reader and `review_ack` guard as import | after the website reader's rules widen (e.g. accepting a scheme-less host), so entries skipped under the old rules are filled |
| `scripts/retag_topics.mjs` | the title→topics keyword guess, only on entries still tagged `other` with the auto-suggested note | after improving the keyword table in `discover_openreview.mjs` |
| `scripts/digest_fixture.mjs [render.mjs] [name]` | renders one fixed digest through a given `alerts/render.mjs` | to diff an email template change against `main` with the code as the only variable (its header shows the worktree recipe) |

### Flags the workflows do not use

- `scripts/resync_deadline.mjs --slug <slug> [--dry-run] [--force] [--unmark]` — `--force` is required to touch an entry marked `not_running`; `--unmark` clears that marking as part of the re-sync.
- `scripts/discover_openreview.mjs --conf <id> --year <y> [--dry-run]`.
- `scripts/sync_tracks.mjs [--slug <slug>] [--dry-run]` and `scripts/backfill_deadlines.mjs [--dry-run]`, `scripts/recheck_imminent.mjs [--dry-run]`.
- `scripts/fetch_openreview.mjs [--slug <slug> | --recent | --all] [--abstracts]` — the workflow passes `--recent`.
- `scripts/official_list_check.mjs [--conf <id>] [--year <y>] [--slug <slug>] [--report <path>|-]`, plus `--field name|website --adopt|--decline` on one slug, which `official-list-decision.yml` wraps.
- `scripts/alerts_stats.mjs [--days N] [--json]`.

### The one remaining manual step

Dependabot's monthly PRs (root, `site/`, and the actions) are merged by hand
after CI passes — every one so far has been. Repo Settings → General → *Allow
auto-merge* plus a branch rule requiring `Validate data` and `Build check` would
let a small workflow enable auto-merge on them; until that setting is flipped,
this is the only routine job that waits for a person.


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

Run it when a conference announces its accepted workshop list (NeurIPS announces ~July, ICLR ~January, ICML ~March). The repo ships with all of 2024-2026 imported (900+ editions across nine conferences). To populate accepted-paper caches for them, run `node scripts/fetch_openreview.mjs` (fetches everything missing; the monthly workflow keeps recent years fresh).
