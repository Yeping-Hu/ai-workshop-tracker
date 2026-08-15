# Email Alerts — Follow-up Tasks (pre-commit review round)

**Context:** You implemented all five phases of `EMAIL_ALERTS_PLAN.md`; the work sits uncommitted in the working tree. The maintainer has reviewed your report. This document is the complete list of what to do next, in order. Treat it as the source of truth for this round.

**Ground rules for this round**

- **Evidence, not assertions.** For every verification item below, paste the actual evidence into your final report: `grep -rn` output, file:line references, or test output. "Confirmed" without evidence does not count as done.
- **No PII anywhere** — not in commit messages, the PR body, test fixtures, or pasted evidence. Use `test@example.com`-style addresses in fixtures.
- **Stop and ask** before anything that needs accounts, secrets, DNS, or deployed infrastructure. Those remain maintainer-only (plan §9) and are explicitly out of scope here.

---

## 1. Rebase onto latest `origin/main`

The repo's bots (discover, recheck-imminent, backfill, sync-tracks) commit to `main` daily, so the tree you cloned is already behind.

- `git fetch origin && git rebase origin/main` (stash/replay the uncommitted work as needed).
- Expected conflicts are limited to files you *edited* rather than created: `README.md`, `docs/ARCHITECTURE.md`, `docs/AUTOMATION.md`, `docs/DEPLOYING.md`, `site/src/pages/about.astro`, `site/src/scripts/favorites.js`, `site/src/lib/site.ts`, `site/src/components/Base.astro`. Resolve by keeping both the upstream changes and the alerts additions.
- After rebasing: `node scripts/validate.mjs` and the full test run must pass again before you continue.

## 2. Ratified decisions (your three judgment calls)

All three are **approved**. Two carry a condition:

1. **`{{UNSUB_URL}}` / `{{MANAGE_URL}}` placeholder substitution in `/admin/send`** — approved, including dropping subscribers who unsubscribed between render and send. Condition: implement the send-guard in §3 below.
2. **Magic-token single-use via a short-lived used-token hash row** (instead of nonce rotation) — approved; it's better than the plan's original design because rotation would have unlinked every other device. Condition: the used-token table must be cleaned by `/admin/maintenance`. Verify it is; if not, add it, and cover the expiry/cleanup path with a test.
3. **Turnstile fails closed** when `TURNSTILE_SECRET` is unset — approved. Condition: add a short note to `docs/ALERTS.md` that local development should use Cloudflare's documented always-pass Turnstile test keypair (link the official Turnstile docs page for the current values; do not invent key strings).

## 3. Required fix: send-time placeholder guard

The placeholder design introduces one new failure mode: a template edit that misses substitution would email a literal `{{UNSUB_URL}}` to subscribers.

- In `/admin/send`, **after** substitution and **before** forwarding to Resend, reject any message whose `html` **or** `text` still contains the substring `{{`. Rejected messages are reported per-message in the endpoint's existing accepted/failed response — never silently dropped, never sent.
- Factor the substitution + guard into a pure function (e.g. `alerts/render.mjs` or a small shared module) so it runs under Node for tests.
- Tests to add:
  - substitution succeeds and the guard passes on a normal digest;
  - a leftover `{{` (any placeholder, either part) is rejected;
  - an unsubscribed-between-render-and-send recipient is dropped at send time (pin the behavior you already implemented, if no test exists yet).
- Update `scripts/alerts_render_test.mjs`: the plan's original assertion said every rendered email contains an *unsubscribe URL*; under the placeholder design the correct assertion is that every rendered digest/urgent email contains `{{UNSUB_URL}}` (and the manage link `{{MANAGE_URL}}` in the footer). Make sure the test reflects what render actually guarantees now.

## 4. Verification checklist (paste evidence for each)

