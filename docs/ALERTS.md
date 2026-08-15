# Email alerts — operations runbook

Everything a maintainer needs to run, debug, or dismantle the optional email
alerts satellite. For *why* it is built this way, see the "Email alerts
(optional satellite)" section of [ARCHITECTURE.md](ARCHITECTURE.md); for the
original design decisions, [the original plan](plans/email-alerts.md).

The one-line summary: **the tracker does not depend on this.** Delete `alerts/`,
the two alerts workflows and the `PUBLIC_ALERTS_API` build variable, and the
site is exactly what it was.

## Current deployment

Provisioned 2026-08-14. None of these are secrets — the Turnstile *site* key and
the Worker URL are both public by design, and a D1 database id is useless
without an account credential.

| | |
|---|---|
| Worker | `aiwt-alerts` → `https://aiwt-alerts.aiwt-alerts-worker.workers.dev` |
| D1 database | `aiwt-alerts` (region WNAM), id in `alerts/worker/wrangler.toml` |
| Turnstile widget | `aiworkshoptracker-alerts`, managed mode, hosts `aiworkshoptracker.com` + `localhost` |
| Turnstile site key | `0x4AAAAAAEQVcjRzfH9U80a9` |

Worker secrets set: `HMAC_SECRET`, `ADMIN_TOKEN`, `TURNSTILE_SECRET`.
Still to set once Resend is configured: `RESEND_API_KEY`,
`RESEND_WEBHOOK_SECRET`. Until they exist, `sendEmail()` returns a failure for
every message and no mail leaves the Worker.

**The DNS zone is in a different Cloudflare account from the Worker.** The
Workers account above holds no zones, while `aiworkshoptracker.com` is served by
Cloudflare nameservers under another login. Two things follow:

- A Worker **custom domain requires the zone in the same account**, so
  `api.aiworkshoptracker.com` cannot be attached to this Worker as things
  stand. Either move the zone into the Workers account (Cloudflare supports
  transferring a zone between accounts), or stay on the `workers.dev` URL,
  which works fine and is what the deployment uses.
- **All mail DNS is added in the other login.** Resend does not care which
  provider hosts the records.

Verify the mail records before asking a provider to verify the domain:

```bash
node scripts/alerts_dns_check.mjs
```

It resolves against 1.1.1.1/8.8.8.8 rather than the local cache, and looks
specifically for the doubled-suffix mistake — Cloudflare appends the zone to
whatever you type, so pasting `send.mail.aiworkshoptracker.com` creates
`send.mail.aiworkshoptracker.com.aiworkshoptracker.com` and the provider just
reports "unverified".

## What exists

| Piece | Where | Notes |
|---|---|---|
| Shared logic | `alerts/{config,tokens,match,diff,render}.mjs` | Pure, dependency-free, runs in both the Worker and Node |
| Id allowlist | `alerts/ids.json` | Generated — `node scripts/gen_alerts_ids.mjs` |
| Worker | `alerts/worker/` | Cloudflare Worker `aiwt-alerts` + D1 database `aiwt-alerts` |
| Pipeline | `scripts/alerts_run.mjs` | Run daily by `.github/workflows/alerts.yml` |
| Site UI | `site/src/components/AlertsSignup.astro`, `site/src/pages/alerts/` | All hidden when `PUBLIC_ALERTS_API` is empty |
| Tests | `scripts/alerts_*_test.mjs` | Run by `.github/workflows/alerts-ci.yml` |

## First-time setup

Do these in order. Steps 1–3 are Cloudflare/Resend account work; nothing in the
repo needs editing except `database_id`.

1. **D1 + Worker**

   ```bash
   cd alerts/worker
   npx wrangler d1 create aiwt-alerts          # paste the id into wrangler.toml
   npx wrangler d1 execute aiwt-alerts --remote --file=./schema.sql
   ```

2. **Secrets** (all `npx wrangler secret put <NAME>` from `alerts/worker/`)

   | Secret | Value |
   |---|---|
   | `HMAC_SECRET` | 32+ random bytes, hex — `openssl rand -hex 32` |
   | `ADMIN_TOKEN` | random; the same value goes in the repo secret `ALERTS_ADMIN_TOKEN` |
   | `TURNSTILE_SECRET` | from the Turnstile widget |
   | `RESEND_API_KEY` | from Resend |
   | `RESEND_WEBHOOK_SECRET` | from the Resend webhook (`whsec_…`) |

3. **Domain + mail.** Verify `mail.aiworkshoptracker.com` in Resend and publish
   the DKIM/SPF/return-path records it gives you, plus a DMARC TXT starting at
   `p=none; rua=mailto:…`. Point a Resend webhook at
   `https://<worker-host>/webhooks/resend`. Sending from the subdomain keeps the
   apex domain's reputation clear of anything the alerts do.

