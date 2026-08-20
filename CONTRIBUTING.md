# Contributing

Thanks for helping keep workshop data accurate! There are three ways to contribute, from easiest to most hands-on. By contributing you agree to the short [contributor terms](CONTRIBUTOR_TERMS.md) (MIT for code, CC-BY-4.0 for data, no CLA, the data stays open).

## 1. The 2-minute form (no Git needed)

Open the **["Add a workshop" issue form](../../issues/new?template=add-workshop.yml)** and fill in what you know. A bot converts your answers into a data file, validates it, opens a pull request, and replies on the issue with the result. If validation fails, just edit the issue — the bot retries automatically.

## 2. Edit an entry (no Git needed)

Every workshop page has a **✎ Edit** link that opens a short, timezone-safe form pre-filled with that entry. Change the deadline, website, topics, or notes — you pick the deadline date and time from dropdowns (no format to get wrong) and choose the timezone it's written in, and the bot converts it to UTC for you, so there's no silent offset. Topics are a checkbox list of the controlled vocabulary — tick as many as apply without the list closing between picks; because a GitHub form can't show an entry's current topics, ticking any **replaces** the whole list, so pick the full set you want (old plus new). It opens a pull request and replies on the issue, just like the add form. Need a field the form doesn't cover (organizers, dates, paper links)? The form links straight to the raw YAML for advanced edits.

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
| `name` | ✅ | Full official name, **without the conference or year** — "Workshop on Machine Learning for Health", not "NeurIPS 2026 Workshop on Machine Learning for Health". Every page that shows a name already says which conference-year it belongs to. Submitted either way: a leading `<CONF> <YEAR>` and a trailing `@ <CONF> <YEAR>` are removed automatically |
| `acronym` |  | Short name; `""` if none. Leave the conference and year out (`MATH-AI`, not `MATH-AI @ NeurIPS 2026`) — an "acronym" that is only the venue is dropped. Don't hand-write a track suffix either: sibling tracks are labelled automatically from `openreview_venue_id`, so a `…/CVEU_Extended_Abstract_Track` venue already renders as "CVEU (Extended Abstract Track)" and a parenthetical typed here would be shown twice |
| `conference` | ✅ | An id from `data/conferences.yml` (`icml`, `iclr`, `neurips`) |
| `year` | ✅ | Integer |
| `website` | ✅ | Full `http(s)` URL |
| `location` | — | Where it takes place, e.g. `Sydney, Australia`. Maintained by the weekly OpenReview sync; spellings are tidied for display, so leave it as published |
| `topics` | ✅ | 1–5 ids from `data/topics.yml` (the add/edit issue forms offer these as a multi-select picker, so there are no typos or unknown ids) |
| `submission_deadline` |  | `YYYY-MM-DD HH:MM` or `YYYY-MM-DD` (means 23:59) — **wall-clock time in `timezone`**. The add/edit issue forms collect this via year/month/day/hour/minute dropdowns. |
| `timezone` | ⚠️ | **Required whenever `submission_deadline` is set** (CI rejects a deadline without one). `AoE` (Anywhere on Earth, UTC−12 — the ML default for date-only CFPs), `UTC`, or an IANA name like `America/Los_Angeles`. Via the issue form, pick any zone and the bot converts the deadline to UTC for you (keeping the original in `deadline_notes`). |
| `abstract_deadline` |  | Two-stage venues only (a **mandatory abstract registration** before the paper deadline). Always **UTC** wall-clock, independent of `timezone`. Keep `submission_deadline` as the **paper** deadline: it stays the headline and countdown, so the shown date never jumps forward and look like an extension. The abstract date is displayed beside it and stays visible, marked closed, once passed. Auto-filled from OpenReview's `Abstract Registration:` date. |
| `deadline_notes` |  | Free text, e.g. `"extended from Aug 15"`. Bot-imported deadlines keep an `OpenReview-synced …` provenance stamp here; editing this note (or the deadline) freezes auto-sync for that entry. |
| `deadline_history` |  | **Bot-maintained — don't hand-edit.** Append-only log of observed `submission_deadline` values (`{ value, recorded, timezone }`, oldest first; `value: null` = announced with no date). Each entry carries the `timezone` its value was recorded in, since a wall-clock string only fixes an instant together with its zone. `recorded` is the date *this tracker observed* the value, never when organizers changed it. Drives the "Extended by N days" note on the board and the deadline history on each workshop page. Remove an entry only to correct a false positive. |
| `tracks` |  | For multi-track workshops (e.g. Full + Short): list of `{ name, submission_deadline?, timezone? }`. Omit `submission_deadline` for a track whose date isn't announced yet. See note below. |
| `notification_date` |  | `YYYY-MM-DD` |
| `workshop_date` |  | `YYYY-MM-DD` |
| `openreview_venue_id` |  | e.g. `NeurIPS.cc/2026/Workshop/MATH-AI` — enables the automatic paper list |
| `merged_venue_ids` |  | Other OpenReview ids that are this *same* workshop, when organizers created a second group. Recorded so discovery skips them rather than re-creating a duplicate entry |
| `proceedings_url` |  | Accepted-papers page for non-OpenReview workshops |
| `submission_portal` |  | `openreview` \| `cmt` \| `email` \| `other` \| `unknown` |
| `organizers` |  | List of names |
| `previous_editions` |  | List of `{ year, website, proceedings_url }` — only worth filling in for editions this tracker has **no entry for**. Editions that are tracked, and a workshop's other submission tracks, are linked on the workshop page automatically (see ARCHITECTURE.md, "Related entries"); an automatic link supersedes a hand-written row for the same year. |
| `notes` |  | Free text. Bot-imported entries carry a short "topics were auto-suggested — edits welcome" note; the edit form drops it automatically once a human changes the topics. |
| `review_ack` |  | An OpenReview value you reviewed and chose **not** to adopt (`name`, `acronym`, `website` and/or `submission_deadline`), which stops the weekly review reporting it. Stores the rejected value rather than muting the entry: if OpenReview later changes to something different, you are told again. |
| `added` |  | `YYYY-MM-DD` — feeds the "new workshops" RSS |

