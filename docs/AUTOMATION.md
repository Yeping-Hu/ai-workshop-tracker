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
| `deploy.yml` | push to `main`, weekly, manual | Build & deploy (weekly run refreshes derived statuses) |
| `discover.yml` | weekly | Discovers new workshops/venues/deadlines from OpenReview and syncs extensions (later-only) → commits to `main` |
| `recheck-imminent.yml` | daily | Re-checks only deadlines within `[−7d, +14d]` for extensions (one lookup each, later-only) → commits to `main` |
| `openreview-refresh.yml` | monthly | Re-fetch paper caches for recent years → auto-PR on diff |
| `issue-to-pr.yml` | "Add a workshop" issue form | Converts the form to a YAML file + PR, validates, reports back |
| `edit-to-pr.yml` | "Edit a workshop" issue form | Applies the edit to the existing YAML + PR (timezone-safe), validates, reports back |
| `resync-deadline.yml` | manual | Re-pull one workshop's deadline from OpenReview's duedate (either direction) |
| `deadline-review.yml` | weekly | One consolidated issue listing deadlines that need a human decision |
| `stale-check.yml` | weekly | One consolidated issue listing entries needing follow-up |
| `link-check.yml` | monthly | One consolidated issue listing broken URLs |

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
