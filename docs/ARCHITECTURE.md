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
offset, ≤14h, not ~a day) vs. a real change, as a hint. The same pass also reports **website drift**: the importer only ever fills a
*blank* `website` and never revisits it, which protects a hand-picked URL but
means one that goes stale stays stale — IROS BEMHAT's stored site had been
unpublished and redirected to a Google sign-in page while OpenReview listed a
working one. Differences in scheme, a leading `www.`, a trailing slash or case are
ignored so the report stays quiet. Like an earlier deadline move, it is reported
and never applied: ours is sometimes the better link. It costs no extra requests,
since the venue group is already in hand from the batched listing.

It also reports a **rename**: the importer records `name` and `acronym` once and
never revisits them, so a workshop that renames itself keeps the old label
indefinitely — MPLR-FM became "Privacy in the Era of Large Opaque Models"
(PriLOM) and only came to light because its website moved at the same time.
Comparison strips what differs by convention (case, punctuation, the conference
token, year fragments and connectives), which across the whole dataset leaves
0.3% of titles flagged. Acronyms are only compared when OpenReview's `subtitle` is
acronym-shaped, because it is often a descriptive phrase and comparing against
those produced a 4.9% false-positive rate. Identity checks run over EVERY
OpenReview-linked entry, not just the deadline-review window, since a rename
matters whenever it happens; the listings are per conference-year, so that costs
~24 requests rather than one per entry.

Deciding **against** OpenReview needs somewhere to live, or the same difference is
reported every week forever. `review_ack` records the OpenReview *value* that was
reviewed and declined — for a `name`, `acronym`, `website` or `submission_deadline`
— and the check stays quiet only while OpenReview still says that. A later,
different change is reported again, so this is an acknowledgement of one decision
rather than a mute on the entry. Cosmetic churn in the declined value doesn't
un-suppress it, since each check reuses its own normaliser (deadlines compare as
instants). `notes` is free text nothing reads, so a decision written only there
changes nothing — the pairing is deliberate: `notes` explains the call to a human,
`review_ack` silences the report.

Matching that precedence matters: on a two-stage venue the
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
`workflow_dispatch`) lets a maintainer re-pull one workshop's deadline from
OpenReview in either direction, re-stamping it for future auto-sync — so fixing a
stale or mistyped deadline never requires hand-typing a UTC time. It uses the same
value precedence as everything else (group `date` line first, invitation as
fallback) and syncs `abstract_deadline` alongside. Reading the invitation alone
used to make it *fail* on venues that publish only on the date line — the very
command the review issue prints — and to leave a two-stage venue advertising an
abstract gate dated after its own paper deadline.

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

## Related entries (sibling tracks and other editions)

The in-entry `tracks` field above covers tracks that live as child groups under
one OpenReview venue. Some workshops instead publish each track as its own
*top-level* venue (NeurIPS 2026 NeurReps is three: `NeurReps_Extended_Abstracts`
/ `_Findings` / `_Proceedings`), and every workshop series returns each year as
a fresh venue — so related entries end up as independent YAML files with nothing
linking them. `computeRelations()` (lib/workshops.mjs) derives the links at
build time from the whole corpus — nothing is stored, so a new crawl needs no
human to wire anything up. Three signals, in decreasing strength:

