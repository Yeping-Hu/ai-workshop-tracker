# Email Alerts & Cross-Device Saved Lists — Implementation Plan

**Repo:** `Yeping-Hu/ai-workshop-tracker` (aiworkshoptracker.com)
**Status:** Approved plan, ready to implement.
**Audience:** This document is written for a coding agent. Follow it as the source of truth. Where it says DECIDED, do not relitigate. Where it says HUMAN, stop and ask the maintainer — do not improvise credentials, DNS, or account setup.

---

## 0. Read these first

Before writing any code, read (in this order):

1. `README.md` — especially "How it works" and "Scope (deliberately) excluded"
2. `docs/ARCHITECTURE.md` — the zero-cost / near-zero-maintenance principle and the favorites section
3. `docs/AUTOMATION.md` — workflow conventions, the `data-write` concurrency group, "docs travel with the change"
4. `site/src/scripts/favorites.js` — localStorage keys, hydrate mechanism, `awt:favs-changed` event
5. `site/src/pages/api/workshops.json.ts` — the exact JSON shape the pipeline diffs
6. `lib/workshops.mjs` — `deriveDeadlineChange` (we mirror its `MIN_CHANGE_MS` threshold and "days" rounding)
7. `site/src/pages/index.astro` — how facet state lives in the URL (digest deep-links reuse it)
8. `.github/workflows/deploy.yml` — the daily deploy cron (the alerts cron must run after it)
9. `scripts/docs_sync_test.mjs` — whatever it pins must stay green after docs edits

Repo conventions to follow throughout: plain-JS ESM `.mjs` for anything outside `site/`, minimal dependencies, tests as standalone `scripts/*_test.mjs` files runnable with `node`, comments that explain *why*, and every behavior rule pinned by a test.

---

## 1. What we are building

An **optional email-alerts satellite** for the tracker:

1. **Personalized weekly digest.** Subscribers pick conferences and/or topics at signup. Every Monday they get one email containing, for their selection: deadline changes observed this week, newly announced workshops, calls closing in the next 7 days, and the next deadlines among their starred workshops. Empty weeks send nothing.
2. **Urgent alerts (opt-in cadence).** A daily check emails a subscriber when a workshop they **starred** has a deadline within 72 h (once per deadline value — an extension re-arms it).
3. **Cross-device saved lists.** The email address becomes the sync key for the existing localStorage favorites. No passwords: signed tokens + magic links. Starring stays fully functional (and local-only) for people who never subscribe.

### Explicit non-goals (do not build)

- No passwords, OAuth, profiles, or login walls. Email + signed token is the entire identity.
- No per-change instant emails except the urgent starred-deadline alert. Everything else batches weekly.
- No open-tracking pixels, no click-redirect tracking. All links are direct. (We accept not knowing open rates.)
- No paid tier, no billing code.
- No admin dashboard UI. Admin surface is API-only, used by the GitHub Action.
- No changes to existing data jobs, the search code, or the calendar-feed flag.
- **No PII ever enters the Git repo** — no emails in YAML, JSON caches, workflow logs, or commit messages. Workflow steps that handle subscriber data must not `echo` payloads.

### Architectural principle to preserve

The static site must keep working, unchanged, if the alerts system is deleted. The Worker is a strictly optional satellite that *reads* the site's public `/api/workshops.json`; the site gains one signup component and a few static pages that hide themselves when the feature is unconfigured (empty `PUBLIC_ALERTS_API`). Forks and PR preview builds must work with the feature absent.

---

## 2. Locked decisions

