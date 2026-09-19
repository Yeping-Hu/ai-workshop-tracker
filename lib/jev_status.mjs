/**
 * The status line a Jev-calling job leaves for its workflow — split from
 * lib/jev.mjs so that file stays free of `node:fs` and can be bundled into the
 * alerts Worker (the /match endpoint asks Jev too). Same rule as
 * lib/identity.mjs: anything the Worker imports reaches for no filesystem.
 *
 * Why the line exists at all: askJev() returning null keeps every job green,
 * which is right, but it makes a failure invisible — the `::warning::` lives
 * inside a run nobody opens — and the two failures that do not heal themselves,
 * a revoked key and an exhausted balance, need a person. discover.yml and
 * series-audit.yml read this file after the run and open (or close) the
 * "Jev did not answer" data-health issue.
 */
import fs from 'node:fs';
import { jevUsage } from './jev.mjs';

/**
 * Append one JSON line — job, request and failure counts, the last error — to
 * $JEV_STATUS when it is set. Nothing is written when nothing was asked (no
 * key, or nothing to judge), so a fork's run leaves no trace. Discovery runs
 * its cycles as separate processes, so lines accumulate and the workflow sums.
 */
export function recordJevStatus(job, env = process.env) {
  const file = env.JEV_STATUS;
  const u = jevUsage();
  if (!file || (!u.requests && !u.failures)) return;
  fs.appendFileSync(file, JSON.stringify({ job, requests: u.requests, failures: u.failures, error: u.lastError }) + '\n');
}
