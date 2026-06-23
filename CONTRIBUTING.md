# Contributing

Thanks for helping keep workshop data accurate! There are three ways to contribute, from easiest to most hands-on. By contributing you agree to the short [contributor terms](CONTRIBUTOR_TERMS.md) (MIT for code, CC-BY-4.0 for data, no CLA, the data stays open).

## 1. The 2-minute form (no Git needed)

Open the **["Add a workshop" issue form](../../issues/new?template=add-workshop.yml)** and fill in what you know. A bot converts your answers into a data file, validates it, opens a pull request, and replies on the issue with the result. If validation fails, just edit the issue — the bot retries automatically.

## 2. Edit an entry (no Git needed)

Every workshop page and board row has a **✎ Edit** link that opens a short, timezone-safe form pre-filled with that entry. Change the deadline, website, or notes — and when you set a deadline you pick the timezone it's written in and the bot converts it to UTC for you, so there's no silent offset to get wrong. It opens a pull request and replies on the issue, just like the add form. Need a field the form doesn't cover (topics, organizers, dates, paper links)? The form links straight to the raw YAML for advanced edits.

## 3. Full pull request

```bash
cp data/workshops/_template.yml data/workshops/<conference>-<year>-<short-name>.yml
# fill it in, then:
npm ci && node scripts/validate.mjs
```

The filename **must** start with `<conference>-<year>-` (e.g. `neurips-2026-math-ai.yml`) and use only lowercase letters, digits, and hyphens.

## Field reference

One YAML file per workshop **edition** (same series ⇒ new file each year).

| Field | Required | Format / notes |
|---|---|---|
| `name` | ✅ | Full official name |
| `acronym` |  | Short name; `""` if none |
| `conference` | ✅ | An id from `data/conferences.yml` (`icml`, `iclr`, `neurips`) |
| `year` | ✅ | Integer |
| `website` | ✅ | Full `http(s)` URL |
| `topics` | ✅ | 1–5 ids from `data/topics.yml` |
| `submission_deadline` |  | `YYYY-MM-DD HH:MM` or `YYYY-MM-DD` (means 23:59) — **wall-clock time in `timezone`** |
| `timezone` | ⚠️ | **Required whenever `submission_deadline` is set** (CI rejects a deadline without one). `AoE` (Anywhere on Earth, UTC−12 — the ML default for date-only CFPs), `UTC`, or an IANA name like `America/Los_Angeles`. Via the issue form, pick any zone and the bot converts the deadline to UTC for you (keeping the original in `deadline_notes`). |
| `deadline_notes` |  | Free text, e.g. `"extended from Aug 15"`. Bot-imported deadlines keep an `OpenReview-synced …` provenance stamp here; editing this note (or the deadline) freezes auto-sync for that entry. |
| `tracks` |  | For multi-track workshops (e.g. Full + Short): list of `{ name, submission_deadline?, timezone? }`. Omit `submission_deadline` for a track whose date isn't announced yet. See note below. |
| `notification_date` |  | `YYYY-MM-DD` |
| `workshop_date` |  | `YYYY-MM-DD` |
| `openreview_venue_id` |  | e.g. `NeurIPS.cc/2026/Workshop/MATH-AI` — enables the automatic paper list |
| `proceedings_url` |  | Accepted-papers page for non-OpenReview workshops |
| `submission_portal` |  | `openreview` \| `cmt` \| `email` \| `other` \| `unknown` |
| `organizers` |  | List of names |
| `previous_editions` |  | List of `{ year, website, proceedings_url }` |
| `notes` |  | Free text |
| `added` |  | `YYYY-MM-DD` — feeds the "new workshops" RSS |

**Never add a `status` field** — upcoming/passed/past is computed from the dates at build time.
A workshop with no deadline and no `workshop_date` becomes **Past** automatically once its
conference edition ends — edition dates live in `data/editions.yml` (one row per
conference-year, `end` required; `node scripts/validate.mjs` notes any tracked year missing
a row). When a year has no row, the coarser `typical_month` from `data/conferences.yml` is used.

### Multi-track workshops (`tracks`)

Some workshops split submissions into tracks with **different** deadlines (e.g. a Full-paper
track and a Short-paper track). List them under `tracks`; give each a `name`, and a
`submission_deadline` (+ `timezone`) if it's known, or leave the deadline off for a track that
hasn't announced one yet. The site derives everything from the list: the headline deadline is
the **soonest track still open** (it rolls to the next track as each one closes), and the status
follows what's actionable — any open track shows **Open call**; if every announced track has
closed but one is still unannounced it shows **Deadline unknown** (not Past, since a track may
still open); only once all tracks have passed does it show **Past**. The workshop page lists each
track. Don't bother with `tracks` when every track shares one deadline — just use a single
`submission_deadline`.

