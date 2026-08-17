# Email alerts — operations runbook

Everything a maintainer needs to run, debug, or dismantle the optional email
alerts satellite. For *why* it is built this way, see the "Email alerts
(optional satellite)" section of [ARCHITECTURE.md](ARCHITECTURE.md); for the
original design decisions, [the original plan](plans/email-alerts.md).

The one-line summary: **the tracker does not depend on this.** Delete `alerts/`,
the two alerts workflows and the `PUBLIC_ALERTS_API` build variable, and the
site is exactly what it was.

## Current deployment

Provisioned 2026-08-14, moved to the account that owns the domain 2026-08-17.
None of these are secrets — the Turnstile *site* key and the Worker URL are both
public by design, and a D1 database id is useless without an account credential.

| | |
|---|---|
| Worker | `aiwt-alerts` → `https://api.aiworkshoptracker.com` |
| D1 database | `aiwt-alerts` (region WNAM), id in `alerts/worker/wrangler.toml` |
| Turnstile widget | `aiworkshoptracker-alerts`, managed mode, hosts `aiworkshoptracker.com` + `localhost` |
| Turnstile site key | `0x4AAAAAAESHV3-Jgf08N7Z8` |

Worker secrets set: `HMAC_SECRET`, `ADMIN_TOKEN`, `TURNSTILE_SECRET`,
`RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`. Until all five exist, `sendEmail()`
returns a failure for every message and no mail leaves the Worker.

### Why the Worker must not live on `workers.dev`

It did until 2026-08-17, in a second Cloudflare account that held no zones, and
mail to a national lab silently disappeared. A controlled comparison found the
cause — the sender was never the problem:

| Message | Its one link points at | Delivered to `@llnl.gov` |
|---|---|---|
| Weekly digest | `aiworkshoptracker.com` | yes |
| Sign-in link | `aiworkshoptracker.com/saved/#t=` | yes |
| Confirmation | `aiwt-alerts…workers.dev/confirm?token=` | **no** |

Same sender, same minute, SPF/DKIM/DMARC all passing, and Resend reporting
"Delivered" — the recipient's gateway accepted the message at SMTP time and
quarantined it afterwards. Gmail, a `.edu` and a `163.com` address took all
three. What set the confirmation apart is that its sole call to action was an
opaque-token link on a free hosting subdomain, which is the exact shape of a
credential-phishing message.

This is not confined to confirmations: unsubscribe links and the
`List-Unsubscribe` header carry the same origin, so the API's hostname is part
of the deliverability of *every* message.

A Worker custom domain requires the zone in the same account, which is why the
Worker now lives beside `aiworkshoptracker.com` rather than the zone moving to
it. `workers_dev = false` in `wrangler.toml` keeps the old hostname from being
republished by accident. **Do not re-enable it**, and if the Worker is ever
recreated, attach the custom domain before sending any mail.

