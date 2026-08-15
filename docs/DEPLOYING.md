# Deploying

The site is a static Astro build (`site/dist`), so it hosts anywhere that serves
static files. For local development and the build command, see the
[Quickstart](../README.md#quickstart-local) in the README. Two zero-cost options:

## Option A — GitHub Pages (zero config beyond one click)

1. Push this repo to GitHub.
2. Repo **Settings → Pages → Source: "GitHub Actions"**.
3. Done. `.github/workflows/deploy.yml` builds on every push to `main`, daily, and on demand. This repo serves at the custom domain `aiworkshoptracker.com` (configured in Settings → Pages → Custom domain; DNS A records point the apex at GitHub Pages). The `<owner>.github.io/<repo>` URL redirects there automatically.

Forking without the custom domain? In `deploy.yml`, set `SITE_URL` to `https://<owner>.github.io` and `SITE_BASE` to `/<repo-name>`.

## Option B — Cloudflare Pages (unlimited bandwidth, also free)

1. Cloudflare dashboard → Workers & Pages → **Create → Pages → Connect to Git**.
2. Build settings:
   - **Build command:** `npm ci && npm ci --prefix site && npm run build --prefix site`
   - **Build output directory:** `site/dist`
   - **Environment variables:** `SITE_URL=https://<your-project>.pages.dev` (and `PUBLIC_REPO_URL=https://github.com/<you>/<repo>`)
3. Optionally delete `deploy.yml` (Cloudflare builds on push by itself) — but keep the daily rebuild by leaving it and pointing it at Cloudflare's [deploy hook](https://developers.cloudflare.com/pages/configuration/deploy-hooks/), or simply keep GitHub Pages as a mirror.

## Environment variables

| Var | Used by | Meaning | Default |
|---|---|---|---|
| `SITE_URL` | site build | Canonical origin (sitemap, RSS, OG tags) | `https://ai-workshop-tracker.pages.dev` |
| `SITE_BASE` | site build | Path prefix for GitHub *project* pages | `/` |
| `PUBLIC_REPO_URL` | site build | "Edit"/"Add a workshop" links | placeholder — **set this** |
| `PUBLIC_GOATCOUNTER` | site build | Enables [GoatCounter](https://www.goatcounter.com) analytics (set to your site code; repo Action variable `GOATCOUNTER_CODE` — currently enabled as `aiworkshoptracker`) | off |
| `PUBLIC_CF_ANALYTICS_TOKEN` | site build | Enables Cloudflare Web Analytics (repo Action variable `CF_ANALYTICS_TOKEN`) | off |
| `PUBLIC_ALERTS_API` | site build | Base URL of the alerts Worker. **Empty ⇒ every email-alerts UI element is absent from the build** | off |
| `PUBLIC_TURNSTILE_SITE_KEY` | site build | Cloudflare Turnstile site key (public half) for the signup form | off |

Leave the last two unset unless you are running the optional email-alerts
satellite. A build without them is a complete, working tracker — which is what
every fork and PR preview gets.

## Optional: the email-alerts satellite

Only if you want the weekly digest and cross-device saved lists. It is a
separate Cloudflare Worker and D1 database that the site does not depend on;
[ALERTS.md](ALERTS.md) is the full runbook. In short:

```bash
cd alerts/worker
npx wrangler d1 create aiwt-alerts                                # paste the id into wrangler.toml
npx wrangler d1 execute aiwt-alerts --remote --file=./schema.sql
npx wrangler secret put HMAC_SECRET                               # openssl rand -hex 32
npx wrangler secret put ADMIN_TOKEN                               # also a repo secret
npx wrangler secret put TURNSTILE_SECRET
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put RESEND_WEBHOOK_SECRET
npx wrangler deploy
```

Then wire the build variables. On **GitHub Pages** the build runs in
`deploy.yml`, which reads them from repo *Variables* (Settings → Secrets and
variables → Actions → Variables), not Secrets — they are public values baked
into the HTML:

| Repo variable | Becomes | Value |
|---|---|---|
| `ALERTS_API` | `PUBLIC_ALERTS_API` | the Worker's URL, no trailing slash |
| `TURNSTILE_SITE_KEY` | `PUBLIC_TURNSTILE_SITE_KEY` | Turnstile's public site key |

On **Cloudflare Pages**, set `PUBLIC_ALERTS_API` and `PUBLIC_TURNSTILE_SITE_KEY`
directly as build environment variables instead.

Either way, add `ALERTS_API_BASE`, `ALERTS_ADMIN_TOKEN`, `CLOUDFLARE_API_TOKEN`
and `CLOUDFLARE_ACCOUNT_ID` as **repo Action secrets**.

### DNS

| Record | Purpose |
|---|---|
| `CNAME api` → the Worker (or use the `*.workers.dev` URL) | Where the browser and the Action talk to the Worker |
| DKIM `CNAME`s on `mail.<domain>` | Published by Resend when you verify the sending subdomain |
| SPF `TXT` on `mail.<domain>` | Resend's `include:` — the sending subdomain only |
| MX on `mail.<domain>` | Resend's return path (bounce handling) |
| DMARC `TXT` on `_dmarc.<domain>` | Start at `p=none; rua=mailto:you@…`, tighten later |

Mail is sent from a dedicated `mail.` subdomain so the apex domain's reputation
is never affected by anything the alerts do.
