# AI Workshop Tracker

**Live at [aiworkshoptracker.com](https://aiworkshoptracker.com)**

A static website that aggregates **ML conference workshop** information in one place:

- 📅 **Upcoming submission deadlines** for COLM, CVPR, CoRL, ICLR, ICML, ICRA, IROS, and NeurIPS workshops — with live countdowns and AoE → local-time conversion; the board shows open calls only — paginated 25 per page with the same numbered pager as search results — with everything else reachable through search (subscribable `.ics` calendar feeds exist but are paused until dates are verified; see `CALENDAR_ENABLED`)
- 🔎 **One unified, faceted search** across every workshop edition and 20k+ accepted-paper titles, filterable by conference, status, year, and topic — fully static (Pagefind), so it runs entirely in the browser with no search server
- ⭐ **Save workshops and papers** to a personal list, stored in your own browser (no account, no sign-in)
- 📄 **Auto-generated accepted-paper listings** for OpenReview-hosted workshops on each workshop's page

Conference deadline trackers exist; *workshop* deadlines never had one. This fills that gap. Ships with 660+ real workshop editions (2024–2026, across all eight conferences) and 20,000+ accepted-paper titles imported from OpenReview venue records. (CVPR workshops use OpenReview for reviewing only — their accepted papers live on CVF Open Access, so those entries track deadlines and links rather than inline paper lists.)

## How it works

```
GitHub repo (single source of truth)
 ├── data/workshops/*.yml      one YAML file per workshop edition (community-edited)
 ├── data/conferences.yml      conference metadata
 ├── data/editions.yml         per-edition conference dates (drives "Past" for deadline-unknown entries)
 ├── data/topics.yml           controlled topic vocabulary
 ├── cache/openreview/*.json   committed paper-list caches (fetched monthly)
 ├── lib/                      shared date/AoE, data-loading, and ICS code
 ├── scripts/                  validation, OpenReview fetcher, automation helpers
 ├── site/                     Astro static site (reads ../data at build time)
 └── .github/workflows/        CI validation + scheduled automation
```

The guiding principle is **zero hosting cost and near-zero maintenance**: the Git
repo is the only source of truth, the site is fully static (no backend, no
database), accepted-paper lists are cached from OpenReview by a scheduled job,
and deadline statuses are derived at build time rather than stored. Contributions
are validated by CI, not by hand.

For the reasoning behind these choices and the behavior details that matter when
modifying the site (search semantics, the deploy-resilient search engine,
favorites storage, link handling), see **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Quickstart (local)

Requires Node 20+.

```bash
npm ci                         # root deps (validation/scripts)
npm ci --prefix site           # site deps (Astro, Pagefind)

node scripts/validate.mjs      # validate all workshop data
npm run dev --prefix site      # dev server at localhost:4321 (search needs a full build)
npm run build --prefix site    # full build incl. search index -> site/dist
```

## Deploying (pick one)

### Option A — GitHub Pages (zero config beyond one click)

1. Push this repo to GitHub.
2. Repo **Settings → Pages → Source: "GitHub Actions"**.
3. Done. `.github/workflows/deploy.yml` builds on every push to `main`, weekly, and on demand. This repo serves at the custom domain `aiworkshoptracker.com` (configured in Settings → Pages → Custom domain; DNS A records point the apex at GitHub Pages). The `<owner>.github.io/<repo>` URL redirects there automatically.

Forking without the custom domain? In `deploy.yml`, set `SITE_URL` to `https://<owner>.github.io` and `SITE_BASE` to `/<repo-name>`.

### Option B — Cloudflare Pages (unlimited bandwidth, also free)

1. Cloudflare dashboard → Workers & Pages → **Create → Pages → Connect to Git**.
2. Build settings:
   - **Build command:** `npm ci && npm ci --prefix site && npm run build --prefix site`
   - **Build output directory:** `site/dist`
   - **Environment variables:** `SITE_URL=https://<your-project>.pages.dev` (and `PUBLIC_REPO_URL=https://github.com/<you>/<repo>`)
3. Optionally delete `deploy.yml` (Cloudflare builds on push by itself) — but keep the weekly rebuild by leaving it and pointing it at Cloudflare's [deploy hook](https://developers.cloudflare.com/pages/configuration/deploy-hooks/), or simply keep GitHub Pages as a mirror.

### Environment variables

| Var | Used by | Meaning | Default |
|---|---|---|---|
| `SITE_URL` | site build | Canonical origin (sitemap, RSS, OG tags) | `https://ai-workshop-tracker.pages.dev` |
| `SITE_BASE` | site build | Path prefix for GitHub *project* pages | `/` |
| `PUBLIC_REPO_URL` | site build | "Edit"/"Add a workshop" links | placeholder — **set this** |
| `PUBLIC_GOATCOUNTER` | site build | Enables [GoatCounter](https://www.goatcounter.com) analytics (set to your site code; repo Action variable `GOATCOUNTER_CODE` — currently enabled as `aiworkshoptracker`) | off |
| `PUBLIC_CF_ANALYTICS_TOKEN` | site build | Enables Cloudflare Web Analytics (repo Action variable `CF_ANALYTICS_TOKEN`) | off |

## Licensing & contributor terms

Free, open source, ad-free.
Contributions are governed by lightweight [contributor terms](CONTRIBUTOR_TERMS.md): MIT for code,
CC-BY-4.0 for data, DCO certification, no CLA — and the data stays open, permanently.

## Automation

**Adding a conference** takes ~10 minutes end to end: `skills/add-conference/`
documents the full procedure (feasibility probe → `node scripts/add_conference.mjs`
to wire all touchpoints → import → verify → ship), with a bundled OpenReview
probe script. The same folder zips into a Claude skill for use in fresh sessions.

**Publishing is zero-touch for OpenReview data.** The weekly discovery job and the
monthly paper refresh validate their changes and, on success, commit straight to
`main` and trigger a deploy — newly announced workshops appear on the site with no
human action. If validation fails, nothing is committed and GitHub emails the repo
owner (that email is the alert channel). Community submissions via the issue form
still arrive as pull requests for human review, as do dependency updates. reference

| Workflow | Trigger | What it does |
|---|---|---|
| `validate.yml` | PRs & pushes touching data | Schema + sanity checks; comments fixes on the PR |
| `deploy.yml` | push to `main`, weekly, manual | Build & deploy (weekly run refreshes derived statuses) |
| `openreview-refresh.yml` | monthly | Re-fetch paper caches for recent years → auto-PR on diff |
| `issue-to-pr.yml` | "Add a workshop" issue form | Converts the form to a YAML file + PR, validates, reports back |
| `stale-check.yml` | weekly | One consolidated issue listing entries needing follow-up |
| `link-check.yml` | monthly | One consolidated issue listing broken URLs |

The maintainer's whole job: review PRs and skim two auto-updated "Data health" issues. (~1–2 h/week in deadline season, ~0 otherwise.)

## Adding / fixing workshops

See [CONTRIBUTING.md](CONTRIBUTING.md). Short version: use the **"Add a workshop" issue form** (no Git needed — a bot opens the PR), or copy `data/workshops/_template.yml` and open a PR yourself. Every page on the site has a ✎ Edit link.

### Bulk-importing real workshop lists

`scripts/discover_openreview.mjs` enumerates every workshop venue for a conference-year straight from OpenReview and creates an entry per venue — official title, acronym, website, and the **real submission deadline**, taken from the venue's date line or, when that is blank, from the submission invitation's machine-readable `duedate` (expired invitations included; nothing is estimated). Venues with no published deadline anywhere get an in-file comment template, and their pages show a "know the deadline? Add it in one line" link that drops contributors straight onto it:

```bash
node scripts/discover_openreview.mjs --conf neurips --year 2026
```

Run it when a conference announces its accepted workshop list (NeurIPS announces ~July, ICLR ~January, ICML ~March). The repo ships with all of 2024-2026 imported (~330 editions). To populate accepted-paper caches for them, run `node scripts/fetch_openreview.mjs` (fetches everything missing; the monthly workflow keeps recent years fresh).

## Data & API

- Machine-readable dump: `/api/workshops.json` (regenerated on every deploy)
- Forum ids of papers with no PDF (supports saved-paper PDF links): `/api/papers-without-pdf.json`
- New-workshop announcements: `/rss.xml`
- Calendar feeds (paused — see `CALENDAR_ENABLED`): `/feeds/all.ics`, `/feeds/<conference>.ics`, `/feeds/topic-<id>.ics`, `/feeds/ws-<slug>.ics`

## Licensing

- **Code:** MIT (see `LICENSE`)
- **Data** (`data/`, `cache/`): [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) — reuse freely with attribution

## Scope (deliberately) excluded

No accounts, no backend, no email alerts, no scraping of non-OpenReview portals, no LLM pipelines, no PDF rehosting. These are the things that make trackers expensive to run and easy to abandon.
