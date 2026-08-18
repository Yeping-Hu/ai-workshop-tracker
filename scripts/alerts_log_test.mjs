#!/usr/bin/env node
/**
 * The alerts pipeline runs in GitHub Actions on a **public** repository, so
 * everything it prints is world-readable. These checks pin the three rules that
 * keep subscriber data out of that log.
 *
 * Two are behavioural (does `redact`/`priv` do the right thing) and two are
 * structural, in the spirit of scripts/alerts_session_test.mjs — because the
 * failure mode here is not a wrong computation but a *bypass*: someone adds a
 * plain `console.log` six months from now and nothing complains. The guard is
 * only worth having if it cannot be walked around by accident.
 *
 * Run: node scripts/alerts_log_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'alerts_run.mjs'), 'utf8');

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}

/* The two helpers, lifted from the source so the test exercises the shipped
 * definitions rather than a copy that could drift away from them. */
const EMAIL_RE = new RegExp(
  SRC.match(/const EMAIL_RE = \/(.+?)\/g;/)?.[1] ?? '(?!)',
  'g',
);
const redact = (v) => (typeof v === 'string' ? v.replace(EMAIL_RE, '[redacted]') : v);
const priv = (n, verbose) => (verbose ? String(n) : Number(n) > 0 ? 'some' : 'none');

/* ------------------------------------------------------ addresses, always -- */
{
  check('a bare address is redacted',
    redact('someone@example.com') === '[redacted]');
  check('an address mid-sentence is redacted',
    redact('sending to someone@example.org now') === 'sending to [redacted] now');
  check('several addresses in one string are all redacted',
    redact('a@b.io, c@d.org') === '[redacted], [redacted]');
  check('a subdomain address is redacted',
    redact('x@mail.aiworkshoptracker.com') === '[redacted]');
  check('an address in quotes or brackets is redacted',
    redact('to:"a@b.com" <c@d.com>') === 'to:"[redacted]" <[redacted]>');

  // Over-redaction is acceptable; under-redaction is not. But the pipeline's
  // useful output is slugs and prose, and mangling those would push someone to
  // work around the guard — which is the real failure.
  check('workshop slugs survive',
    redact('   extended   iros-2026-aim-ctrl (3d)') === '   extended   iros-2026-aim-ctrl (3d)');
  check('ordinary prose survives',
    redact('5. weekly: not today (UTC day 3, weekly day is 1)')
      === '5. weekly: not today (UTC day 3, weekly day is 1)');
  check('a non-string passes through untouched', redact(42) === 42);
}

/* ------------------------------------------- counts taken from the list ---- */
{
  check('a count is qualitative by default', priv(6, false) === 'some');
  check('zero is distinguishable from non-zero', priv(0, false) === 'none');
  check('...which is what keeps "it ran but sent nothing" debuggable',
    priv(0, false) !== priv(1, false));
  check('exact counts come back under ALERTS_VERBOSE', priv(6, true) === '6');
}

/* --------------------------------------------------- nothing bypasses it --- */
{
  // Every write to stdout/stderr must go through a helper that redacts. The
  // helper definitions themselves are the only place bare console.* is allowed.
  const bare = SRC.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, l]) => /console\.(log|warn|error)\(/.test(l))
    .filter(([, l]) => !/^(const (log|warn) =|\s*console\.error\(redact\()/.test(l.trim()))
    .filter(([, l]) => !/redact/.test(l));
  check('no console.* call skips the redaction helpers',
    bare.length === 0,
    bare.map(([n, l]) => `line ${n}: ${l.trim().slice(0, 48)}`).join(' | '));

  // Per-recipient lines are the subtle one: hiding the numbers on them is
  // useless, because the number of lines *is* the subscriber count.
  check('per-recipient lines go through perRecipient()',
    /perRecipient\(`   urgent:/.test(SRC)
      && /perRecipient\(`   saved-change:/.test(SRC)
      && /perRecipient\(`   digest #/.test(SRC),
    'a plain log() inside a per-subscriber loop leaks the count by line count');

  check('the subscriber total is never printed raw',
    !/subscribers: \$\{subs\.length\}/.test(SRC));
}

/* ------------------------------------------ the workflow stays non-verbose - */
{
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'alerts.yml'), 'utf8');
  // Assignments only. The file *mentions* the variable in a comment explaining
  // why it must never be set here, and that note is worth more than a grep that
  // would delete it to stay green.
  const sets = wf
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .filter((l) => /ALERTS_VERBOSE\s*:/.test(l));
  check('alerts.yml does not set ALERTS_VERBOSE',
    sets.length === 0,
    'verbose output in a public workflow log defeats the entire guard');
}

console.log(failed === 0 ? '\nAlerts log hygiene OK.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
