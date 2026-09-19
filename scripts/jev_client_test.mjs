#!/usr/bin/env node
/**
 * The Jev client's contract (lib/jev.mjs): it returns null rather than
 * throwing whenever there is no judgment to be had, retries only what a retry
 * can fix, honours `retry-after`, pins the model, and keeps a usage total. All
 * offline — the network and the clock are injected.
 *
 * Run: node scripts/jev_client_test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { askJev, jevAvailable, jevUsage, jevUsageLine, recordJevStatus, JEV_MODEL, JEV_ENDPOINT } from '../lib/jev.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}

const ENV = { TYPESAFE_API_KEY: 'test-key' };
const response = (status, body = {}, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
  json: async () => body,
  text: async () => JSON.stringify(body),
});
const ANSWER = { model: 'jev-1.13.0', answers: { q: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 120, output_tokens: 3 } };

/** A fetch stub that answers from a queue and records every call. */
function stub(queue) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  return { fetchImpl, sleep, calls, sleeps };
}

const warnings = [];
const realWarn = console.warn;
console.warn = (m) => warnings.push(String(m));

/* ---------------------------------------------------------- the pin ------- */
check('the model is a versioned id, not an alias that moves',
  /^jev-\d+\.\d+\.\d+$/.test(JEV_MODEL), JEV_MODEL);
check('the endpoint is the documented evaluation endpoint',
  JEV_ENDPOINT === 'https://api.typesafe.ai/v1/systemone');

/* ------------------------------------------------------- no key -> null --- */
{
  const s = stub([]);
  const r = await askJev({ a: 1 }, { q: { type: 'noul', instructions: 'x' } }, { fetchImpl: s.fetchImpl, env: {}, sleep: s.sleep });
  check('no TYPESAFE_API_KEY returns null without touching the network', r === null && s.calls.length === 0);
  check('...and jevAvailable says so', jevAvailable({}) === false && jevAvailable({ TYPESAFE_API_KEY: ' ' }) === false && jevAvailable(ENV) === true);
}

/* ----------------------------------------------------------- happy path --- */
{
  const before = jevUsage();
  const s = stub([response(200, ANSWER)]);
  const r = await askJev({ a: 1 }, { q: { type: 'noul', instructions: 'x' } }, { fetchImpl: s.fetchImpl, env: ENV, sleep: s.sleep });
  check('a 200 yields the answers keyed as asked', r?.answers?.q?.noul === 0.9 && r.model === 'jev-1.13.0');
  const sent = JSON.parse(s.calls[0].init.body);
  check('the request carries state, questions and the PINNED model',
    sent.model === JEV_MODEL && sent.state.a === 1 && sent.questions.q.type === 'noul');
  check('the key travels as a bearer token', s.calls[0].init.headers.Authorization === 'Bearer test-key');
  check('a timeout signal is attached (a hung socket must not hold the data-write lock)',
    s.calls[0].init.signal instanceof AbortSignal);
  const after = jevUsage();
  check('usage counts the request and its input tokens',
    after.requests - before.requests === 1 && after.input_tokens - before.input_tokens === 120);
  check('the usage line prices input tokens only', /120 input tokens/.test(jevUsageLine()) && /\$0\.0000/.test(jevUsageLine()));
}

