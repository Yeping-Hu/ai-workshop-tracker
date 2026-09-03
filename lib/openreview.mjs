/**
 * One gate in front of every OpenReview request.
 *
 * OpenReview publishes its rate limit on every single response:
 *
 *     ratelimit-policy: 20;w=60        20 requests per 60 seconds
 *     x-ratelimit-remaining: 19
 *     ratelimit-reset: 60              seconds until the window resets
 *
 * The crawler used to ignore all of it — one path paced at 350ms, the other not
 * at all — which is roughly 340 requests a minute against a ceiling of 20. The
 * HTTP 429s that followed were not bad luck but arithmetic, and the retries
 * then spent their attempts inside a window that was already exhausted.
 *
 * So this reads the headers and spends the advertised budget instead of
 * guessing. It does **not** impose a flat delay: when the server says there is
 * room, requests go straight through. Slowing down a crawl that has budget to
 * spare would be its own bug — the point is to stop overrunning, not to crawl
 * slowly.
 *
 * Shared deliberately. `deadlineFromInvitation` is called by five scripts —
 * discovery, backfill, crosscheck, recheck-imminent and resync — several on
 * daily crons, all against the same per-IP budget. A limiter living in only one
 * of them would be no limiter at all.
 */

import fs from 'node:fs';

/** Leave one request unspent, so the last token is never the one that 429s. */
const HEADROOM = 1;
/** Used only before the first response teaches us the real policy. */
const ASSUMED_LIMIT = 20;
const ASSUMED_WINDOW_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

const state = {
  remaining: ASSUMED_LIMIT,
  resetAt: 0,
  limit: ASSUMED_LIMIT,
  windowMs: ASSUMED_WINDOW_MS,
};

/**
 * Requests are serialised through this chain rather than merely counted.
 * Counting alone races: two callers can both read "1 remaining", both decide
 * they may proceed, and both send.
 */
let chain = Promise.resolve();

/** Venues a lookup could not verify, for the caller to report and retry. */
const unverified = [];

/** Read whatever the response is willing to tell us about the budget. */
function learn(res) {
  const remaining = num(res.headers.get('ratelimit-remaining') ?? res.headers.get('x-ratelimit-remaining'));
  const limit = num(res.headers.get('ratelimit-limit') ?? res.headers.get('x-ratelimit-limit'));
  const reset = num(res.headers.get('ratelimit-reset'));

  if (limit !== null && limit > 0) state.limit = limit;
  if (remaining !== null) state.remaining = remaining;
  // `ratelimit-reset` is seconds-until-reset; `x-ratelimit-reset` is an epoch
  // second. Tell them apart by magnitude rather than trusting either name.
  if (reset !== null) {
    state.resetAt = reset > 1e6 ? reset * 1000 : Date.now() + reset * 1000;
    if (reset <= 1e6 && reset > 0) state.windowMs = reset * 1000;
  }
  // A 429 means the budget is gone whatever the headers claim.
  if (res.status === 429) {
    state.remaining = 0;
    if (state.resetAt <= Date.now()) state.resetAt = Date.now() + state.windowMs;
  }
}

/** Block until there is budget for one more request. */
async function waitForSlot() {
  for (;;) {
    const now = Date.now();
    if (now >= state.resetAt) {
      // Window elapsed: the budget is full again until a response says otherwise.
      state.remaining = state.limit;
      state.resetAt = now + state.windowMs;
      return;
    }
    if (state.remaining > HEADROOM) return;
    await sleep(Math.min(state.resetAt - now, state.windowMs) + 50);
  }
}

/**
 * Fetch, paced. Returns the Response untouched; callers keep their own
 * status handling, since "404 means no submission invitation" is their business
 * and not this module's.
 */