4. **Repo secrets:** `ALERTS_API_BASE` (the Worker's URL, no trailing slash),
   `ALERTS_ADMIN_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

5. **Build variables** in the site's build environment: `PUBLIC_ALERTS_API` and
   `PUBLIC_TURNSTILE_SITE_KEY`. Until these are set, the site builds with no
   alerts UI at all — which is the correct state for a fork.

6. **Postal address.** CAN-SPAM wants a physical address in bulk mail. Set
   `POSTAL_ADDRESS` in `alerts/render.mjs` to a PO box or registered-agent
   address (**not** a home address). The footer omits the line while it is empty.

7. **Deploy:** push to `main` (the deploy workflow fires on `alerts/**`) or
   `npx wrangler deploy` from `alerts/worker/`.

### Schema migrations

`schema.sql` uses `CREATE TABLE IF NOT EXISTS`, which will **not** add a column
to a database that already exists. A new column needs an explicit `ALTER TABLE`
against the live database *before* deploying a Worker that selects it:

```bash
npx wrangler d1 execute aiwt-alerts --remote \
  --command "ALTER TABLE subscribers ADD COLUMN scope TEXT NOT NULL DEFAULT 'all'"
```

Applied so far: `subscribers.scope` (2026-08-15). Its default reproduces the
previous behaviour, so the migration is safe to run ahead of the deploy.

## Local development

`wrangler dev --env dev` from `alerts/worker/` runs the Worker locally; the
`dev` environment sets `DEV=1`, which is what lets `http://localhost:4321` (the
Astro dev server) through the CORS allowlist. Point the site at it with
`PUBLIC_ALERTS_API=http://127.0.0.1:8787`.

**Turnstile is fail-closed**, deliberately: with no `TURNSTILE_SECRET` set, the
Worker refuses every `/subscribe` and `/magic-link` request rather than becoming
an open relay that mails confirmation links to arbitrary addresses. So a local
Worker with no secret cannot complete a signup at all.

For local work and automated tests, use Cloudflare's published **Turnstile
dummy sitekeys and secret keys** — there are variants that always pass, always
fail, and always report a duplicate token, and they work on any domain including
`localhost`. The current values are on Cloudflare's own page and are not
reproduced here so they cannot go stale:

> <https://developers.cloudflare.com/turnstile/troubleshooting/testing/>

Set the always-passes secret with `wrangler secret put TURNSTILE_SECRET` (or in
`.dev.vars`, which is gitignored) and the matching sitekey as
`PUBLIC_TURNSTILE_SITE_KEY` in the site build. Never use a dummy key in
production: it passes everything, which is exactly the open relay the
fail-closed behavior exists to prevent.

## What a subscription can express

Two independent axes. `scope` is *what* you hear about; `cadence` is *when*.

| `scope` | Covers |
|---|---|
| `all` (default) | The conference/topic filters — empty means everything — **plus** anything the subscriber saved, whatever the filters say |
| `starred` | Only saved workshops. Exists because empty filters mean "everything", so there was otherwise no way to ask for nothing-but-my-saved-list |

| `cadence` | Sends |
|---|---|
| `weekly` (default) | The Monday digest |
| `weekly_urgent` | The digest, plus an alert when a saved deadline is within 72 h |
| `starred_changes` | **No digest.** Same-day mail when a saved workshop's deadline moves, plus the 72 h alert |
| `off` | Nothing; preferences and saved list are kept |

Saved workshops are always included under `scope: 'all'` — that is
`matchesSubscriber`'s starred bypass, not something the subscriber configures.

Same-day change mail is deduped through `urgent_log` on the event's new
deadline value, under a `chg:` slug prefix so it cannot collide with the 72 h
alert's rows. Running the pipeline twice in one day therefore sends once.

## Daily operation

`alerts.yml` runs at 06:30 UTC, 73 minutes after `deploy.yml`'s 05:17 rebuild —
the offset exists so the diff always reads *today's* `workshops.json`. **If
deploy.yml's cron moves, move this one too.**

Each run: fetch the feed → diff against the stored snapshot → record events →
urgent pass → weekly pass (Mondays only) → maintenance. A failure fails the job
loudly; GitHub's failure email is the alert channel, as with every other job here.

**Dry run any time:** Actions → *Email alerts* → Run workflow. `dry_run` defaults
to true on manual runs; add `force_weekly` to exercise the digest off-Monday. A
dry run renders everything and prints subjects and counts, but sends nothing,
writes no snapshot, and logs no urgents.

### Reading the log

Logs carry counts, slugs and subjects — **never** an address or a message body,
because a public repo has public logs. Normal output looks like:

```
1. feed: 757 workshops (generated 2026-08-14T05:30:00.000Z)
2. diff: 3 event(s) {"extended":1,"deadline_announced":1,"announced":1}
3. subscribers: 214 mailable
4. urgent: 2 sent, 0 failed (5 already sent earlier)
5. weekly: 118 sent, 0 failed, 96 skipped (empty)
```

"Skipped (empty)" is the normal majority on a quiet week — a subscriber with
nothing to report gets no email at all.

## Things that go wrong

### "shrink guard: live dataset shrank to N from M"

The job aborted before writing anything, because the feed came back much smaller
than the stored snapshot. Almost always a bad deploy or a truncated fetch, not
200 deleted workshops.

1. Open `https://aiworkshoptracker.com/api/workshops.json` and check `count`.
2. If the feed is genuinely wrong, fix the site build; the next run recovers on
   its own — no state was touched.
3. If the dataset really did shrink that much (a mass deletion you intended),
   re-run after the next successful deploy; the guard is a ratio, so it clears
   once the snapshot catches up. Do **not** lower `SNAPSHOT_SHRINK_GUARD` to get
   past one incident.

### The first run announced nothing

Correct. With no snapshot, everything looks new, so the first run seeds silently
and sends on the *second* run. Same after a snapshot is deliberately cleared.

### A subscriber says they got nothing

In order of likelihood: their digest was empty (quiet week — by design); they
never confirmed (unconfirmed rows are deleted after 48 h); a hard bounce set
`suppressed_at`; or they paused (`cadence='off'`). Check with:

```bash
npx wrangler d1 execute aiwt-alerts --remote \
  --command "SELECT confirmed_at, suppressed_at, cadence FROM subscribers WHERE email='…'"
```

### Duplicate urgent alerts

`urgent_log` is keyed `(email, slug, deadline_utc)`, so the same deadline value
can only alert once — an *extension* changes the value and deliberately re-arms
it. Two alerts for the same workshop within days is usually two real deadline
values, not a bug.

## Manual operations

**Delete one subscriber** (a support request, or a GDPR erasure by hand):

```bash
npx wrangler d1 execute aiwt-alerts --remote \
  --command "DELETE FROM subscribers WHERE email='…'; DELETE FROM urgent_log WHERE email='…'"
```

The self-service path is the manage page's "Unsubscribe & delete my data", and
every email's one-click unsubscribe does the same thing. There is no deactivated
state — unsubscribing is a `DELETE`.

**Rotate a secret.** `wrangler secret put <NAME>` and redeploy.

- `HMAC_SECRET` invalidates **every** outstanding token: confirmation links,
  sign-in links, unsubscribe links in already-delivered mail, and every linked
  device. Subscriptions survive; people re-link with a fresh sign-in link. Only
  do this on a suspected compromise.
- `ADMIN_TOKEN` must be changed in the Worker and in the repo secret
  `ALERTS_ADMIN_TOKEN` together, or the next pipeline run 401s.

**Revoke one person's tokens** without deleting them: rotate their nonce.

```bash
npx wrangler d1 execute aiwt-alerts --remote \
  --command "UPDATE subscribers SET nonce=lower(hex(randomblob(16))) WHERE email='…'"
```

**Reset the snapshot** (forces a silent re-seed on the next run):

```bash
npx wrangler d1 execute aiwt-alerts --remote --command "DELETE FROM kv WHERE k='snapshot'"
```

## The `events` table

Append-only, no PII: one row per dataset change we observed, with the same
"`observed` is when *we* noticed, not when organizers changed it" semantics as
`deadline_history` in the workshop YAML. It powers the weekly digest's "what
changed this week", and it is deliberately shaped to power a public `/changelog`
page later (see §12 of the plan). Rows older than 90 days are pruned by the
daily maintenance call.

## Growing past the free tier

Resend's free tier is **100 emails/day**. The weekly digest sends one message per
subscriber with something to report, so the practical ceiling is around 90
subscribers on a busy Monday. Before then, either upgrade Resend (~$20/mo) or
implement the SES adapter — `sendBatchSes()` in `alerts/worker/src/mail.mjs` is
the stub, and `sendBatch()` is the only function that needs repointing. SES needs
SigV4 signing (`aws4fetch` works in Workers) and a support ticket to leave the
sandbox, and has no true batch endpoint, so keep the "one result per message, in
order" contract or `urgent_log` will record sends that never happened.

`MAX_SUBSCRIBERS` (5000, in `alerts/config.mjs`) is a separate, much higher
backstop against a signup flood; it is not the provider limit.

## Removing the feature entirely

1. Unset `PUBLIC_ALERTS_API` and rebuild — every trace disappears from the site.
2. Delete `.github/workflows/alerts.yml`, `alerts-worker-deploy.yml`, `alerts-ci.yml`.
3. `npx wrangler delete` the Worker and drop the D1 database.
4. Delete `alerts/`, `scripts/alerts_*`, `scripts/gen_alerts_ids.mjs`,
   `site/src/components/AlertsSignup.astro`, `site/src/pages/alerts/`, and the
   sync block in `site/src/scripts/favorites.js`.

Nothing else references them. Saved lists in visitors' browsers keep working —
they never depended on the server.