/* ----------------------------------------------------- retry semantics ---- */
{
  const s = stub([response(429, {}, { 'retry-after': '2' }), response(200, ANSWER)]);
  const r = await askJev({}, {}, { fetchImpl: s.fetchImpl, env: ENV, sleep: s.sleep });
  check('a 429 is retried after the advertised retry-after', r?.answers?.q && s.calls.length === 2 && s.sleeps[0] === 2000);
}
{
  const s = stub([response(529), response(200, ANSWER)]);
  const r = await askJev({}, {}, { fetchImpl: s.fetchImpl, env: ENV, sleep: s.sleep });
  check('a 529 (overloaded) is retried with backoff', r?.answers?.q && s.sleeps.length === 1 && s.sleeps[0] >= 1000);
}
{
  const s = stub([response(500), response(500), response(500), response(500), response(200, ANSWER)]);
  const r = await askJev({}, {}, { fetchImpl: s.fetchImpl, env: ENV, sleep: s.sleep });
  check('retries are bounded: four 5xx in a row give up as null', r === null && s.calls.length === 4);
}
{
  const s = stub([new Error('ECONNRESET'), response(200, ANSWER)]);
  const r = await askJev({}, {}, { fetchImpl: s.fetchImpl, env: ENV, sleep: s.sleep });
  check('a network error is retried', r?.answers?.q && s.calls.length === 2);
}
{
  const s = stub([new Error('ETIMEDOUT'), new Error('ETIMEDOUT'), new Error('ETIMEDOUT'), new Error('ETIMEDOUT')]);
  const r = await askJev({}, {}, { fetchImpl: s.fetchImpl, env: ENV, sleep: s.sleep });
  check('...and a dead network ends as null, never a throw', r === null && s.calls.length === 4);
}
{
  const s = stub([response(422, { detail: 'questions.q.instructions is required' }), response(200, ANSWER)]);
  const r = await askJev({}, {}, { fetchImpl: s.fetchImpl, env: ENV, sleep: s.sleep });
  check('a 422 (our question is malformed) is NOT retried and returns null', r === null && s.calls.length === 1);
}
{
  const s = stub([response(401), response(200, ANSWER)]);
  const r = await askJev({}, {}, { fetchImpl: s.fetchImpl, env: ENV, sleep: s.sleep });
  check('a 401 is not retried either', r === null && s.calls.length === 1);
  check('the last failure is kept, with its status, for the status line', /^HTTP 401/.test(jevUsage().lastError ?? ''));
}

/* ------------------------------------------------- the status line -------- */
// What the workflows read to open or close the "Jev did not answer" issue: a
// green job with a silent fallback would otherwise hide a dead key for good.
{
  const tmp = path.join(os.tmpdir(), `jev-status-${process.pid}.jsonl`);
  try { fs.unlinkSync(tmp); } catch { /* absent is the point */ }
  recordJevStatus('test', {});
  check('no JEV_STATUS in the environment, no file written', !fs.existsSync(tmp));
  recordJevStatus('test', { JEV_STATUS: tmp });
  recordJevStatus('test again', { JEV_STATUS: tmp });
  const lines = fs.readFileSync(tmp, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('each call appends one JSON line with the job, the counts and the last error',
    lines.length === 2 && lines[0].job === 'test' && lines[1].job === 'test again'
      && lines[0].requests === jevUsage().requests && lines[0].failures === jevUsage().failures && /^HTTP 401/.test(lines[0].error));
  fs.unlinkSync(tmp);
}
{
  const s = stub([response(429, {}, { 'retry-after': '3600' }), response(200, ANSWER)]);
  await askJev({}, {}, { fetchImpl: s.fetchImpl, env: ENV, sleep: s.sleep });
  check('an hour-long retry-after is capped (an outage is not a queue)', s.sleeps[0] <= 30_000);
}

/* --------------------------------------------------------- warn once ------ */
check('every failure above produced exactly one warning for the whole process',
  warnings.length === 1, `${warnings.length} warnings`);
check('...as a GitHub Actions annotation naming the fallback',
  /^::warning::jev: .*falling back/.test(warnings[0] ?? ''), warnings[0]);
console.warn = realWarn;

/* ---------------------------------------------------------- plumbing ------ */
{
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'validate.yml'), 'utf8');
  check('CI runs this test', /jev_client_test\.mjs/.test(ci), 'the workflow lists tests by hand');
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'jev.mjs'), 'utf8');
  check('the client imports no SDK — node built-ins only', !/^import .* from '(?!node:)/m.test(src));
  for (const wf of ['discover.yml', 'series-audit.yml']) {
    const text = fs.readFileSync(path.join(ROOT, '.github', 'workflows', wf), 'utf8');
    check(`${wf} collects the status line and maintains the "Jev did not answer" issue`,
      /JEV_STATUS:\s*\$\{\{\s*github\.workspace\s*\}\}/.test(text) && /Data health: Jev did not answer/.test(text));
  }
}

console.log(failed === 0 ? '\nJev client OK.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