export function openreviewFetch(url, init) {
  const run = chain.then(async () => {
    await waitForSlot();
    state.remaining -= 1;
    const res = await fetch(url, init);
    learn(res);
    return res;
  });
  // The chain must survive a rejected request, or one network error stops every
  // later call. Errors still reach the caller through `run`.
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Note that a lookup could not be completed — never silently treated as absent. */
export function recordUnverified(id, reason) {
  unverified.push({ id: String(id), reason: String(reason ?? 'unknown') });
}

/** The bare value of an OpenReview content field. API v2 wraps each one as
 *  `{ value: … }` (sometimes beside `readers`); v1 returned it bare. Callers
 *  read through this so neither shape matters — six scripts had a private
 *  copy of the same line. */
export const unwrap = (x) => (x && typeof x === 'object' && 'value' in x ? x.value : x);

export function getUnverified() {
  return unverified.slice();
}

export function clearUnverified() {
  unverified.length = 0;
}

/**
 * Retry every lookup that did not complete, once, and report what is still
 * missing.
 *
 * `discover.yml` has had this since the first 429s — a second pass over
 * `.unverified.tsv` once the rate budget has recovered — but it lived in that
 * one workflow, driven by the only `getUnverified()` call in the repo. Every
 * other job recorded its failures into this list and then dropped them at
 * process exit, so a throttled lookup was indistinguishable from a venue that
 * genuinely has nothing to say. This is that second pass, available to all of
 * them.
 *
 * `attempt(id, reason)` re-runs the caller's OWN lookup for one recorded id and
 * resolves truthy when it finally succeeded. Anything it records while running
 * is kept, so a retry that fails a different way is not lost. Returns the
 * entries that are still unverified, and leaves exactly those in the list.
 */
export async function retryUnverified(attempt) {
  const pending = getUnverified();
  if (!pending.length) return [];
  clearUnverified();
  const failed = [];
  for (const entry of pending) {
    let ok = false;
    try {
      ok = Boolean(await attempt(entry.id, entry.reason));
    } catch (err) {
      ok = false;
      entry.reason = `${entry.reason} (retry: ${err.message})`;
    }
    if (!ok) failed.push(entry);
  }
  // Whatever the attempts themselves recorded stays; first mention of an id wins,
  // so a retried entry keeps the reason it was first recorded with.
  const merged = [];
  const seen = new Set();
  for (const e of [...failed, ...getUnverified()]) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    merged.push(e);
  }
  clearUnverified();
  unverified.push(...merged);
  return getUnverified();
}

/**
 * Name what is still unverified, on stdout and in `$OPENREVIEW_UNVERIFIED`.
 *
 * The file is the same TSV `discover.yml` already turns into the "Data health:
 * venues not verified" issue — `conf \t year \t id \t reason` — so every job
 * that reads OpenReview feeds one report rather than growing its own. Callers
 * pass rows because only they know which conference-year a venue id belongs to.
 *
 * A count is not a report: "37 unfetchable" reads as a rounding error, while the
 * 37 names read as a fifth of the corpus going unchecked.
 */
export function writeUnverified(rows) {
  if (!rows.length) return;
  for (const r of rows) console.log(`    ⚠ unverified: ${r.id} — ${r.reason}`);
  if (!process.env.OPENREVIEW_UNVERIFIED) return;
  fs.appendFileSync(
    process.env.OPENREVIEW_UNVERIFIED,
    rows.map((r) => `${r.conf ?? '-'}\t${r.year ?? '-'}\t${r.id}\t${r.reason}`).join('\n') + '\n',
  );
}

/** Exposed for tests and for logging the observed pace. */
export function rateState() {
  return { ...state };
}

/** Tests inject a fake clock/fetch through this rather than monkey-patching globals. */
export function __resetForTests(next = {}) {
  state.remaining = next.remaining ?? ASSUMED_LIMIT;
  state.resetAt = next.resetAt ?? 0;
  state.limit = next.limit ?? ASSUMED_LIMIT;
  state.windowMs = next.windowMs ?? ASSUMED_WINDOW_MS;
  chain = Promise.resolve();
  unverified.length = 0;
}
