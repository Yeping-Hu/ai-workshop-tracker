# Contributing

Thanks for helping keep workshop data accurate! There are three ways to contribute, from easiest to most hands-on. By contributing you agree to the short [contributor terms](CONTRIBUTOR_TERMS.md) (MIT for code, CC-BY-4.0 for data, no CLA, the data stays open).

## 1. The 2-minute form (no Git needed)

Open the **["Add a workshop" issue form](../../issues/new?template=add-workshop.yml)** and fill in what you know. A bot converts your answers into a data file, validates it, opens a pull request, and replies on the issue with the result. If validation fails, just edit the issue — the bot retries automatically.

## 2. Edit on GitHub

Every workshop page and board row on the site has a **✎ Edit** link straight to its YAML file. Fix the field, propose the change, done — CI validates it and a maintainer merges.

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
| `deadline_notes` |  | e.g. `"extended from Aug 15"` |
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

Entries without a `submission_deadline` start with a comment template showing
exactly which two lines to add — `submission_deadline` **and** `timezone`
(always include it; CI rejects a deadline without one, and `AoE` is the right
choice when the CFP just gives a date). Every "Deadline TBA" workshop page
links straight to that file in the GitHub editor. Add the lines, propose the
change, done. You can delete the comment block or leave it: the weekly bot
removes it automatically the next time it touches the file.

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

Validation failures are posted as a PR comment listing every problem at once.

## Paper lists

Don't paste papers by hand. Set `openreview_venue_id` and the monthly `openreview-refresh` workflow fetches the accepted papers into `cache/openreview/<slug>.json` (a maintainer can also run `node scripts/fetch_openreview.mjs --slug <slug>` immediately). For workshops elsewhere, set `proceedings_url`.

## For maintainers

- **Review queue:** PRs from contributors and from the two bots (`issue-to-pr`, `openreview-refresh`). CI has already validated data PRs — skim and merge.
- **Health issues:** two auto-maintained issues labelled `data-health` (stale entries, broken links). They update in place and close themselves when clean.
- **Seed data:** entries whose `notes` contain `SEED DATA` are unverified placeholders from the initial build — verify or replace them.
- Data is licensed CC-BY-4.0; by contributing you agree your additions are too.
