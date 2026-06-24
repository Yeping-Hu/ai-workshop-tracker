# Deploying

The site is a static Astro build (`site/dist`), so it hosts anywhere that serves
static files. For local development and the build command, see the
[Quickstart](../README.md#quickstart-local) in the README. Two zero-cost options:

## Option A — GitHub Pages (zero config beyond one click)

1. Push this repo to GitHub.
2. Repo **Settings → Pages → Source: "GitHub Actions"**.
3. Done. `.github/workflows/deploy.yml` builds on every push to `main`, weekly, and on demand. This repo serves at the custom domain `aiworkshoptracker.com` (configured in Settings → Pages → Custom domain; DNS A records point the apex at GitHub Pages). The `<owner>.github.io/<repo>` URL redirects there automatically.

Forking without the custom domain? In `deploy.yml`, set `SITE_URL` to `https://<owner>.github.io` and `SITE_BASE` to `/<repo-name>`.

## Option B — Cloudflare Pages (unlimited bandwidth, also free)

1. Cloudflare dashboard → Workers & Pages → **Create → Pages → Connect to Git**.
2. Build settings:
   - **Build command:** `npm ci && npm ci --prefix site && npm run build --prefix site`
   - **Build output directory:** `site/dist`
   - **Environment variables:** `SITE_URL=https://<your-project>.pages.dev` (and `PUBLIC_REPO_URL=https://github.com/<you>/<repo>`)
3. Optionally delete `deploy.yml` (Cloudflare builds on push by itself) — but keep the weekly rebuild by leaving it and pointing it at Cloudflare's [deploy hook](https://developers.cloudflare.com/pages/configuration/deploy-hooks/), or simply keep GitHub Pages as a mirror.

## Environment variables

| Var | Used by | Meaning | Default |
|---|---|---|---|
| `SITE_URL` | site build | Canonical origin (sitemap, RSS, OG tags) | `https://ai-workshop-tracker.pages.dev` |
| `SITE_BASE` | site build | Path prefix for GitHub *project* pages | `/` |
| `PUBLIC_REPO_URL` | site build | "Edit"/"Add a workshop" links | placeholder — **set this** |
| `PUBLIC_GOATCOUNTER` | site build | Enables [GoatCounter](https://www.goatcounter.com) analytics (set to your site code; repo Action variable `GOATCOUNTER_CODE` — currently enabled as `aiworkshoptracker`) | off |
| `PUBLIC_CF_ANALYTICS_TOKEN` | site build | Enables Cloudflare Web Analytics (repo Action variable `CF_ANALYTICS_TOKEN`) | off |