1. **Same website** (after folding scheme/`www.`/fragment/query/trailing-slash
   variants, plus Google Sites' `/corp/` and `/home` spellings) — the same site
   is the same workshop.
2. **Same venue-id stem within one conference-year** — a corpus-validated
   suffix vocabulary (`_Findings`, `_Track_1`, `_Non-Proceedings_Track`, …) is
   stripped from the venue id's last segment. Needed because siblings don't
   always share a website (ATTRIB_Late has none; IAB's competition track has
   its own).
3. **Same site, different paths** (series with per-edition URLs, e.g.
   `latinxinai.org/icml-2024`) — but never on the address alone, because real
   labs host *unrelated* workshops on one domain (dynsyslab.org, vap.aau.dk).
   A shared site is the *gate*; identity still has to be confirmed, by either of
   two things.

   **Confirmed by names.** The names must share identifying words — two shared
   tokens, or Jaccard ≥ 0.5 over `nameTokens()`. Two details earn their keep:

   - Names compare **pairwise**, entry against entry, never group-union against
     group-union. A same-website group holds a workshop *and its tracks*, and a
     track is often named for itself: unioning let "MetaFood Non-Proceedings
     Track" drag its group to `{metafood, non, proceedings}`, which against
     `{metafood}` shares one token and scores 0.33 — a sibling that identifies
     nothing vetoing a correct match. Pairwise is also the honest reading of the
     guard, which asks whether two *names* agree, and a name is what one entry
     is called.
   - Track vocabulary is in `NAME_STOPWORDS` (`proceedings`, `archival`,
     `findings`, `shared`, `task`, …) beside the `track`/`tracks` already there.
     It names a track, never which workshop the track belongs to, so without it
     two unrelated workshops each publishing a "Non-Proceedings Track" agree on
     `{non, proceedings}` alone and merge. Same vocabulary `TRACK_SUFFIX` reads
     out of venue ids, for the same reason.

   **Confirmed by the registered short name.** Some series no amount of token
   matching can see: "Representational Alignment" and "Re-Align" share *zero*
   tokens; "NewInML" against "New In Machine Learning (NewInML) Workshop"
   scores 0.25. Both register the same short name on OpenReview every year, so
   a shared `venueStem()` confirms identity too.

   Note how this differs from signal 2, because the difference is the whole
   point. Signal 2 compares `venueFamily()`'s **full key**, which embeds the
   conference and the year — that is what scopes it to a single conference-year.
   This compares only the key's **trailing segment**, the short name itself, so
   it crosses editions. Written as key equality it would compile, review fine,
   and link nothing; `venueStem()` exists so that is hard to get wrong.

   Neither confirmation is safe alone: a short name is short and recurs across
   unrelated venues (`opt`, `gram`), and a site root alone links nothing. The
   pair means the same organisers registered the same short name — identity, not
   coincidence. That is why this lives inside the site bucket rather than being
   a tier of its own.

   The unit is `siteRoot()`, not the bare hostname. A generic host
   (github.com, codabench.org, …) belongs to nobody and has no site root, so it
   is skipped — *unless* the host hands each publisher a path namespace, which
   then plays the part the hostname plays elsewhere:
   `sites.google.com/view/social-sims-with-llms` is one organiser's site as
   surely as `latinxinai.org` is. Skipping the whole host was costing real
   links: 175 entries live on Google Sites, and eleven genuine series sat
   unlinked because of it.

   Depth two, and the number is measured rather than assumed. Depth one makes
   `sites.google.com/berkeley.edu` a publisher, and two unrelated Berkeley
   workshops share the words "foundation" and "models" readily enough to satisfy
   the name guard — a university is not a publisher. Dropping the host from
   `GENERIC_HOSTS` outright adds **3821** links as the union cascades across the
   host, which is the quantitative case for narrowing the *unit* rather than
   loosening the *guard*.

   `siteRoot()` also folds the year and conference out of the site name, because
   editions usually get one site each and name it for the edition:
   `hcvworkshop2024` and `hcvworkshop2026` are one series, as are `mhf-icml2024`
   and `mhf-icml2025`. Same reasoning as `stripVenueFromName()`, applied to a URL
   segment instead of a title — and the same reason it is derived rather than
   configured: next year's site links itself with nothing to update.

   `websiteKey()` is deliberately left exact, so Tier 1 keeps meaning "the same
   page". Collapsing sub-pages there would union two workshops sharing one
   Google Site with no name guard at all, since Tier 1 is the one tier without
   one.

Each entry gets `relatedTracks` (same conference-year siblings, labeled by
their venue-id suffix, shown with their own deadlines) and `relatedEditions`
(the rest of the series, newest first). Only the workshop page renders them;
an automatic edition link supersedes a hand-written `previous_editions` row
for the same year, while untracked years keep their external links. Precision
is deliberately favored over recall — an unlinked sibling is the safe failure.
Pinned by `scripts/relations_test.mjs` (fixtures are real corpus records,
including the must-NOT-link domain collisions). Each fixture is checked to FAIL
without the rule it pins — one that passes either way pins nothing, and this
suite has caught exactly that twice.

**Changing any of this is a guard-loosening change**, so it follows a fixed
procedure: enumerate the old rule against the new over the whole corpus, diff
the links, read every one that changes, and only then land it. Measure bundled
rules separately and say which did the work — when pairwise comparison and the
track stopwords shipped together, the stopwords accounted for every new link and
pairwise was a no-op on the corpus, which is worth knowing rather than letting a
diff imply both mattered.

## A workshop's one-line identity

Most surfaces need a workshop named in one line — the page `<title>`, the saved
list, conference hub rows, the board countdown. The stored `acronym` cannot be
used raw for that, for two independent reasons, and both come from upstream
rather than from us.

**It repeats the venue.** OpenReview's `subtitle` is frequently the conference
itself, so 11 entries arrived with an "acronym" of `NeurIPS 2025` or `COLM 2026`,
and 389 of 926 contained the conference name somewhere. Since every surface that
shows the name already says which conference-year it is, that read twice — and
where the acronym was *only* the venue, a workshop appeared on its own hub page
called "COLM 2026".

**Sibling tracks share it.** A workshop split across an archival and a
non-archival track is two entries with one acronym. That produced 13 pairs of
pages with identical `<title>`s (search engines pick one and drop the other) and
3 pairs with identical saved-list labels — so starring papers from both tracks of
a workshop merged them into one group with no way to tell them apart.

`workshopShortName()` in `lib/workshops.mjs` is the single definition. It strips
the venue noise, then appends the track label that `venueFamily()` already
derives from the venue id and that the Tracks section on each page has always
shown. Everything reads from it, so those surfaces cannot drift apart, and a
newly imported track is named correctly with no edit at all.

The disambiguation is *derived, never stored*. Writing "(Extended Abstracts)"
into an acronym by hand fixes only the row someone remembers to edit, and it
double-prints the moment the label is derived too. When a new track suffix is not
recognised, the fix is to teach `TRACK_SUFFIX` the suffix — not to hand-edit the
entry. `scripts/acronym_identity_test.mjs` holds the invariant over the real
corpus (short names unique within a conference-year) and says so in its failure
message.

A handful of venue ids carry suffixes nothing can read — `AUTOPILOT-AT` vs
`AUTOPILOT-NA`, `MLMP-IRT` vs `MLMP`. Those siblings are told apart only by having
different names today. The test reports them as a warning rather than failing:
labelling them would mean inventing meanings for two-letter suffixes, and widening
`TRACK_SUFFIX` far enough to catch them would start eating real workshop names.

The same normalisation runs at the point of entry — `discover_openreview.mjs` and
`issue_to_yaml.mjs` both apply it — so the stored data matches what is rendered
and the slug never bakes in a venue.

**The page `<title>` is built from it**, as `<name> Workshop (<track>) @ <conf>
<year> — Papers & Deadline`. Detail pages are the one place that omits the
" · AI Workshop Tracker" suffix (`siteSuffix={false}` on `Base.astro`): a search
result shows roughly 60 characters, and 22 of them spent on the site name pushed
the words these pages should rank for — the workshop, its conference-year, and
"Deadline" — off the end. `og:site_name` carries the brand into social embeds
instead, where it renders as its own field rather than competing with the title.
Hubs and About keep the suffix, since there the site name is plausibly part of
what someone typed. See AUTOMATION.md, "What a new entry inherits
automatically".

## Two-stage venues (abstract registration, then paper)

About 3% of OpenReview venues (6 of 229 sampled) gate paper submission behind an
earlier **mandatory abstract registration**. Their group `date` line carries both
components, e.g. `Abstract Registration: Aug 20 …, Submission Deadline: Aug 29 …`,
and `parseGroupDeadline()` deliberately anchors on *Submission Deadline* so the
stored headline is always the **paper** deadline — the last moment a submission can
land. The earlier date is stored separately in `abstract_deadline` (always UTC),
filled at import and kept current by the daily re-check.

An abstract date only counts as a stage when it is at least an hour before the
paper deadline. Organizers sometimes fill the field as a formality — NeurIPS
EconML ended up with abstract 11:59 and paper 12:00 on the same day — and
surfacing that would put an `ABSTRACT` countdown on the page that expires sixty
seconds before the real one. Below the threshold the field is removed rather than
stored, and the daily re-check applies the same rule, so a venue that collapses
its two stages stops advertising one instead of having it re-added the next
morning.

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

Stars appear on every workshop list — the board, search and filter results,
conference listings, and each workshop page. They are always rendered rather than
revealed on hover, because most of the traffic is phones and hover does not exist
there.

### Two renderers for one row

The board renders a row server-side from `WorkshopRow.astro`; `/saved/` renders
the same row in the browser, because only the browser knows what a visitor saved.
Two implementations of one row drift, and this one did: the saved list quietly
lacked the location, the topic chips and the deadline-change note, and printed the
raw stored deadline where the board printed a formatted one. Three of those could
not be fixed client-side at all — they are whole-corpus or history derivations —
which is why the API publishes them.

`scripts/row_parity_test.mjs` (in `validate.yml`) now guards it: every field the
board displays must have an equivalent in the saved renderer, with a short
exempt list. It is a structural check, not a pixel one — it cannot prove the
output matches, but it catches the common case of a field added to one renderer
and forgotten in the other.

Paper snapshots store a stable id (OpenReview forum id where available), the
title, the workshop slug, and the exact PDF url when known. A pre-2026 snapshot
shape (with a `url` field) still renders, so no migration is needed.

## Email alerts (optional satellite)

The one exception to "no backend" — and it is structured so that it stays an
exception. A single Cloudflare Worker plus one D1 database (`alerts/`) offers a
weekly digest, opt-in urgent deadline alerts, and cross-device syncing of the
saved list. **The site does not depend on any of it.** The Worker *reads* the
site's public `/api/workshops.json`; nothing flows the other way. Build with
`PUBLIC_ALERTS_API` empty — every fork and PR preview does — and the signup
component, the `<meta name="alerts-api">` tag, the sync code path and the
component's CSS are all absent from the output. Deleting `alerts/` entirely
leaves a site identical to the one before it existed.

The decisions worth knowing before changing anything here:

- **Actions, not Worker cron.** The daily diff and the Monday digest run in
  `alerts.yml` alongside the rest of the automation fleet, so rendering hundreds
  of emails never meets a Worker's CPU limit and a failure emails the maintainer
  like every other job. The Action is stateless: every read and write goes
  through the Worker's `/admin/*` endpoints, which means it never holds a
  database credential, never holds the mail provider's key, and never mints a
  subscriber token. It renders emails with `{{UNSUB_URL}}`/`{{MANAGE_URL}}`
  placeholders and the Worker substitutes real per-recipient links at send time
  — so a token cannot leak through a workflow log.
- **Filters, not resolved lists.** A subscription stores conference ids and
  topic ids, never a list of matching workshops, so a workshop announced next
  month matches an existing subscription with no migration. Starred slugs are
  stored separately and bypass the filter entirely.
- **Signed tokens, no passwords.** Identity is an email address plus an
  HMAC-signed token carrying a purpose and the subscriber's `nonce`. Purpose is
  signed in, so a leaked unsubscribe link can only unsubscribe — it cannot read
  or edit preferences. Rotating the nonce revokes every token ever issued for
  that address at once, which is the entire revocation mechanism (there is no
  session table). Manage tokens travel in the URL **fragment**, never the query
  string, so they stay out of server logs and referrers.
- **The shrink guard.** The daily diff aborts without writing if the live feed
  is under 70% of the stored snapshot. A truncated fetch would otherwise read as
  hundreds of workshops disappearing — and, on the next run, reappearing as
  "newly announced" in everyone's inbox. Same paranoia as the importer's
  later-only rule. A first run with no snapshot seeds silently for the same
  reason.
- **Change classification mirrors the site.** `alerts/diff.mjs` uses the same
  `MIN_CHANGE_MS` threshold and the same `max(1, round(days))` rounding as
  `deriveDeadlineChange`, and `alerts_diff_test.mjs` asserts the two agree on
  concrete cases. Otherwise an email could announce an extension the board
  suppresses.
- **Saved-list sync records intent; it does not infer it.** The account holds
  the truth and each device holds the truth *plus* an outbox of what it has done
  since it last reached the server: `local = (server ∪ pending.add) −
  pending.remove` (`site/src/scripts/star-merge.js`, unit-tested by
  `scripts/alerts_starmerge_test.mjs`). An earlier version merged by set
  difference instead — anything a device had that the server lacked was
  uploaded — which cannot tell "I starred this offline" from "another device
  deleted this". With two devices every removal was resurrected: the second
  device re-uploaded the item the first had just deleted. Intent is not
  recoverable from state; it has to be written down.
- **The outbox is retired by observation, not by a `200`.** An entry leaves only
  once the server is seen holding the intended state. `/sync` reads the
  subscriber row, edits it and writes it back as separate statements, so two
  concurrent calls can each return `200` while one silently overwrites the
  other — and a dropped response looks the same from the client. Retiring on
  observation makes both self-correcting: the next page load simply retries, and
  `/sync` is idempotent, so retrying is free. For the same reason every sync
  request is serialized rather than fired in parallel.
- **A device remembers which account it synced with** (`awt-fav-synced`), so
  linking a *different* account adopts that account's list instead of merging
  the previous one into it. A device that has never synced seeds its whole local
  list as pending adds, which is what makes "star things, then sign up" work.
- **What remains is ordinary last-write-wins.** Two devices editing the same
  item while one is offline resolve in whatever order reaches the server. No
  vector clocks, no tombstone GC — the failure it can produce is one item
  resolving the way you didn't expect, not a list emptying itself.
- **No PII in the repo, ever.** Addresses live only in D1. The `events` and
  `kv` tables hold workshop data only, which is why the Action can log slugs and
  counts freely — and why it logs nothing else. Unsubscribing is a `DELETE`, not
  a flag; there is no deactivated state to accumulate.

The full operational picture — setup, secrets, dry runs, manual deletion,
provider cutover — is in [ALERTS.md](ALERTS.md).

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

It also publishes the derivations a client cannot compute from a single row:
`location_label` and `location_distinguishes` (whether that conference-year runs
in more than one place — a whole-corpus count), `deadline_change` (the note the
board prints, derived from the entry's history), and `deadline_wall_clock` /
`abstract_deadline_wall_clock` (the formatted strings the board displays, so a
client renders "Sep 26, 2026, 12:59 UTC" rather than re-printing the raw stored
value). These exist for the saved list, which renders rows in the browser; see
"Two renderers for one row" below.

It also carries `short_name` and `track_label` — the site's own one-line identity
for the entry (see "A workshop's one-line identity"). These exist because
`acronym` alone is ambiguous: sibling tracks share one upstream, so 15 pairs in
the corpus have identical acronyms, and the disambiguating label cannot be
reconstructed downstream — it is attached only when an entry actually has
siblings, which the payload never exposed. Without them every consumer either
mislabels those pairs or reimplements `venueFamily()`. This project's own alerts
digest was the first casualty: it built email subjects from `acronym || name`,
so two different workshops produced byte-identical "Deadline update: CVEU".

## Build-time Markdown exports

`/exports/<conference>-<year>-workshops.md` is regenerated on every deploy by
`site/src/pages/exports/[export].md.ts`. Like the calendar feeds, the route uses
`getStaticPaths()` to emit one static file per conference-year. Conference pages
link directly to the generated file for downloads, and the Copy action fetches
that same URL on demand; the Markdown payload is never embedded in page HTML.

## Contributors are validated by CI, not by a human

Schema and sanity checks comment on PRs with exactly what to fix, and issue
forms (add and edit) auto-convert to PRs for non-technical contributors, so reviewing data
quality isn't a manual burden. See [AUTOMATION.md](AUTOMATION.md) for the
full workflow list.

The add/edit issue forms collect topics as a **checkbox list** and the
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

## The sitemap dates each page from git, not from the build

`<lastmod>` is a claim to a crawler, and it can be wrong in two directions.

Stamping every URL with the build time is the obvious approach and the worse
one: this site rebuilds itself daily, so it would assert that ~900 pages change
every night. A crawler that keeps refetching pages it finds unchanged learns to
discount the field, and then it is worth nothing on the day a page really does
change.

Deriving the date from what the YAML records about itself — `added`, and the
`recorded` stamps in `deadline_history` — is honest but half-blind. It cannot see
a name being corrected, a website finally being filled in, or a paper list being
refetched, so a page that genuinely changed keeps advertising a months-old date
and never gets recrawled.

Git already knows. `lastDataChange()` in `lib/workshops.mjs` runs one `git log`
over the two directories that feed a workshop page — its own YAML and the
accepted-paper cache it renders — and takes the newest commit touching either.
That is ~70ms for the whole corpus. Only the pages that genuinely track the whole
dataset (home, the hubs, about) carry the build date, because for them it is true.

The fallback matters as much as the mechanism: with no git history the function
returns the in-YAML dates rather than failing the build, so a tarball export or a
shallow checkout still produces a sitemap. That fallback is silent, which is
precisely why `deploy.yml` sets `fetch-depth: 0` — a depth-1 checkout would date
every page to the same single commit and look entirely plausible.
`scripts/sitemap_lastmod_test.mjs` pins the properties rather than the dates:
every page dated, nothing in the future, never older than the YAML's own stamps,
and — the one that catches both failure modes — the dates must spread across many
days rather than collapsing onto one.

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

## The UI behavior suite runs on every PR

`scripts/ui_test.mjs` is a headless-browser suite that locks the homepage's
runtime behavior — the dual-index search and its merge-immune counts, the
deterministic result order, the external-vs-internal link rule, the back/forward
restore, and the deploy-staleness heal. 124 checks. It runs in
`pr-build-check.yml`, which already builds the site with the production
environment, so the suite drives the artefact that would actually ship.

This was a documented gap for a long time, and worth being explicit about why it
mattered here specifically. Data and content changes cannot reach the code these
tests guard, and `validate.yml` already covers those — so adding workshops or
papers was never the risk. The exposure was a **hand-edit to the search / link /
back-nav code that still compiles**: `deploy.yml` only builds, so a behavior
regression would build and ship with nothing flagging it. Given that most changes
to this repo arrive as sweeping edits made across sessions rather than as small
reviewed diffs, that was the single largest unguarded surface in the project.

**Cost.** A Chromium download (~150 MB) cached on `~/.cache/ms-playwright` and
keyed by the Playwright version, so it is fetched once per upgrade and takes
seconds thereafter; the OS libraries are not cacheable, so they are installed
either way. Plus a preview server for the life of the job. Call it two to three
minutes of PR latency. The repo is public, so Actions minutes are free.

**If it goes red, read this first.** A browser suite is the one test category
that fails for timing reasons as well as real ones, and a flaky required check
teaches you to ignore CI — which is worse than not having the check. Two known
shapes, neither of which is a regression:

- **The server was not ready.** The job waits up to 60s for `:4321` to answer and
  prints the preview log on failure. If that log shows a slow start rather than a
  crash, lengthen the wait.
- **Pagefind's parallel chunk fetches stalled.** The engine fetches many index
  chunks at once, and a server that cannot serve them concurrently produces
  intermittent timeouts deep in the suite rather than a clean failure. `astro
  preview` handles this; a single-threaded `python -m http.server` does not, so
  if the server is ever swapped it has to be a threaded one. (`astro preview`
  once double-gzipped the already-gzipped chunks — "invalid gzip data" — but that
  no longer reproduces.)

The fix for either is a retry on the suite step or a longer wait. Deleting the
step, or loosening an assertion to make red go green, gives back exactly the
coverage this section spent so long arguing for.

Run it locally the same way CI does: `npm run build --prefix site`, then
`npm run preview --prefix site` in one shell and
`node scripts/ui_test.mjs http://localhost:4321` in another.
