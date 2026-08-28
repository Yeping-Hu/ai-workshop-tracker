#!/usr/bin/env node
/**
 * The OpenReview rate limiter.
 *
 * OpenReview allows 20 requests per 60 seconds and says so on every response.
 * The crawler used to run at roughly 340/min against that, so the 429s were
 * arithmetic rather than luck. These checks pin the two halves of the fix:
 * that the limiter actually waits when the budget is spent, and — just as
 * important — that it does *not* wait when there is budget left. A limiter
 * that halves throughput on a healthy connection is its own bug.
 *
 * No network: `globalThis.fetch` is replaced with a fake that hands back
 * whatever headers each case needs.
 *
 * Run: node scripts/openreview_rate_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openreviewFetch,
  recordUnverified,
  getUnverified,
  clearUnverified,
  retryUnverified,
  rateState,
  __resetForTests,
} from '../lib/openreview.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}

const realFetch = globalThis.fetch;
/** A fake response carrying whatever the server would say about the budget. */
const fake = ({ status = 200, remaining = 19, limit = 20, reset = 60 } = {}) => {
  const h = new Map([
    ['ratelimit-remaining', String(remaining)],
    ['ratelimit-limit', String(limit)],
    ['ratelimit-reset', String(reset)],
  ]);
  return { status, ok: status < 400, headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, json: async () => ({}) };
};

/* --------------------------------------- it does not slow a healthy crawl -- */
{
  __resetForTests();
  globalThis.fetch = async () => fake({ remaining: 19 });
  const t0 = Date.now();
  for (let i = 0; i < 8; i++) await openreviewFetch('https://api2.openreview.net/x');
  const took = Date.now() - t0;
  check('8 requests with budget to spare add no delay', took < 250, `${took}ms`);
}

/* ------------------------------------------- it waits when the budget is up */
{
  __resetForTests();
  // Server says: nothing left, window resets in 0.4s.
  globalThis.fetch = async () => fake({ remaining: 0, reset: 0.4 });
  await openreviewFetch('https://api2.openreview.net/x'); // learns the state
  const t0 = Date.now();
  await openreviewFetch('https://api2.openreview.net/x'); // must wait for reset
  const took = Date.now() - t0;
  check('an exhausted budget makes the next request wait', took >= 350, `${took}ms`);
  check('...and it waits about as long as told, not longer', took < 1500, `${took}ms`);
}

/* ---------------------------------------------------- a 429 is believed ---- */
{
  __resetForTests();
  // Headers claim room, but the server 429s anyway — the server wins.
  globalThis.fetch = async () => fake({ status: 429, remaining: 15, reset: 0.3 });
  await openreviewFetch('https://api2.openreview.net/x');
  check('a 429 zeroes the budget even when headers claim room', rateState().remaining === 0,
    String(rateState().remaining));
}

/* ------------------------------------------------------- headroom is kept -- */
{
  __resetForTests({ remaining: 1, resetAt: Date.now() + 400, limit: 20, windowMs: 60_000 });
  globalThis.fetch = async () => fake({ remaining: 19 });
  const t0 = Date.now();
  await openreviewFetch('https://api2.openreview.net/x');
  check('the last token is never spent — it waits instead', Date.now() - t0 >= 350,
    'spending it is what produces the 429 the next caller sees');
}

/* ------------------------------------------------- requests are serialised - */
{
  __resetForTests();
  let inFlight = 0;
  let maxInFlight = 0;
  globalThis.fetch = async () => {
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight--;
    return fake({ remaining: 19 });
  };
  await Promise.all(Array.from({ length: 6 }, () => openreviewFetch('https://api2.openreview.net/x')));
  check('concurrent callers cannot race past the gate', maxInFlight === 1, `${maxInFlight} in flight`);
}

/* ------------------------------------- a failed request does not wedge it -- */
{
  __resetForTests();
  let n = 0;
  globalThis.fetch = async () => {
    if (++n === 1) throw new Error('network down');
    return fake({ remaining: 19 });
  };
  await openreviewFetch('https://api2.openreview.net/x').catch(() => {});
  const after = await openreviewFetch('https://api2.openreview.net/x');
  check('one failed request does not block every later one', after.status === 200,
    'the queue must survive a rejection');
}

/* ------------------------------------------------- unverified is recorded -- */
{
  __resetForTests();
  check('nothing is recorded on a clean run', getUnverified().length === 0);
  recordUnverified('NeurIPS.cc/2026/Workshop/FLMSec/', 'group lookup: HTTP 429 after retries');
  const u = getUnverified();
  check('a throttled venue is recorded, not silently dropped', u.length === 1);
  check('...with the id and the reason', /FLMSec/.test(u[0].id) && /429/.test(u[0].reason));
}

/* ------------------------------------------- unverified is retried, once -- */
{
  // Discovery has had a second pass since its first 429s; every other job
  // recorded its failures and dropped them at process exit, which is how a
  // throttled lookup stayed indistinguishable from a venue with nothing to say.
  __resetForTests();
  clearUnverified();
  recordUnverified('a', 'group lookup: HTTP 429');
  recordUnverified('b', 'group lookup: HTTP 429');
  const tried = [];
  const left = await retryUnverified(async (id) => {
    tried.push(id);
    return id === 'a'; // 'a' settles on the retry, 'b' does not
  });
  check('every recorded id is retried exactly once', tried.join(',') === 'a,b', tried.join(','));
  check('an id that settles on the retry is dropped', !left.some((e) => e.id === 'a'));
  check('an id that does not settle survives, with its reason', left.length === 1 && /429/.test(left[0].reason));
  check('and the surviving id is what the list now holds', getUnverified().map((e) => e.id).join(',') === 'b');
}

{
  // A retry that fails a NEW way must not be lost, and a clean run must not
  // invent work.
  __resetForTests();
  clearUnverified();
  check('nothing recorded -> no retry attempted', (await retryUnverified(async () => { throw new Error('never'); })).length === 0);

  recordUnverified('c', 'group lookup: HTTP 429');
  const left = await retryUnverified(async () => { throw new Error('still down'); });
  check('a throwing retry keeps the entry rather than swallowing it', left.length === 1);
  check('...and says what happened on the second attempt', /still down/.test(left[0].reason), left[0].reason);
}

globalThis.fetch = realFetch;

/* ------------------------------- nothing may reach OpenReview un-paced ----- */
{
  // The limiter is worthless if a future call site bypasses it, and a bare
  // fetch is exactly how this got into trouble the first time.
  // Scoped to the FILE, not a window around the call. This check used to read a
  // ±4-line context, and every bare fetch it was meant to catch declared its URL
  // five lines up — so it passed for months while three call sites (the shared
  // fetchGroupById and both cross-check fetchers) went around the limiter and
  // spent budget it believed it still had. A guard that cannot fail on the real
  // defect is worse than none, because it reads as proof.
  const files = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => f.endsWith('.mjs'));
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8');
    // Only OpenReview traffic is rate-limited; other hosts are not this module's business.
    if (!/openreview\.net/.test(src)) continue;
    src.split('\n').forEach((line, i) => {
      if (/\bfetch\(/.test(line) && !/openreviewFetch|globalThis\.fetch|realFetch|const fake/.test(line)) {
        offenders.push(`${f}:${i + 1}`);
      }
    });
  }
  check('no script fetches OpenReview outside the limiter', offenders.length === 0, offenders.join(', '));
}

console.log(failed === 0 ? '\nOpenReview rate limiting OK.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
