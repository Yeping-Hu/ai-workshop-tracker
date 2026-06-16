---
name: add-conference
description: End-to-end procedure for adding a new conference (e.g. EMNLP, ACL, NAACL, AAAI, KDD, ECCV, ICCV, WACV, RLC, AAMAS, COLM) to the AI Workshop Tracker website (aiworkshoptracker.com, repo github.com/Yeping-Hu/ai-workshop-tracker). Use this skill whenever the user asks to add, track, support, or import a conference or its workshops on the tracker; asks whether a conference can be added or which conferences are feasible; or mentions importing workshop deadlines / accepted papers from OpenReview for a new venue. Covers feasibility probing, wiring via the repo CLI, OpenReview import with rate-limit handling, status verification, README sync, the gated test suite, pushing, and an optional announcement draft.
---

# Add a conference to AI Workshop Tracker

The tracker is a static Astro site whose database is the Git repo itself.
Adding a conference = research it, wire 4 touchpoints, import from
OpenReview, verify, ship. Each step below exists because skipping it has
caused a real failure at least once. Total time: ~10–15 minutes.

## 0. Environment

If `/home/claude/ml-workshop-tracker` (or another checkout) already exists in
this session, use it. Otherwise:

```bash
git clone https://github.com/Yeping-Hu/ai-workshop-tracker.git
cd ai-workshop-tracker && npm ci && (cd site && npm ci)
```

Pushing requires credentials. Do **not** ask for them up front — do all the
work first, and at ship time ask the user for a GitHub token (fine-grained,
this repo, Contents read/write), set it via
`git remote set-url origin https://<user>:<TOKEN>@github.com/Yeping-Hu/ai-workshop-tracker.git`,
and remind them to revoke it afterwards.

## 1. Research gate (required — do not skip to wiring)

Conferences use OpenReview in two very different ways, and one isn't there
at all. Classify first:

```bash
python3 skills/add-conference/scripts/probe_conference.py --families   # pattern cheatsheet
python3 skills/add-conference/scripts/probe_conference.py \
  --prefix 'AAAI.org/{year}/Workshop' [--prefix '<second guess>']
```

The probe reports venue counts per year, deadline-metadata coverage (venue
date lines, plus a sample of submission invitations checked for
machine-readable `duedate`s — the importer reads both, expired included),
samples public paper availability, and prints one of three verdicts:

- **fully-hosted (CoRL-like)** — papers are public notes; everything imports.
- **review-only (CVPR-like)** — deadlines and links import; accepted papers
  live elsewhere (CVF Open Access, ACL Anthology…). Empty paper caches are
  **correct**, not a bug. Workshop pages show deadlines + links instead.
- **absent** — stop. Report to the user; offer the issue-form path
  (per-workshop entries with `proceedings_url`), which has no auto-discovery.

Report the verdict and venue counts to the user before proceeding. If counts
are tiny (<5/year), let the user decide whether it's worth a facet slot.

## 2. Wire the four touchpoints (use the CLI, not hand edits)

Hand-editing these files with string replacement has broken twice on stale
anchors — the repo ships a CLI that does it atomically and idempotently:

```bash
grep 'color:' data/conferences.yml        # see the palette; pick a DISTINCT hue
node scripts/add_conference.mjs \
  --id emnlp --name EMNLP \
  --full-name "Conference on Empirical Methods in Natural Language Processing" \
  --prefix 'EMNLP/{year}/Workshop' --color '#0E7490' --month 11 \
  --dry-run                                # inspect, then rerun without --dry-run
```

`--month` is the month the conference itself usually runs (drives the
status fallback for entries without dates). `--website` defaults to the
prefix's domain; pass it explicitly for bare prefixes like `EMNLP/...`.
Everything downstream — eyebrow line, facet dropdown, counts, colors,
tests — is data-driven and picks the conference up with **zero further
edits**. Never hardcode the conference count anywhere, especially in tests.

## 3. Import

```bash
for y in 2024 2025 2026; do   # the years the probe showed venues for, + next
  node scripts/discover_openreview.mjs --conf <id> --year $y; sleep 1
done
node scripts/validate.mjs
```

Lines like `(skipped N archival/non-archival track twin(s))` are normal —
workshops often register duplicate track venues and discovery merges them.