| # | Decision | Value (DECIDED) |
|---|---|---|
| D1 | Backend | One Cloudflare Worker + one D1 database. No other infra. |
| D2 | Identity | Email + HMAC-signed tokens. Double opt-in required before any digest/urgent mail. |
| D3 | Mail provider | Resend for v1 (transactional *and* digests). A `sendEmail()` abstraction so SES can be swapped in later. The **Resend API key lives only in the Worker**; the GitHub Action sends via a Worker admin endpoint. |
| D4 | Digest pipeline | GitHub Actions daily cron (matches the repo's automation fleet; no Worker-CPU limits). Worker cron is NOT used. |
| D5 | State | Snapshot, event log, urgent-send log, and subscribers all live in D1. The Action is stateless and talks to D1 only through Worker `/admin/*` endpoints. |
| D6 | Subscription model | Store the **filter** (conference ids + topic ids), not resolved workshop lists — new workshops match automatically. Starred slugs are stored separately and bypass filters. |
| D7 | Sender | `AI Workshop Tracker <alerts@mail.aiworkshoptracker.com>` — a dedicated subdomain so the apex domain's reputation is never at risk. |
| D8 | Unsubscribe | One-click per RFC 8058 (`List-Unsubscribe` + `List-Unsubscribe-Post`). Unsubscribe **deletes the subscriber row** (most privacy-friendly; local stars survive on-device). Manage page additionally offers "pause" (`cadence='off'`). |
| D9 | Caps | Hard cap `MAX_SUBSCRIBERS = 5000` enforced at `/subscribe`. Friendly "list is full" message beyond it. |
| D10 | Weekly send day | Monday, after the daily diff run (constant `WEEKLY_DOW = 1`). |
| D11 | Feature flag | `PUBLIC_ALERTS_API` build env var. Empty ⇒ every alerts UI element is absent from the built site. |

### Tunable constants (define once in `alerts/config.mjs`, imported by Worker and scripts)

```js
export const MAX_SUBSCRIBERS   = 5000;
export const URGENT_WINDOW_MS  = 72 * 3600_000;   // starred deadline within 72h -> urgent
export const MIN_CHANGE_MS     = 3_600_000;        // mirror lib/workshops.mjs: <1h delta = not a move
export const WEEKLY_DOW        = 1;                // Monday (UTC)
export const SECTION_CAP       = 15;               // max items per digest section, then "and N more ->"
export const SNAPSHOT_SHRINK_GUARD = 0.7;          // abort diff if live set < 70% of snapshot
export const CONFIRM_TTL_S     = 48 * 3600;
export const MAGIC_TTL_S       = 15 * 60;
export const RL_SUBSCRIBE_PER_IP_HOUR = 5;
export const RL_MAGIC_PER_EMAIL_HOUR  = 3;
export const RL_NEW_SUBS_PER_DAY      = 200;       // global brake against signup floods
```

---

## 3. System overview

```
site (Astro, static — GitHub/Cloudflare Pages, unchanged deploy)
 ├─ <AlertsSignup/>  on / and /saved/          } hidden when PUBLIC_ALERTS_API is empty
 ├─ /alerts/…  static pages (manage, confirmed, unsubscribed, error)
 └─ favorites.js patch: fire-and-forget delta sync when a token is present

alerts/worker  (Cloudflare Worker "aiwt-alerts", api.aiworkshoptracker.com or *.workers.dev)
 ├─ browser endpoints: subscribe, confirm, magic-link, me, update, sync, unsubscribe
 ├─ webhook: /webhooks/resend  (bounce/complaint -> suppress/delete)
 ├─ admin endpoints (bearer ADMIN_TOKEN, used only by the Action)
 └─ D1: subscribers, events, urgent_log, kv(snapshot), rl

.github/workflows/alerts.yml  (daily cron, ≥60 min after deploy.yml's daily run)
 ├─ fetch https://aiworkshoptracker.com/api/workshops.json
 ├─ diff vs snapshot (via /admin/kv) -> classify -> POST /admin/events
 ├─ urgent pass (every day): starred + <72h + not yet sent for this deadline value
 └─ weekly pass (Mondays): render per-subscriber digests -> POST /admin/send (Worker holds the key)
```

New top-level directory `alerts/`:

```
alerts/
  config.mjs                  shared constants (above)
  tokens.mjs                  isomorphic HMAC token sign/verify (WebCrypto; runs in Worker and Node tests)
  match.mjs                   subscriber<->workshop matching (pure, tested)
  diff.mjs                    snapshot projection + event classification (pure, tested)
  render.mjs                  digest + urgent + transactional email rendering (pure, tested)
  worker/
    wrangler.toml
    schema.sql
    src/index.mjs             router + endpoints
    src/mail.mjs              sendEmail() -> Resend adapter (SES adapter stub with TODO)
    package.json              wrangler devDependency only
scripts/
  alerts_run.mjs              the Action entrypoint (fetch, diff, urgent, weekly; DRY_RUN support)
  alerts_diff_test.mjs
  alerts_match_test.mjs
  alerts_tokens_test.mjs
  alerts_render_test.mjs
```

---

## 4. Cloudflare Worker

### 4.1 `wrangler.toml`

```toml
name = "aiwt-alerts"
main = "src/index.mjs"
compatibility_date = "2026-08-01"

[[d1_databases]]
binding = "DB"
database_name = "aiwt-alerts"
database_id = "<HUMAN: fill after `wrangler d1 create aiwt-alerts`>"

[vars]
SITE_ORIGIN = "https://aiworkshoptracker.com"
MAIL_FROM   = "AI Workshop Tracker <alerts@mail.aiworkshoptracker.com>"
```

Secrets (set with `wrangler secret put`): `HMAC_SECRET` (32+ random bytes, hex), `ADMIN_TOKEN` (random, shared with the GitHub Action), `TURNSTILE_SECRET`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`.

### 4.2 D1 schema (`alerts/worker/schema.sql`)

```sql
CREATE TABLE IF NOT EXISTS subscribers (
  email          TEXT PRIMARY KEY,            -- normalized: trim + lowercase
  nonce          TEXT NOT NULL,               -- 16 random bytes hex; rotating it revokes every token
  confirmed_at   TEXT,                        -- ISO; NULL until double opt-in completes
  suppressed_at  TEXT,                        -- ISO; set on hard bounce / spam complaint; never mail while set
  conferences    TEXT NOT NULL DEFAULT '[]',  -- JSON array of conference ids (data/conferences.yml); [] = all
  topics         TEXT NOT NULL DEFAULT '[]',  -- JSON array of topic ids (data/topics.yml); [] = all
  starred_ws     TEXT NOT NULL DEFAULT '[]',  -- JSON array of workshop slugs
  starred_papers TEXT NOT NULL DEFAULT '[]',  -- JSON array of {id,title,ws,wsName,pdf?} snapshots (favorites.js shape)
  cadence        TEXT NOT NULL DEFAULT 'weekly',  -- 'weekly' | 'weekly_urgent' | 'off'
  created        TEXT NOT NULL,
  updated        TEXT NOT NULL
);

-- Append-only observation log of dataset changes (NO PII). Powers the weekly
-- digest ("what changed in the last 7 days") and future site features.
CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  observed TEXT NOT NULL,          -- ISO date of the daily run that saw it
  slug     TEXT NOT NULL,
  kind     TEXT NOT NULL,          -- 'announced' | 'deadline_announced' | 'extended' | 'earlier'
  old_utc  TEXT,
  new_utc  TEXT,
  days     INTEGER                 -- max(1, round(|delta|/86400000)); NULL for 'announced'
);
CREATE INDEX IF NOT EXISTS events_observed ON events(observed);

