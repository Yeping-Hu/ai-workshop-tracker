# Experiments on this branch (`engagement-preview`)

This branch carries six experimental features for the tracker, built in
September 2026 and **not yet decided on**. `main` has none of them. This note
is the last commit on the branch and is never meant to be cherry-picked.

## Why

Goal: make the tracker more engaging for students and researchers and bring
them back, *without* fighting the quiet "departure board" design
(`docs/ARCHITECTURE.md` records that a scrolling ticker and a card grid hurt
the board). So the rule was "useful-fun": small things built from data nobody
else has, no motion, no gamification, each one measured.

## The six commits

Each feature is one commit, so any subset can be kept by cherry-picking onto
`main`. Keep commit 1 first if you keep anything else.

| # | Commit | Feature | Where to look |
|---|---|---|---|
| 1 | `3b2aebe` | **Shared analytics helper.** One `track()` function (`window.awtTrack`) through which every feature sends a named GoatCounter event; the vocabulary is listed in `docs/ARCHITECTURE.md` and pinned by `scripts/analytics_events_test.mjs`. No-op without GoatCounter. | invisible; needed by 2–6 |
| 2 | `c3f04c1` | **Extension insights.** From the bot-maintained `deadline_history`: the share of closed calls whose deadline ended up later than first logged, and the median extension, per conference-year — "So far at NeurIPS 2026, 67% of workshop deadlines were extended (median 6 days, across 87 closed calls)". A per-series rule ("extended in 3 of the last 4 editions") is built in and activates by itself once earlier editions carry history (2027 onward). Gated on 10 closed calls; only closed deadlines count. `lib/extensions.mjs`. | any open-call workshop page, under the deadline; each conference hub's statline and a new FAQ entry |
| 3 | `c6fb6c5` | **Saved-page agenda ("What's next").** The starred workshops re-cut by UTC month: paper deadline, abstract stage, notification and workshop dates, plus the conference week from `data/editions.yml`. Live countdowns via the board's own clock. Warns when three or more deadlines fall within ten days. Hidden at zero stars. `site/src/scripts/planner.js`. | `/saved/` after starring a few workshops |
| 4 | `8da830f` | **Trends page.** One static inline-SVG chart of topic *share* per year (share, not count, because coverage grows every year) for the top eight topics, plus a table with counts and shares and footnotes on what the numbers cannot say. No client script; one accent hue at three opacities; theme-aware. `lib/trends.mjs`, `site/src/pages/trends.astro`. | `/trends/`, linked in the nav |
| 5 | `8d029f3` | **Time-zone explainer.** Every deadline is stored in UTC, so an "Anywhere on Earth" deadline reads 11:59 UTC the next morning, which is what hundreds of rows say. A collapsed "Why 11:59 UTC?" under the countdown explains it, with live UTC and AoE clocks side by side (`board.js` ticks them). | any open-call workshop page, under the countdown |
| 6 | `bac3912` | **"Surprise me".** One accepted paper at random from the page's own list or, on an upcoming edition with none yet, from the previous edition (linked to that paper's anchor). Never the same paper twice in a row. `lib/surprise.mjs`. | any workshop page with papers; the COLM 2026 LM4Sci page shows the previous-edition variant |

Every commit carries its own `scripts/*_test.mjs`, a `validate.yml` step,
browser assertions in `scripts/ui_test.mjs`, and a section in
`docs/ARCHITECTURE.md`. At the time of building: 56 standalone suites, the
Pagefind index test and 195 browser checks all pass on this branch.

One dependency: commit 2 creates `site/src/scripts/workshop-page.js`, which
commits 5 and 6 extend. Dropping 2 while keeping 5 or 6 needs a small rebase
so the file is created where it is first used.

## How to measure, if merged

GoatCounter cannot recognise returning visitors, so each feature sends an
event: `insight/extension`, `planner/rendered` (bucketed by star count),
`delight/aoe-open`, `delight/surprise`; the trends page is an ordinary
pageview. The one to watch is `planner/rendered` with two or more stars
growing week over week — that is people coming back to their list.

## How to look at it again

Locally is simplest:

```bash
git checkout engagement-preview
npm ci && npm ci --prefix site
npm run build --prefix site
npm run preview --prefix site        # http://localhost:4321
```

To show it to someone else, build with a base path and push `site/dist` to
any static host (a throwaway public repo with GitHub Pages from a `gh-pages`
branch works; the free plan needs the repo to be public):

```bash
SITE_URL=https://<owner>.github.io SITE_BASE=/<repo> \
  BUILD_ID=$(git rev-parse --short HEAD) npm run build --prefix site
printf 'User-agent: *\nDisallow: /\n' > site/dist/robots.txt   # keep it out of search engines
touch site/dist/.nojekyll                                        # so Pagefind's _pagefind/ is served
```

Leave `PUBLIC_GOATCOUNTER` and `PUBLIC_ALERTS_API` unset so a preview neither
pollutes analytics nor shows the email-alerts UI.

## How to keep a feature

```bash
git checkout main
git cherry-pick 3b2aebe            # the helper, first
git cherry-pick <feature commit>   # any of c3f04c1 c6fb6c5 8da830f 8d029f3 bac3912
npm test && npm run build --prefix site && node scripts/ui_test.mjs http://localhost:4321
```

Then push to `main` as usual; CI and the local suite are the gate.
