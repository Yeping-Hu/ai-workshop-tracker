# AI Workshop Tracker — working notes for agents

Pointers, not a second copy of the docs. Read the linked doc before changing
the thing it describes; the docs explain *why*, and most of the code's shape is
downstream of a reason recorded there.

## Where things are

- `README.md` — what the site is, the repo layout, quickstart.
- `CONTRIBUTING.md` — the data model (field reference), what CI checks, maintainer notes.
- `docs/ARCHITECTURE.md` — why it is built this way. Read before touching search, statuses, deadline sync, related entries, identity, or alerts.
- `docs/AUTOMATION.md` — every workflow, the `data-write` rules, the publish action, maintainer sweeps.
- `docs/ALERTS.md` — the email-alerts runbook (Worker, D1, secrets, dashboard).
- `docs/DEPLOYING.md` — hosting and every environment variable.
- `skills/add-conference/` — the procedure for adding a conference.

## Standing rules

1. **Push straight to `main`.** Maintainers open no PRs; CI (`Validate data`,
   `Build check`, `Live smoke test`) and the local suite are the gate. One
   logical change per commit, verified green before the push.
2. **The automation must keep running unattended.** No change adds a human
   step, a review gate, or a new way for a scheduled job to go red on a
   transient condition. Self-heal first, warn second, fail last; a partial
   result publishes rather than being thrown away.
3. **Every fix is a general rule, never a per-workshop mechanism.** Enumerate
   the whole corpus, pin fixtures that fail without the rule, then land it.
4. **No hand-authored data artifacts.** `data/` and `cache/` are written by
   the pipeline or are explicitly empty; fixtures live in `scripts/` and ship nowhere.
5. **Docs travel with the change.** A schema field → the CONTRIBUTING table and
   `data/workshops/_template.yml` (`docs_sync_test.mjs` enforces it). A
   behaviour → `docs/ARCHITECTURE.md` and the script's header comment. A
   workflow → `docs/AUTOMATION.md`. A conference → the README list.
6. **Every behaviour rule is pinned by a `scripts/*_test.mjs`**, and every test
   file is named in a workflow (`docs_sync_test.mjs` enforces that too).
7. Comments explain *why*. A decision written in a comment is a decision, not a TODO.

## Running things

```bash
npm ci && npm ci --prefix site
npm test                          # every standalone suite (scripts/run_tests.mjs)
node scripts/validate.mjs         # the data
npm run build --prefix site       # full build incl. the two Pagefind indexes
npm run preview --prefix site &   # then: node scripts/ui_test.mjs http://localhost:4321
```

The two alerts browser suites run against a build with `PUBLIC_ALERTS_API`
set; `.github/workflows/pr-build-check.yml` has the exact commands.

## Things that bite

- `npm audit fix` on macOS drops the wasm32-only optional entries from
  `site/package-lock.json` while leaving packages that depend on them, so
  `npm ci` passes locally and fails on every Linux runner. `npm test` includes
  `scripts/lockfile_test.mjs`, which catches the dangling references.
- Plain Node ESM (`.mjs`) outside `site/`, no new dependencies without a stated reason.
- A push made with `GITHUB_TOKEN` does not trigger `on: push`; the publish
  action dispatches `deploy.yml` itself. Keep that if you touch it.