1. **Admin auth on every route.** Show that **all** `/admin/*` routes verify the `ADMIN_TOKEN` bearer before touching D1 — cite the router mechanism (single middleware/guard preferred) with file:line, or per-route evidence if not centralized. One missed route here is a full subscriber-list dump; this is the highest-stakes item on the list.
2. **No PII in logs.** `grep -rn 'console\.' alerts/ scripts/alerts_run.mjs .github/workflows/alerts.yml` — show the output and confirm nothing logs email addresses or message bodies (counts, slugs, and subjects are fine per the plan; if subjects can embed nothing personal, they're acceptable).
3. **CORS + webhook.** Evidence that the CORS allowlist is exactly `SITE_ORIGIN` (plus the localhost dev origin) with no wildcard; that `/admin/*` and `/webhooks/resend` reject browser origins; and the exact lines where the Resend webhook signature is verified before any row is modified.
4. **Abuse limits.** File:line for `MAX_SUBSCRIBERS` enforcement, per-IP rate limit on `/subscribe`, per-email rate limit on `/magic-link`, the global daily new-subscriber brake, and neutral (non-enumerating) responses on both endpoints.
5. **Recipient selection.** Evidence that `/admin/subscribers` excludes `cadence='off'` and `suppressed_at IS NOT NULL` rows, and that the urgent pass keys on `next_stage_utc` (so an open abstract stage triggers correctly), not on `deadline_utc`.
6. **Token in fragment.** The `/confirm` redirect places the manage token in the URL **fragment** (`#t=…`), not the query string — cite the redirect line.
7. **Anonymous path untouched.** `git diff origin/main -- site/src/scripts/favorites.js` — walk the diff and confirm: with no `awt-alerts-token` present, behavior is byte-for-byte equivalent to before, and a failed/slow `syncOp` can never block, delay, or alter the local write.
8. **Workflow hygiene.** `alerts.yml` uses `concurrency: { group: alerts, cancel-in-progress: false }`, references only `ALERTS_API_BASE` and `ALERTS_ADMIN_TOKEN`, and no step echoes request/response payloads.
9. **Full suite.** Output of `node scripts/validate.mjs` plus all test scripts (the 18 pre-existing + your 4 + any added in §3) after the rebase and fixes.

If any item fails, fix it in place and note the fix in your report.

## 5. Commit structure

Turn the working tree into branch **`alerts/v1`** with exactly these commits, in order (bisectable; each must build and pass tests on its own):

| # | Commit | Contents |
|---|---|---|
| 0 | `alerts: plan + pure logic (phase 0)` | `docs/plans/email-alerts.md` (**commit the plan file** — your report omitted it) and, optionally, this follow-up doc as `docs/plans/email-alerts-followup.md`; `alerts/{config,tokens,match,diff,render}.mjs`, `alerts/ids.json` + its generator; the four test suites + §3 test additions; CI wiring for them |
| 1 | `alerts: worker + opt-in UI (phase 1)` | `alerts/worker/**` incl. `schema.sql` and the §3 guard; worker-deploy workflow; `ALERTS_API` flag, `<AlertsSignup/>`, `/alerts/` pages |
| 2 | `alerts: cross-device sync (phase 2)` | `favorites.js` patch, `<meta name="alerts-api">`, `/saved/` synced-as line |
| 3 | `alerts: digest pipeline (phase 3)` | `scripts/alerts_run.mjs`, `.github/workflows/alerts.yml` |
| 4 | `alerts: docs (phase 4)` | `docs/ALERTS.md` (incl. the §2.3 Turnstile note), README / ARCHITECTURE / AUTOMATION / DEPLOYING / about.astro updates |

Commit-message style: match the repo's existing history (imperative, explain *why* in the body where a decision isn't obvious — e.g. the placeholder guard's rationale belongs in commit 1's body).

## 6. Push and open the PR

- Push `alerts/v1`; open a PR against `main`. The existing `pr-build-check.yml` provides an independent build check — confirm it goes green.
- PR description must contain:
  1. One paragraph per phase (what/why), linking `docs/plans/email-alerts.md` section numbers.
  2. The three ratified judgment calls from §2, so the reasoning is on the record.
  3. The full evidence from §4 (grep output / line refs / test summary).
  4. The manual test checklist from plan §8, with each item marked **pending maintainer** where it needs real accounts (inbox round-trip, Gmail one-click unsubscribe, two-browser sync).
  5. The **blocked-on-maintainer** list from plan §9 verbatim (D1 id, five Worker secrets, four repo secrets, Resend DNS, `PUBLIC_ALERTS_API`/Turnstile build env, postal-address decision), so nothing silently stalls.

## 7. Explicitly out of scope for this round

Do **not**: create or configure any Cloudflare/Resend/Turnstile resources; touch DNS; set or invent any secret values; deploy the Worker; enable the `alerts.yml` schedule against production; implement the SES adapter or anything in plan §12; merge the PR. When a task appears to require any of these, stop and ask.

## Definition of done

Rebase clean · §3 guard implemented with tests · all §4 evidence pasted and passing · five commits on `alerts/v1` including the committed plan file · PR open with the description contents above · full validate + test suite green on the branch and in CI.