### Adding a missing deadline

Every "Deadline TBA" workshop page has a link that opens the timezone-safe edit
form: type the date and time exactly as the CFP gives it, pick the matching
timezone (`AoE` is the right choice when the CFP just gives a date), and the bot
converts it to UTC and opens a PR — no YAML to touch and no timezone math to get
wrong. (Editing the YAML directly still works too, via the link in the form's
intro; an entry without a deadline carries a short comment template showing the
two lines to add. The weekly bot removes that comment the next time it touches
the file.)

## What CI checks

The `validate` workflow runs on every PR and enforces three things:

`node scripts/validate.mjs`:
- JSON Schema (`schema/workshop.schema.json`) — types, required fields, URL/date formats, no unknown fields
- `conference` and every `topics` id exist in their vocabulary files
- Filename matches `conference` + `year`
- Deadline parses, is within ±2 years of today, and precedes `workshop_date`
- No duplicate entries (same conference + year + near-identical name)

`node scripts/docs_sync_test.mjs` — every field in the schema is documented in
this file's Field reference table and in `_template.yml` (so new fields can't
ship undocumented).

`node scripts/tracks_test.mjs` — the multi-track deadline/status rules behave
correctly.

`node scripts/tz_normalize_test.mjs` — the importer converts every extracted
deadline (AoE or any offset) to UTC, so stored deadlines stay consistent.

`node scripts/issue_tz_test.mjs` — the issue-to-PR bot converts a contributor's
deadline to UTC (AoE or any civil timezone, DST-aware), keeping the original in
`deadline_notes`; a deadline already in UTC is left unchanged.

`node scripts/deadline_sync_test.mjs` — the discovery bot's deadline re-sync is
later-only by default, treats unchanged/null as no-ops, and (via the
`deadline_notes` value stamp) freezes any deadline a human has edited.

`node scripts/deadline_crosscheck_test.mjs` — the cross-check classifies a
stored-vs-OpenReview gap (tz-suspect vs. real change) and, by provenance, decides
what needs human review: a human-edited deadline that disagrees, or a bot-managed
one OpenReview moved earlier (later moves auto-sync; legacy entries are skipped).

`node scripts/issue_edit_to_yaml_test.mjs` — the "Edit a workshop" form transform
applies only the filled-in fields to an existing entry, converts a new deadline
from its timezone to UTC (verified by round-trip), requires a timezone when a
deadline is given, and leaves identity and unrelated fields untouched.

Validation failures are posted as a PR comment listing every problem at once.

## Paper lists

Don't paste papers by hand. Set `openreview_venue_id` and the monthly `openreview-refresh` workflow fetches the accepted papers into `cache/openreview/<slug>.json` (a maintainer can also run `node scripts/fetch_openreview.mjs --slug <slug>` immediately). For workshops elsewhere, set `proceedings_url`.

## For maintainers

- **Review queue:** PRs from contributors and from the two bots (`issue-to-pr`, `openreview-refresh`). CI has already validated data PRs — skim and merge.
- **Auto-synced deadlines:** the weekly `discover` job keeps OpenReview-imported deadlines in step with extensions (later-only by default) and records each change in its commit message — no PR. A deadline (or its `deadline_notes`) you edit by hand is **frozen**: the bot won't re-sync it. Notes beginning `OpenReview-synced …` are bot-stamped; changing the date or replacing the note hands that deadline to manual control. To also follow earlier corrections, flip `ALLOW_EARLIER` in `scripts/discover_openreview.mjs`.
- **Fixing a stale/extended deadline now:** rather than hand-editing the time (easy to get the timezone wrong), re-pull it from OpenReview — Actions → **Re-sync deadline from OpenReview** → enter the slug (or locally `node scripts/resync_deadline.mjs --slug <slug>`). It sets the deadline to OpenReview's current duedate, in either direction, and re-stamps it for future auto-sync.
- **Deadline review issue:** a weekly `deadline-review` workflow keeps one self-maintaining issue ("Data health: deadlines to review", `data-health` label) listing only deadlines the auto-sync won't fix itself — ones you hand-edited that now disagree with OpenReview, and bot-managed ones OpenReview moved *earlier* (the bot is later-only). Each item links the re-sync command; resolve by re-syncing (trust OpenReview) or leaving it (keep yours). The issue closes itself when nothing's outstanding. Bot-managed later moves and legacy entries never appear — they sync automatically.
- **Health issues:** two auto-maintained issues labelled `data-health` (stale entries, broken links). They update in place and close themselves when clean.
- **Seed data:** entries whose `notes` contain `SEED DATA` are unverified placeholders from the initial build — verify or replace them.
- Data is licensed CC-BY-4.0; by contributing you agree your additions are too.