To redo the move, see [Moving to another Cloudflare account](#moving-to-another-cloudflare-account).

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

```bash
npx wrangler d1 execute aiwt-alerts --remote \
  --command "ALTER TABLE subscribers ADD COLUMN tz TEXT"
```

Applied so far: `subscribers.scope` and `subscribers.tz` (both 2026-08-15).
Each is safe to run ahead of the deploy — `scope` defaults to the previous
behaviour, and a NULL `tz` renders as UTC, which is what every row got before
the column existed.

### Times in emails

Email cannot run JavaScript, so a subscriber's local time has to be baked in at
send. `subscribers.tz` holds an IANA zone name (`America/Los_Angeles`) captured
from their browser, and `fmtWhen()` renders `16 Sep 2026, 16:59 PDT (23:59 UTC)`.
With no zone stored it falls back to UTC only.

The **name** is stored rather than an offset so each deadline resolves its own
DST — an offset captured in July would be an hour wrong for a January deadline.

It stays current on its own: `/me` returns the stored zone, and the reconcile in
`favorites.js` runs on every page load from a linked device, sending one
`/update` when the browser disagrees. Someone who moves is corrected on their
next visit. `/update` is a partial update, so that call carries only `tz` and
leaves every preference untouched. The manage page displays the zone in use, so
a wrong time is diagnosable rather than mysterious.

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

## Signing in, and where each link goes

`site/src/scripts/alerts-session.js` is the **only** place that reads a `#t=`
fragment and writes the sign-in token. It is loaded on every page when the
feature is configured, so any page can be a landing page — which is what lets a
sign-in link point at the saved list rather than a settings form. It exchanges a
one-shot `magic` token for the durable `manage` one, clears the fragment before
any network call, unlinks on a 401, and then reconciles the saved list.

Two link types that must not converge:

| Link | Token | Lands on |
|---|---|---|
| Sign-in link (`/magic-link`, and re-subscribing an existing address) | `magic`, 15 min, single use | `/saved/` |
| "Manage preferences" in a digest footer | `manage`, nonce-bound | `/alerts/manage/` |

`scripts/alerts_session_test.mjs` pins both, and pins that no second module
writes the token. That is a structural check rather than a behavioural one: the
saved-list merge once existed in two places, the fix went to one, and the other
silently kept the old behaviour. A second copy is the failure mode worth a test.

Every page's signup block hides itself once the browser is linked and shows
"Alerts on for … · your saved list · manage" instead, so a signed-in visitor is
never shown a signup offer.

## What a subscription can express

Two independent axes. `scope` is *what* you hear about; `cadence` is *when*.

| `scope` | Covers |
|---|---|
| `all` (default) | The conference/topic filters — empty means everything — **plus** anything the subscriber saved, whatever the filters say |
| `starred` | Only saved workshops. Exists because empty filters mean "everything", so there was otherwise no way to ask for nothing-but-my-saved-list |

Three **independent** notifications, any combination:

| Notification | Sends |
|---|---|
| `weekly` | The Monday digest |
| `urgent` | A saved workshop's deadline is within 72 h |
| `changes` | Same-day, when a saved workshop's deadline moves |

They were a single-choice `cadence`, which forced artificial combinations and
mislabelled one of them — `starred_changes` also sent the 72 h alert while its
label said "only when a deadline changes". Independent flags make every
combination reachable and each honestly named.

**Encoding.** The `cadence` column now stores a canonical comma-joined subset
(`weekly,urgent`), or `off` when nothing is enabled — so this needed no
migration. The four historical values are still parsed on read, forever:

| Legacy value | Parses to |
|---|---|
| `weekly` | weekly |
| `weekly_urgent` | weekly + urgent |
| `starred_changes` | urgent + changes (what it always did) |
| `off` | nothing |

Turning everything off *is* pausing; there is no separate paused state, and
`isMailable()` is "confirmed, not suppressed, at least one notification on".
`/subscribe` rejects an empty set (`no_notifications`) — confirming by email and
then never hearing anything is worse than an error — while `/update` accepts it
as pause. Paused rows always store `off`, so `/admin/subscribers`' `cadence !=
'off'` filter still holds.

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

## How many people are subscribed

```bash
node scripts/alerts_stats.mjs          # counts only, never an address
node scripts/alerts_stats.mjs --days 7 # signups in a shorter window
```

Aggregates only: totals, how many are confirmed vs awaiting confirmation vs
suppressed vs paused, which notifications they picked, and a per-day signup
sparkline. It reads D1 directly through wrangler rather than `/admin/subscribers`,
because that endpoint deliberately returns only *mailable* rows — it exists to
feed the digest — so it cannot see people who are pending, paused or suppressed,
which is most of what you want when asking whether signup is working.

**MAILABLE** is the number that matters: confirmed, not suppressed, not paused.
It is also the number to watch against Resend's free tier (100/day), since the
weekly digest sends one message per subscriber with something to report.

Two other views, neither of which needs this repo:

- **Resend dashboard** — delivery, bounces, complaints, and how close the daily
  send limit is. The authoritative source for anything about delivery.
- **GoatCounter**, if enabled — page views for `/alerts/`, which is the top of
  the funnel that `alerts_stats.mjs` shows the bottom of.

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

## Moving to another Cloudflare account

Done once, on 2026-08-17, for the reason in
[Why the Worker must not live on `workers.dev`](#why-the-worker-must-not-live-on-workersdev).
Order matters: the old Worker keeps serving throughout, so the only visible
moment is step 7.

1. **Export D1.** `npx wrangler d1 export aiwt-alerts --remote --output=full.sql`
   from the old account.
2. **Split the `kv` snapshot out of the dump.** A single row holds ~450KB of
   projected feed, and importing it fails with `SQLITE_TOOBIG` — D1 caps the
   size of one statement, not of the database. Strip lines matching
   `INSERT INTO "kv"` (wrangler quotes the table name) into a separate file and
   import the remainder.
3. **In the new account:** create the D1, apply `schema.sql`, import the
   stripped dump, and paste the new `database_id` into `wrangler.toml`. Confirm
   it took — a stale id silently writes to the *old* database and everything
   looks fine until it doesn't.
4. **Create a Turnstile widget** there. Site keys are account-scoped; the old
   one fails validation against the new secret, and the failure surfaces to
   users as "the anti-spam check didn't pass".
5. **Set all five secrets.** `HMAC_SECRET` cannot be read back out of a Worker,
   so it is necessarily new — see the warning below. `RESEND_WEBHOOK_SECRET` is
   also new, because a Resend webhook URL is immutable and the endpoint has to
   be deleted and recreated.
6. **Deploy with the custom domain attached** (`workers_dev = false` plus the
   `[[routes]]` block), then restore the snapshot through
   `PUT /admin/kv/snapshot` — the admin API has no statement-size limit. Skip
   this and the next run re-seeds silently, missing a day of deadline changes.
7. **Switch the site over**: repo *variables* `ALERTS_API` and
   `TURNSTILE_SITE_KEY`, repo *secrets* `ALERTS_API_BASE`, `ALERTS_ADMIN_TOKEN`,
   `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. The two variables are baked
   in at build time, so this needs a deploy, not just a settings change.
8. **Repoint the Resend webhook** at the new origin.
9. Verify, then delete the old Worker and D1.

> **A new `HMAC_SECRET` invalidates every token in circulation.** Linked devices
> sign out, and unsubscribe links in already-delivered mail stop working. The
> second is the one that matters: a dead unsubscribe link earns spam
> complaints. With a small list, re-sending is cheap insurance; with a large
> one, carry the old secret over as a verify-only fallback first.

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