**Run discovery for each year a second time before shipping.** Discovery
backfills missing deadlines from submission-invitation `duedate`s, but those
per-venue lookups get rate-limited (HTTP 429) during a large first import and
fail silently — a throttled lookup is indistinguishable from "no deadline",
so venues land as "Deadline unknown" despite having a visible deadline on
OpenReview (this is exactly how ECCV's WICV and ~20 siblings slipped through).
A second pass, when the API is less throttled, recovers them and reports
`N deadline(s) backfilled`. Repeat until a run backfills 0:

```bash
for y in <years>; do node scripts/discover_openreview.mjs --conf <id> --year $y; sleep 2; done
# re-run any year that still reports backfills until it reports 0
```

Fetch paper caches in **resumable passes** — OpenReview rate-limits (HTTP
429) bulk fetches, so never parallelize and expect multiple rounds:

```bash
timeout 140 node scripts/fetch_openreview.mjs   # repeat until counts match:
echo "caches: $(ls cache/openreview | wc -l) / $(ls data/workshops/*.yml | grep -vc template)"
```

API quirk worth knowing: the notes endpoint has **no `count` field** —
count `len(response.notes)` with `limit=1000`.

## 4. Verify & ship

```bash
cd site && npm run build && cd ..
python3 -c "
import json
from collections import Counter
d = json.load(open('site/dist/api/workshops.json')); ws = d['workshops']
print('total:', d['count'], '| new conf:', sum(1 for w in ws if w['conference']=='<id>'))
print('labels:', dict(Counter(w['status_label'] for w in ws)))
print('open calls:', [(w['slug'], w['submission_deadline']) for w in ws
                      if w['status']=='upcoming' and w['deadline_utc']])"
```

**Report any NEW open calls to the user — future deadlines are the
headline of every conference addition.** Sanity: a venue with cached papers
must never be "Open call"; venues without deadline metadata read
"Deadline unknown" — their YAML opens with a fill-in comment template and the
page shows a "know the deadline? Add it in one line" link; the weekly
discovery job backfills them from venue date lines or submission-invitation
`duedate`s (expired included) whenever those appear. Workshops that split
submissions into sub-track child groups (e.g. `…/Full` + `…/Short`) are
handled too: discovery descends one level and takes the earliest child
deadline plus an inherited website.

**Also check the deadline-unknown ratio for the new conference's current
year.** If a large fraction (say >25%) of current/future-year venues read
"Deadline unknown", suspect rate-limit gaps from the first import, not
genuine absence — re-run discovery for that year (see §3) and recount. Only
treat a venue as truly deadline-less after a clean re-run still skips it; you
can confirm by querying its `…/-/Submission` invitation directly for a
`duedate`.

README sync (standing repo rule — every push updates it): the conference
list appears in the features bullet **in the dropdown's order** (plain JS
`.sort()` of display names — case-sensitive, so e.g. CVPR < CoRL), and bump
"across all N conferences" and the edition count.

Run the UI suite **gated on the real exit code** — never on a pipeline's
tail status (that masking once let a red suite push):

```bash
(nohup python3 -m http.server 4321 -d site/dist > /tmp/http.log 2>&1 &); sleep 1
node scripts/ui_test.mjs > /tmp/suite.log 2>&1; EXIT=$?
tail -2 /tmp/suite.log
# if EXIT != 0: read the ✗ lines, fix, rerun. Push ONLY on green:
git add -A && git commit -m "feat: add <NAME> (<n> editions)" && git push
```

The deploy workflow publishes automatically on push (~2 min). The weekly
Tuesday discovery keeps importing new venues and backfilling deadlines for
this conference forever after — no further action.

## 5. Optional: announcement draft

If the import surfaced upcoming deadlines, offer the user a short post:
"<N> <CONF> workshop deadlines in the next <window>, now tracked with live
countdowns at aiworkshoptracker.com — filter Conference → <NAME>." Deadline
season is when the site spreads.

## Pitfall appendix (each earned the hard way)

- Review-only conferences produce empty caches — correct behavior, say so.
- 429s on fetch: pace, resume, never parallelize.
- `notes` API: no `count` field; `len(notes)`.
- Track-twin venues (`_Non_Archival`, `_Proceedings_Track`, `_Pre_Reviewed`,
  `_Abstract_Paper_Track`, `_Extended_Abstract_Track`) are auto-skipped by
  discovery; don't re-add them manually. If a new twin suffix shows up,
  extend `TRACK_SUFFIX` in `discover_openreview.mjs` rather than deleting the
  file by hand (discovery would just re-create it next run).
- Sub-track submission groups: some workshops leave the parent group empty
  and split submissions into children (`…/Full` + `…/Short`, Long/Short
  paper tracks, etc.) that carry the real `submission_id`/website. Discovery
  descends one level via `subTrackInfo()` and takes the EARLIEST child
  deadline (so "one track open, one TBA" still surfaces a real deadline) plus
  an inherited website. If a workshop shows "Deadline unknown" but its
  OpenReview page has multiple Submission buttons, this is the path that
  handles it — a clean re-run backfills it.
- Statuses derive from dates AND paper caches (papers ⇒ call closed).
- The eyebrow ↔ dropdown order is pinned by a test; both use plain `.sort()`.
- Prefer `add_conference.mjs` over manual edits; verify anchors if you must
  hand-edit, and `assert` before replacing.
- Add a `data/editions.yml` row per imported year ({conference, year, end,
  optional start/source — use the official site}). It flips deadline-unknown
  workshops to "Past" the day the conference ends; without it, status falls
  back to the blunter `typical_month`. `validate.mjs` warns about tracked
  current/future years that lack a row.
- Updating this skill: the canonical copy lives in the repo at
  `skills/add-conference/`; if you change it, offer the user a fresh zip for
  their claude.ai upload so the two copies don't drift.