-- One row per urgent alert actually sent. Keyed on the deadline VALUE so an
-- extension re-arms the alert for the new date.
CREATE TABLE IF NOT EXISTS urgent_log (
  email        TEXT NOT NULL,
  slug         TEXT NOT NULL,
  deadline_utc TEXT NOT NULL,
  sent         TEXT NOT NULL,
  PRIMARY KEY (email, slug, deadline_utc)
);

CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);   -- 'snapshot' lives here

CREATE TABLE IF NOT EXISTS rl (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, reset INTEGER NOT NULL);
```

Rate limiting: `bucket` is e.g. `sub:<sha256(ip)>:<hour>` or `magic:<email>:<hour>`; increment-and-check; a daily cleanup (inside the daily admin call) deletes expired rows. Store only hashed IPs, and only transiently.

### 4.3 Tokens (`alerts/tokens.mjs`)

Format: `v1.<base64url(payloadJson)>.<base64url(hmacSha256(payload, HMAC_SECRET))>`.

Payload: `{ e: email, n: nonce, p: purpose, x: expiryEpochSecondsOrNull }`.

Purposes and rules:

| purpose | TTL | grants |
|---|---|---|
| `confirm` | 48 h | completing double opt-in only |
| `magic` | 15 min, effectively single-use | exchanged at `/alerts/manage/` for a `manage` session |
| `manage` | none (nonce-bound) | `/me`, `/update`, `/sync`, unsubscribe |
| `unsub` | none (nonce-bound) | unsubscribe ONLY — a leaked unsubscribe link must not be able to read or edit prefs |

Verification: constant-time compare; payload `n` must equal the subscriber's current `nonce` (so rotating the nonce revokes everything); expired ⇒ reject. Implement with WebCrypto (`crypto.subtle`) so the same module runs in the Worker and under Node for tests.

### 4.4 Browser endpoints

All JSON endpoints: CORS locked to `SITE_ORIGIN` (plus `http://localhost:4321` when `env.DEV`), `Content-Type: application/json`, generic errors — never reveal whether an email exists.