**Never add a `status` field** — upcoming/passed/past is computed from the dates at build time.
A workshop with no deadline and no `workshop_date` becomes **Past** automatically once its
conference edition ends — edition dates live in `data/editions.yml` (one row per
conference-year, `end` required; `node scripts/validate.mjs` notes any tracked year missing
a row). When a year has no row, the coarser `typical_month` from `data/conferences.yml` is used.
An **open (future) deadline always keeps a workshop an Open call**, even past its conference's
end date — so a challenge whose deadline runs after the conference (common for competitions)
isn't wrongly marked Past; it flips to Past only once the deadline itself passes.

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

`node scripts/topic_options_sync_test.mjs` — the "Topics" checkbox lists
in both issue forms match `data/topics.yml`. The options are generated into the
templates by `node scripts/gen_topic_options.mjs`; run that after editing
`data/topics.yml` so the picker can never offer a stale or misspelled set.

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

`node scripts/recheck_imminent_test.mjs` — the daily imminent re-check selects
only bot-managed deadlines within `[−7d, +14d]` (the look-back is what catches a
post-deadline extension) and skips hand-edited, legacy, multi-track, and
venue-id-less entries; its apply path reuses the sync helpers above.

`node scripts/deadline_crosscheck_test.mjs` — the cross-check classifies a
stored-vs-OpenReview gap (tz-suspect vs. real change) and, by provenance, decides
what needs human review: a human-edited deadline that disagrees, or a bot-managed
one OpenReview moved earlier (later moves auto-sync; legacy entries are skipped).

`node scripts/issue_edit_to_yaml_test.mjs` — the "Edit a workshop" form transform
applies only the filled-in fields to an existing entry, converts a new deadline
from its timezone to UTC (verified by round-trip), requires a timezone when a
deadline is given, replaces an entry's topic list when topics are selected, and
leaves identity and unrelated fields untouched.

Validation failures are posted as a PR comment listing every problem at once.

## Paper lists

Don't paste papers by hand. Set `openreview_venue_id` and the monthly `openreview-refresh` workflow fetches the accepted papers into `cache/openreview/<slug>.json` (a maintainer can also run `node scripts/fetch_openreview.mjs --slug <slug>` immediately). For workshops elsewhere, set `proceedings_url`.

## For maintainers

- **Review queue:** PRs from contributors and from the two bots (`issue-to-pr`, `openreview-refresh`). CI has already validated data PRs — skim and merge.
- **Auto-synced deadlines:** the weekly `discover` job keeps OpenReview-imported deadlines in step with extensions (later-only by default) and records each change in its commit message — no PR. A deadline (or its `deadline_notes`) you edit by hand is **frozen**: the bot won't re-sync it. Notes beginning `OpenReview-synced …` are bot-stamped; changing the date or replacing the note hands that deadline to manual control. To also follow earlier corrections, flip `ALLOW_EARLIER` in `scripts/discover_openreview.mjs`.
- **Daily imminent re-check:** a daily `recheck-imminent` job re-checks only deadlines within `[−7d, +14d]` and applies OpenReview extensions within ~24h instead of waiting for the weekly run — so a near-deadline extension, including one announced a day or two *after* the original date (the look-back window), lands fast. Same gates as the weekly sync (later-only, plausibility, frozen-on-hand-edit) and same no-PR commit; it never enumerates or adopts, so new-venue discovery and legacy adoption stay weekly. It's the fast path; the weekly run is the backstop for anything outside the band.
- **Fixing a stale/extended deadline now:** rather than hand-editing the time (easy to get the timezone wrong), re-pull it from OpenReview — Actions → **Re-sync deadline from OpenReview** → enter the slug (or locally `node scripts/resync_deadline.mjs --slug <slug>`). It sets the deadline to OpenReview's current duedate, in either direction, and re-stamps it for future auto-sync.
- **Deadline review issue:** a weekly `deadline-review` workflow keeps one self-maintaining issue ("Data health: deadlines to review", `data-health` label) listing only deadlines the auto-sync won't fix itself — ones you hand-edited that now disagree with OpenReview, and bot-managed ones OpenReview moved *earlier* (the bot is later-only). Each item links the re-sync command; resolve by re-syncing (trust OpenReview) or leaving it (keep yours). The issue closes itself when nothing's outstanding. Bot-managed later moves and legacy entries never appear — they sync automatically.
- **Re-tagging auto-suggested topics:** topics on bot-imported entries are keyword-guessed from the title (and flagged "auto-suggested" in `notes`). If you improve the keyword table in `scripts/discover_openreview.mjs`, run `node scripts/retag_topics.mjs --dry-run` to preview, then `node scripts/retag_topics.mjs` to apply — it re-guesses **only** entries still tagged `other` with that auto note, so anything a human has curated is left untouched.
- **Health issues:** two auto-maintained issues labelled `data-health` (stale entries, broken links). They update in place and close themselves when clean.
- **Seed data:** entries whose `notes` contain `SEED DATA` are unverified placeholders from the initial build — verify or replace them.
- Data is licensed CC-BY-4.0; by contributing you agree your additions are too.
