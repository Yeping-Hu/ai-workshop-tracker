# AI Workshop Tracker

**Live at [aiworkshoptracker.com](https://aiworkshoptracker.com)**

A static website that aggregates **AI/ML/Robotics conference workshop** information in one place:

- 📅 **Upcoming submission deadlines** for COLM, CVPR, CoRL, ECCV, ICLR, ICML, ICRA, IROS, and NeurIPS workshops, with live countdowns and AoE → local-time conversion; the board shows open calls, and everything else is reachable through search
- 🔎 **One unified, faceted search** across every workshop edition and 20k+ accepted-paper titles, filterable by conference, status, year, and topic — fully static (Pagefind), so it runs entirely in the browser with no search server
- ⭐ **Save workshops and papers** to a personal list, stored in your own browser (no account, no sign-in)
- 📄 **Auto-generated accepted-paper listings** for OpenReview-hosted workshops on each workshop's page

Conference deadline trackers exist; *workshop* deadlines never had one. This fills that gap. Ships with 750+ real workshop editions (2024–2026, across all nine conferences) and 20,000+ accepted-paper titles imported from OpenReview venue records.

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

## Deploying

The site is a static build (`site/dist`) and hosts anywhere that serves static
files. Two zero-cost options — GitHub Pages or Cloudflare Pages — plus the
environment-variable reference are in **[docs/DEPLOYING.md](docs/DEPLOYING.md)**.

## Adding / fixing workshops

See [CONTRIBUTING.md](CONTRIBUTING.md). Short version: use the **"Add a workshop" issue form** (no Git needed — a bot opens the PR), or copy `data/workshops/_template.yml` and open a PR yourself. Every workshop page has a ✎ Edit link that opens a short, timezone-safe form.

## Automation

Scheduled GitHub Actions keep the data fresh with near-zero maintenance: a weekly
OpenReview discovery job, a daily imminent-deadline re-check, and a monthly paper
refresh each validate their changes and commit straight to `main`, while
issue-form submissions arrive as pull requests for review. The full workflow
list, the "add a conference" procedure, and bulk-importing workshop lists are in
**[docs/AUTOMATION.md](docs/AUTOMATION.md)**.

## Data & API

- Machine-readable dump: `/api/workshops.json` (regenerated on every deploy)
- Forum ids of papers with no PDF (supports saved-paper PDF links): `/api/papers-without-pdf.json`
- New-workshop announcements: `/rss.xml`
- Calendar feeds (paused — see `CALENDAR_ENABLED`): `/feeds/all.ics`, `/feeds/<conference>.ics`, `/feeds/topic-<id>.ics`, `/feeds/ws-<slug>.ics`

## Licensing & contributor terms

Free, open source, ad-free.

- **Code:** MIT (see `LICENSE`)
- **Data** (`data/`, `cache/`): [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) — reuse freely with attribution

Contributions are governed by lightweight [contributor terms](CONTRIBUTOR_TERMS.md): DCO certification, no CLA — and the data stays open, permanently.

## Scope (deliberately) excluded

No accounts, no backend, no email alerts, no scraping of non-OpenReview portals, no LLM pipelines, no PDF rehosting. These are the things that make trackers expensive to run and easy to abandon.