**`POST /subscribe`**
Body: `{ email, conferences[], topics[], starred_ws[], starred_papers[], cadence, turnstile_token }`.
Behavior: verify Turnstile server-side; normalize + syntax-check email; rate-limit (per-IP and global daily); validate conference/topic ids against a build-time-embedded allowlist (ship `alerts/ids.json`, regenerated by a tiny script from `data/conferences.yml` + `data/topics.yml`; the Worker imports it). New email: enforce `MAX_SUBSCRIBERS`, insert row (fresh nonce, `confirmed_at NULL`), send confirm email. Existing unconfirmed: update prefs, re-send confirm (rate-limited). Existing confirmed: update prefs only — no re-confirm, respond that prefs were updated. Always HTTP 200 with a neutral `{ ok: true, message }`.

**`GET /confirm?token=…`** — purpose `confirm` ⇒ set `confirmed_at`, then `302` to `${SITE_ORIGIN}/alerts/confirmed/#t=<manageToken>`. The manage token rides in the URL **fragment** (never sent to servers/analytics); the static page stores it in localStorage (`awt-alerts-token`, plus `awt-alerts-email` for display) — this is what links the confirming device for sync.

**`POST /magic-link`** — `{ email, turnstile_token }`. If a confirmed row exists, email a link to `${SITE_ORIGIN}/alerts/manage/#t=<magicToken>`. Always neutral 200.

**`GET /me`** (`Authorization: Bearer <manage>`) → full prefs + starred arrays. A `magic` token is also accepted here exactly once: the response includes a fresh `manage` token the page swaps into localStorage.

**`POST /update`** (Bearer manage) — `{ conferences, topics, cadence }` with the same id validation.

**`POST /sync`** (Bearer manage) — `{ op: 'add'|'remove', kind: 'ws'|'paper', slug?, paper? }`. Mutates the JSON arrays idempotently (adding an existing slug is a no-op).

**`GET /unsubscribe?token=…`** (accepts `unsub` or `manage`) — delete the row, `302` to `/alerts/unsubscribed/`.
**`POST /unsubscribe?token=…`** — the RFC 8058 one-click target: delete the row, return `200` plain text. No body parsing, no confirmation page — mail clients call this directly.

**`POST /webhooks/resend`** — verify the Svix-style signature with `RESEND_WEBHOOK_SECRET`. On `email.bounced` (hard) or `email.complained`: complaint ⇒ delete the row; hard bounce ⇒ set `suppressed_at`. Ignore other event types. Always 200.

### 4.5 Admin endpoints (bearer `ADMIN_TOKEN`; the Action is the only client)

