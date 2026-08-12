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
| `pr-build-check.yml` | PRs | Builds the site as a visible (non-required) check, so a PR that breaks the build is obvious before merge |
| `deploy.yml` | push to `main`, daily, manual | Build & deploy (daily run refreshes derived statuses) |
| `discover.yml` | weekly | Discovers new workshops/venues/deadlines from OpenReview, backfills a `website`/deadline/tracks that organizers published after the venue was imported, and syncs extensions (later-only) → commits to `main` |
| `recheck-imminent.yml` | daily | Re-checks only deadlines within `[−7d, +14d]` for extensions (one lookup each, later-only) → commits to `main` |
| `backfill-deadlines.yml` | daily | `scripts/backfill_deadlines.mjs` — fills a **blank** `submission_deadline` for OpenReview-linked, single-deadline entries (fill-only, never overwrites) → commits to `main` |
| `sync-tracks.yml` | daily | `scripts/sync_tracks.mjs` — refreshes the per-track deadlines of **multi-track** venues from their sub-track child groups (fill blanks, later-only per track), re-deriving the headline → commits to `main` |
| `openreview-refresh.yml` | monthly | Re-fetch paper caches for recent years → auto-PR on diff |
| `issue-to-pr.yml` | "Add a workshop" issue form | Converts the form to a YAML file + PR, validates, reports back |
| `edit-to-pr.yml` | "Edit a workshop" issue form | Applies the edit to the existing YAML + PR (timezone-safe), validates, reports back |
| `resync-deadline.yml` | manual | Re-pull one workshop's deadline from OpenReview's duedate (either direction) |
| `deadline-review.yml` | weekly | One consolidated issue listing deadlines that need a human decision Also reports a `website` that changed on OpenReview (reported, never applied). |
| `stale-check.yml` | weekly | One consolidated issue listing entries needing follow-up |
| `link-check.yml` | monthly | One consolidated issue listing broken URLs |

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

Contributors adding a workshop by hand should leave `deadline_history` out
entirely — `_template.yml` says so, and the automation fills it in.


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
