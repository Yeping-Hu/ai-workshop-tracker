/**
 * One client for TypeSafe's Jev — the model behind every typed judgment in the
 * pipeline: topic tagging when discovery creates an entry (and the retag
 * sweep), and the weekly series-identity audit. See ARCHITECTURE.md, "Typed
 * judgments from Jev".
 *
 * Plain `fetch`, no SDK. The API is one POST with a JSON body, and a dependency
 * for that would be a second copy of Node's own fetch with a changelog to
 * follow — the same reason `lib/openreview.mjs` talks to OpenReview directly.
 *
 * The contract every caller relies on:
 *
 *   - `askJev()` returns null, and never throws, when there is no judgment to
 *     be had: no `TYPESAFE_API_KEY`, an auth failure, a request the API
 *     rejected, or the service throttled or down past the retry budget. The
 *     caller then does what the pipeline did before Jev existed (the keyword
 *     table; no link). A scheduled job never goes red because Jev did — it
 *     warns once, in the Actions log, and stays green. A fork without a key
 *     behaves exactly as before the model was added.
 *   - The model is PINNED. `jev-latest` moves on every TypeSafe release, and
 *     the thresholds in the callers (`TOPIC_MIN`, `LINK_MIN`) were tuned against
 *     this version's probabilities. Move the pin deliberately, re-running the
 *     corpus and reading what changes, not by accident on a Sunday.
 *   - Input tokens are billed and output tokens are free, so the running total
 *     kept here is of input tokens; `jevUsage()` lets a job print what it spent.
 *
 * The network and the clock are injectable so `scripts/jev_client_test.mjs`
 * runs offline; the only file it touches is the status line a job leaves for
 * its workflow (recordJevStatus), and only when asked to.
 */
import fs from 'node:fs';

export const JEV_MODEL = 'jev-1.13.0';
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/** USD per million input tokens, from https://docs.typesafe.ai/models — for the log line only. */
export const JEV_USD_PER_MTOK = 0.042;

/**
 * A hung socket must not hold the `data-write` lock (AUTOMATION.md, "The data
 * jobs are serialised"). A real answer takes well under a second.
 */
const REQUEST_TIMEOUT_MS = 20_000;
/** Attempts after the first, for 429 / 529 / 5xx / network errors only. */
const RETRIES = 3;
/** `retry-after` is honoured up to this; a longer wait is a service outage, not a queue. */
const MAX_BACKOFF_MS = 30_000;

const usage = { requests: 0, input_tokens: 0, failures: 0, lastError: null };

/** What this process has spent so far, and the last reason a request failed. */
export function jevUsage() {
  return { ...usage, usd: (usage.input_tokens / 1e6) * JEV_USD_PER_MTOK };
}

/**
 * Leave one JSON line about this process in $JEV_STATUS, when set, so the
 * workflow can open — or close — the "Jev did not answer" issue after the run.
 * The fallback keeps a job green, which is right, but it makes a failure
 * invisible: the `::warning::` above lives inside a run nobody opens, and the
 * two failures that do not heal themselves — a revoked key, an exhausted
 * balance — need a person. A data-health issue is how this repo asks for one.
 * Nothing is written when nothing was asked (no key, or nothing to judge), so
 * a fork's run leaves no trace. Discovery runs its cycles as separate
 * processes, so lines accumulate and the workflow sums them.
 */
export function recordJevStatus(job, env = process.env) {
  const file = env.JEV_STATUS;
  if (!file || (!usage.requests && !usage.failures)) return;
  fs.appendFileSync(file, JSON.stringify({ job, requests: usage.requests, failures: usage.failures, error: usage.lastError }) + '\n');
}

/** One line for a job's summary, or null when nothing was asked. */
export function jevUsageLine() {
  if (!usage.requests && !usage.failures) return null;
  const u = jevUsage();
  const failed = u.failures ? `, ${u.failures} failed` : '';
  return `jev: ${u.requests} request(s)${failed}, ${u.input_tokens.toLocaleString('en-US')} input tokens (≈ $${u.usd.toFixed(4)})`;
}

export function jevAvailable(env = process.env) {
  return typeof env.TYPESAFE_API_KEY === 'string' && env.TYPESAFE_API_KEY.trim() !== '';
}

// Once per process: a run with 30 new venues and no key would otherwise print
// the same line 30 times, and the one line is what the log needs.
let warned = false;
function warnOnce(msg) {
  if (warned) return;
  warned = true;
  // `::warning::` is a GitHub Actions annotation, so the fallback is visible in
  // the run summary rather than only in a 2,000-line log — same convention the
  // discovery workflow uses from the shell.
  console.warn(`::warning::jev: ${msg} — falling back to the pre-Jev rule for this run`);
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoffMs = (attempt) => Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);

function retryAfterMs(res) {
  const raw = res.headers?.get?.('retry-after');
  const s = Number(raw);
  return Number.isFinite(s) && s > 0 ? Math.min(MAX_BACKOFF_MS, s * 1000) : null;
}

async function bodyText(res) {
  try {
    return (await res.text()).replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

/**
 * Evaluate `questions` against `state`. Returns `{ answers, model, usage }` —
 * `answers` keyed exactly as `questions` — or null when no judgment could be
 * had (see the header). The request shape is the API's own:
 * https://docs.typesafe.ai/api
 */
export async function askJev(state, questions, {
  fetchImpl = globalThis.fetch,
  env = process.env,
  sleep = defaultSleep,
  model = JEV_MODEL,
  retries = RETRIES,
} = {}) {
  if (!jevAvailable(env)) {
    warnOnce('TYPESAFE_API_KEY is not set, so no judgment was asked');
    return null;
  }
  const body = JSON.stringify({ state, model, questions });
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetchImpl(JEV_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt < retries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      usage.failures++;
      usage.lastError = `unreachable after ${retries + 1} attempts (${err?.message ?? err})`;
      warnOnce(usage.lastError);
      return null;
    }
    if (res.ok) {
      const json = await res.json();
      usage.requests++;
      usage.input_tokens += json.usage?.input_tokens ?? 0;
      return { answers: json.answers ?? {}, model: json.model ?? model, usage: json.usage ?? {} };
    }
    // 429 is the rate limit and 529 is "overloaded"; both say "retry after a
    // short delay". 5xx is the service's problem. Everything else — 401, 403,
    // 422 (a question we wrote wrong) — will not get better by asking again.
    const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
    if (retryable && attempt < retries) {
      await sleep(retryAfterMs(res) ?? backoffMs(attempt));
      continue;
    }
    usage.failures++;
    const text = await bodyText(res);
    usage.lastError = `HTTP ${res.status}${text ? ` (${text.slice(0, 200)})` : ''}`;
    warnOnce(usage.lastError);
    return null;
  }
}