| endpoint | purpose |
|---|---|
| `GET  /admin/subscribers` | confirmed, non-suppressed, `cadence != 'off'` rows (all fields the renderer needs) |
| `GET  /admin/kv/snapshot` · `PUT /admin/kv/snapshot` | read/write the diff snapshot (projection JSON, ~60 KB) |
| `POST /admin/events` | bulk-insert classified events `{observed, items:[…]}` |
| `GET  /admin/events?since=ISO` | events for the weekly window |
| `POST /admin/urgent-filter` | body: candidate `{email, slug, deadline_utc}` triples → returns the subset NOT yet in `urgent_log` |
| `POST /admin/urgent-log` | insert triples after successful send |
| `POST /admin/send` | `{ messages: [{to, subject, html, text}] }`, ≤50 per call; Worker adds `List-Unsubscribe` headers (it mints each recipient's `unsub` token — tokens never transit the Action) and forwards to Resend's batch API. Returns per-message accepted/failed. |
| `POST /admin/maintenance` | expire `rl` rows; prune `events` older than 90 days |

Rationale for `/admin/send`: the mail key and token minting stay in exactly one place. The Action never holds the Resend key and never sees a token.

---

## 5. Site changes (Astro)

### 5.1 Feature flag

Add to `site/src/lib/site.ts`:

```ts
/** Base URL of the alerts Worker. Empty string disables every alerts UI element
 *  (forks and PR preview builds run without the feature). */
export const ALERTS_API = import.meta.env.PUBLIC_ALERTS_API || '';
export const TURNSTILE_SITE_KEY = import.meta.env.PUBLIC_TURNSTILE_SITE_KEY || '';
```

Every component/page below renders `null` (or is excluded) when `ALERTS_API` is empty. Document both vars in `docs/DEPLOYING.md`'s env table.

### 5.2 `<AlertsSignup />` component (`site/src/components/AlertsSignup.astro`)

Placement: on the homepage inside/next to the existing `.cta` aside, and on `/saved/` under the heading ("Back up this list & get deadline alerts"). Keep visual style consistent with the existing `.cta` / facet dropdowns — reuse `.dd` details/summary pickers.

Contents:

- Email input.
- Conference picker and Topic picker (multi-select checklists built at build time from `conferences` / `topics` in `site/src/lib/data.ts`; submit **ids**, display labels). Empty selection = "everything" — say so in the UI.
- Cadence: radio `weekly` (default) / `weekly_urgent` ("also email me when a starred workshop's deadline is within 72 hours").
- Cloudflare Turnstile widget (site key from env).
- On submit: read `awt-fav-workshops` and `awt-fav-papers` from localStorage and include them in the payload — starred-workshop alerts work from day one, before any sync exists.
- Privacy microcopy (verbatim, keep the tone of the site): *"One email a week at most, plus optional urgent deadline alerts. Your address is stored only to send these; one-click unsubscribe deletes it. Nothing is sold, no tracking pixels."*
- Success state: "Check your inbox to confirm." Error states: full list (`MAX_SUBSCRIBERS`), rate-limited, network.

### 5.3 Static pages under `site/src/pages/alerts/`

- `index.astro` — what the alerts are, sample digest screenshot/text, the signup component, FAQ (data source caveat: *always confirm on the official page*; how deletion works).
- `confirmed.astro` — "You're subscribed." Inline script: read `#t=` fragment → store `awt-alerts-token` → call `GET /me` → merge server starred lists into localStorage (union) → `window.awtFavsHydrate?.()`.
- `manage.astro` — reads `#t=` (magic or stored manage token) → `GET /me` → renders prefs form → `POST /update`. Also: "Pause emails" (`cadence:'off'`), "Unsubscribe & delete my data" (link with unsub token via `/me` response), "Unlink this device" (clear the two localStorage keys only).
- `unsubscribed.astro` — confirmation + note that saved items remain in this browser.

These are static pages calling the Worker from the client — the site itself stays a static build.

### 5.4 `favorites.js` patch (keep the module tiny; ~30–40 lines added)

- New helpers: `alertsToken()` reads `awt-alerts-token`; `syncOp(op, kind, payload)` does a fire-and-forget `fetch(ALERTS_API + '/sync', …)` with one retry on network failure, silently giving up after that (local write already succeeded — sync is best-effort).
- In `toggleWorkshop` / `togglePaper`: after a successful local `write(...)`, if a token exists, call `syncOp('add'|'remove', …)`. For papers, send the same snapshot shape already built for localStorage.
- On module init, if a token exists: `GET /me`, **union-merge** server arrays into local (never delete locally on hydrate — removals only propagate as explicit `remove` ops), write back, `hydrate()`.
- Known accepted limitation (document in a comment): a removal performed while offline on device A can be resurrected by device B's union-hydrate. Fine for v1; do not build tombstones.
- The `ALERTS_API` constant reaches this plain-JS module via a `<meta name="alerts-api">` tag emitted by `Base.astro` (empty when disabled) — avoids importing Astro env into the shared script.

### 5.5 `/saved/` page

When a token is present: show "Synced as {email} · manage" line; hydrate from `/me` (union) before rendering, so a fresh phone shows the full list immediately after clicking a magic link.

---

## 6. Digest pipeline (GitHub Actions)

### 6.1 Workflow `.github/workflows/alerts.yml`

- `schedule:` daily cron **at least 60 minutes after** `deploy.yml`'s daily cron (read that file and pick the offset; the diff must see today's rebuilt `workshops.json`). Plus `workflow_dispatch` with inputs: `dry_run` (default true on manual runs) and `force_weekly`.
- `concurrency: { group: alerts, cancel-in-progress: false }` — deliberately NOT the `data-write` group; this job never commits to the repo.
- Secrets used: `ALERTS_API_BASE`, `ALERTS_ADMIN_TOKEN`. Nothing else.
- Single step: `node scripts/alerts_run.mjs`. **Never print subscriber emails or message bodies to the log** — log counts and slugs only.
- On failure the job fails loudly (repo convention: GitHub's failure email is the alert channel).

### 6.2 `scripts/alerts_run.mjs` flow

1. `fetch https://aiworkshoptracker.com/api/workshops.json` (env-overridable for tests).
2. Build the **projection** per workshop (in `alerts/diff.mjs`): `{slug, name, acronym, conference, year, topics, status_label, deadline_utc, abstract_deadline_utc, next_stage_utc, website}`.
3. `GET /admin/kv/snapshot`.
   - **No snapshot (first run):** `PUT` the projection, send nothing, exit 0. Never treat the whole dataset as "new".
   - **Shrink guard:** if `live.count < SNAPSHOT_SHRINK_GUARD * snapshot.count`, abort loudly without writing — a garbled/partial fetch must not fabricate hundreds of events (same paranoia as the importer's later-only rule).
4. Classify events (pure function in `alerts/diff.mjs`, unit-tested):
   - new slug → `announced`
   - `deadline_utc` null → value → `deadline_announced`
   - `deadline_utc` moved by ≥ `MIN_CHANGE_MS` → `extended` / `earlier`, `days = max(1, round(|Δ|/86400000))` (exactly mirrors `deriveDeadlineChange`)
   - deleted slugs: no event (rare; ignore)
   - `abstract_deadline_utc` changes: **out of scope v1** (see Follow-ups)
5. `POST /admin/events`, then `PUT /admin/kv/snapshot` (only after events landed).
6. **Urgent pass (every run):** for each subscriber with `cadence='weekly_urgent'`, collect starred slugs whose `next_stage_utc` is within `URGENT_WINDOW_MS` ahead. `POST /admin/urgent-filter` to drop already-sent triples. Render one combined urgent email per subscriber (all their imminent starred workshops in one message), `POST /admin/send`, then `POST /admin/urgent-log` for accepted messages only.
7. **Weekly pass (UTC Monday, or `force_weekly`):** `GET /admin/events?since=now-7d` + live projection + `GET /admin/subscribers`. For each subscriber, assemble the digest (below); **skip subscribers whose digest is entirely empty**. Send in chunks of ≤50 via `/admin/send`.
8. `POST /admin/maintenance`.
9. `DRY_RUN=1`: perform everything except `/admin/send`, `/admin/urgent-log`, and the snapshot `PUT`; print per-recipient subjects + section counts (never bodies/emails).

### 6.3 Matching (`alerts/match.mjs`, pure, tested)

A workshop matches a subscriber iff:

```
slug ∈ starred_ws                                   // starred always wins
OR (
  (conferences == [] OR workshop.conference ∈ conferences)
  AND (topics == [] OR workshop.topics ∩ topics ≠ ∅)
)
```

### 6.4 Digest content spec

Subject: `{n} deadline changes, {m} new workshops in your areas — AI Workshop Tracker` (drop zero-count clauses; both zero + nothing closing ⇒ email is skipped).

Sections, in order, each capped at `SECTION_CAP` items with an "and N more →" link:

1. **Deadline changes this week** — matched `extended`/`earlier`/`deadline_announced` events: `→ Extended 5 days · {name} ({CONF} {year}) — now {date} UTC` (reuse the site's arrow/△ vocabulary).
2. **Newly announced** — matched `announced` events whose current status isn't Past.
3. **Closing in the next 7 days** — from live projection, matched, sorted by `next_stage_utc`; prefix ★ if starred; label `(abstract)` when `next_stage_is_abstract`.
4. **Your starred — next deadlines** — top 5 starred by `next_stage_utc`, regardless of filters.

Every item's title links to `https://aiworkshoptracker.com/workshop/<slug>/`. "And N more" links to the homepage with prefilled facets — note the site's URL params use **display labels**, not ids (see `index.astro`), so map ids → labels when building these links.

Footer (every email, required): "Data observed by aiworkshoptracker.com — dates are when we recorded a value, not necessarily when organizers changed it. **Always confirm on the official workshop page.**" · Manage preferences (tokenized link) · Unsubscribe (tokenized link) · postal address line (HUMAN decision, see §9) · "Sent because you subscribed at aiworkshoptracker.com".

Rendering (`alerts/render.mjs`): semantic HTML with inline styles, single-column, dark-mode-safe (no pure-white backgrounds), system font stack; a plaintext alternative for every message; **no images, no pixels**. Urgent email: subject `⏰ {acronym} deadline in {h}h — {date}`, one short block per workshop.

Transactional templates (also in `render.mjs`): confirm ("Confirm your subscription — expires in 48 h"), magic link ("Your sign-in link — expires in 15 minutes; if you didn't request this, ignore it").

---

## 7. Security & privacy requirements (verify each in review)

- Double opt-in before any non-transactional mail. Confirm/magic links single-purpose and expiring; `unsub` tokens can only unsubscribe.
- Constant-time HMAC comparison; nonce check on every token; nonce rotation on "delete my data".
- Turnstile verified server-side on `/subscribe` and `/magic-link`; per-IP and global rate limits per §2 constants. IPs stored only as salted hashes in `rl`, expiring within hours.
- CORS allowlist = site origin only. No wildcard. Admin/webhook endpoints reject browser origins.
- Neutral responses everywhere an email is looked up (no account enumeration).
- One-click unsubscribe: `List-Unsubscribe: <https://…/unsubscribe?token=…>` **and** `List-Unsubscribe-Post: List-Unsubscribe=One-Click` on every digest/urgent email (Gmail/Yahoo bulk-sender requirement).
- Deletion = one `DELETE` of the subscriber row (+ their `urgent_log` rows). Manage page exposes it. This is the GDPR erasure path — document it in `docs/ALERTS.md`.
- No PII in the Git repo, Action logs, or error messages. `events` and `kv` contain workshop data only.
- Send from the `mail.` subdomain with SPF, DKIM, DMARC configured (HUMAN, §9).

## 8. Tests (repo rule: behavior is pinned by tests)

New, wired into `validate.yml` (or a sibling `alerts-ci.yml` triggered on `alerts/**` + `scripts/alerts_*` paths — agent's choice, but CI must run them):

- `scripts/alerts_diff_test.mjs` — classification table incl.: first-run seeds silently; shrink guard aborts; <1 h delta suppressed; extension days rounding matches `deriveDeadlineChange`; null→value = announced.
- `scripts/alerts_match_test.mjs` — empty-filters-means-all; topic intersection; starred bypasses filters.
- `scripts/alerts_tokens_test.mjs` — round-trip, expiry, wrong purpose rejected, nonce rotation revokes, tamper detection.
- `scripts/alerts_render_test.mjs` — empty digest ⇒ null (skip); section caps + "and N more"; **every rendered email contains an unsubscribe URL**; plaintext part exists; footer caveat present.
- Keep `scripts/docs_sync_test.mjs` green after the docs edits below (read it first to see what it pins).

Manual test checklist for the PR description: full subscribe→confirm→digest-dry-run loop against a real inbox; one-click POST unsubscribe from Gmail; two-browser star sync convergence.

## 9. HUMAN setup checklist (maintainer actions — the agent must stop and request these)

1. Cloudflare account: create D1 db `aiwt-alerts`, fill `database_id`; create an API token for deploys → repo secret `CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`).
2. Turnstile widget for aiworkshoptracker.com → `PUBLIC_TURNSTILE_SITE_KEY` (build env) + `TURNSTILE_SECRET` (Worker secret).
3. Resend account; add + verify domain `mail.aiworkshoptracker.com`; publish the DNS records Resend specifies (DKIM, SPF include, MX for return-path) plus a DMARC TXT (`p=none; rua=mailto:…` to start). → `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` (Worker secrets); configure the webhook to `…/webhooks/resend`.
4. Generate `HMAC_SECRET` and `ADMIN_TOKEN`; set as Worker secrets; add `ALERTS_ADMIN_TOKEN` + `ALERTS_API_BASE` as repo Action secrets.
5. Set `PUBLIC_ALERTS_API` (and the Turnstile site key) in the site's build environment.
6. Decide the CAN-SPAM postal address line for the footer (a PO box / registered-agent address; a home address is not recommended).
7. Optional now, required before the list nears ~90: Resend's free tier caps at 100 emails/day — either upgrade ($20/mo) or implement the SES adapter (`$0.10/1k`; needs SigV4, e.g. `aws4fetch`, plus a sandbox-exit support ticket). The `sendEmail()` seam in `src/mail.mjs` exists for exactly this swap.

## 10. Docs to update in the same PR (repo rule: docs travel with the change)

- `README.md` — replace "no email alerts / no accounts" in *Scope (deliberately) excluded* with: alerts exist as an **optional, isolated satellite** (no passwords, deletable without touching the site); link `docs/ALERTS.md`. Add the signup to the feature list.
- `docs/ARCHITECTURE.md` — new section "Email alerts (optional satellite)": the D1–D11 decisions, why Actions-not-Worker-cron, why filters-not-lists, the union-merge limitation, the shrink guard, the no-PII rule.
- `docs/AUTOMATION.md` — workflow table rows for `alerts.yml` and the Worker deploy workflow (add `.github/workflows/alerts-worker-deploy.yml`: `wrangler deploy` on pushes touching `alerts/worker/**`).
- `docs/DEPLOYING.md` — env vars, Worker deploy steps, DNS records summary.
- New `docs/ALERTS.md` — ops runbook: rotate secrets, delete a subscriber by hand, provider cutover to SES, interpreting the shrink-guard abort, what the events table is.
- `site/src/pages/about.astro` — a short privacy paragraph about the alerts feature.

## 11. Rollout phases (each = one reviewable PR, in order)

- **Phase 0 — pure logic.** `alerts/{config,tokens,match,diff,render}.mjs` + all four test files green in CI. No deploy, no UI.
- **Phase 1 — opt-in loop.** Worker (schema, subscribe/confirm/magic/me/update/unsubscribe/webhook), deploy workflow, `/alerts/` pages, `<AlertsSignup/>` behind the env flag. *Accepts when:* real-inbox subscribe→confirm works end-to-end; one-click POST unsubscribe deletes the row; site builds identically with the flag empty.
- **Phase 2 — sync.** `favorites.js` patch, `/sync`, `/saved/` hydrate. *Accepts when:* stars converge across two browsers via a magic link; anonymous starring is byte-for-byte unchanged.
- **Phase 3 — pipeline.** `alerts.yml` + `alerts_run.mjs` + admin endpoints. *Accepts when:* a `dry_run` dispatch prints sane per-recipient counts; a real weekly send to a maintainer-only test address renders correctly in Gmail (incl. the unsubscribe header) ; urgent dedupe verified by running the job twice in one day.
- **Phase 4 — docs + launch.** §10 complete, `docs_sync_test` green, remove any test-only allowlist.

## 12. Deliberately deferred (do NOT build now; leave TODOs referencing this section)

Abstract-deadline change events · per-track deadline events · SES adapter implementation · digest frequency options beyond weekly · a public `/changelog` page rendered from the `events` table (nice future win — the table is designed for it) · Bluesky/X bot fed by the same events · re-enabling calendar feeds.
