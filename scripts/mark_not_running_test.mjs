#!/usr/bin/env node
/**
 * Pins decide() in mark_not_running.mjs — the one writer of `not_running` and
 * of `review_ack.official_list`, the two opposite verdicts on "this entry is
 * absent from the conference's official list".
 *
 * The rule under test: a later verdict supersedes the earlier one, in both
 * directions, and says so. The script used to refuse instead, which failed the
 * decision workflow on exactly the change of mind the reports ask for — UniReps
 * 2026 was acknowledged on 2026-08-28 and had left the NeurIPS namespace by
 * 2026-08-31. validate.mjs rejects an entry holding both, so every outcome here
 * is also checked against that invariant.
 *
 * Run: node scripts/mark_not_running_test.mjs
 */
import { decide, REASONS } from './mark_not_running.mjs';

let failed = 0;
function check(label, got, expect) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(expect)})`}`);
}
const throwsWith = (fn, re) => {
  try { fn(); return false; } catch (e) { return re.test(e.message); }
};

const LIST = 'https://blog.neurips.cc/2026/08/10/announcing-the-neurips-2026-workshops/';
const TODAY = '2026-09-04';
const base = { name: 'UniReps', conference: 'neurips', year: 2026, submission_deadline: '2026-09-25 22:00', timezone: 'UTC' };
const run = (raw, opts) => decide(raw, { slug: 'neurips-2026-unireps', listUrl: LIST, today: TODAY, ...opts });
const exclusive = (raw) => !(raw.not_running && raw.review_ack?.official_list);

/* ------------------------------------------------------------ marking */
{
  const r = run(base, { reason: 'not_on_official_list', note: 'Runs independently in Paris.' });
  check('marks with reason, date and the configured list as source',
    r.raw.not_running, { reason: 'not_on_official_list', recorded: TODAY, source: LIST, note: 'Runs independently in Paris.' });
  check('the deadline is left as the record of what was observed', r.raw.submission_deadline, base.submission_deadline);
  check('the input is not mutated', base.not_running, undefined);
  check('no warning when a list is configured', r.warning, null);

  const explicit = run(base, { reason: 'cancelled', source: 'https://example.org/announcement' });
  check('an explicit source wins over the list', explicit.raw.not_running.source, 'https://example.org/announcement');
  check('a reason that is not about the list records no source by default',
    run(base, { reason: 'withdrawn' }).raw.not_running.source, undefined);

  const noList = run(base, { reason: 'not_on_official_list', listUrl: null });
  check('no list and no source -> still marks, but warns', [!!noList.raw.not_running, /no official list/.test(noList.warning)], [true, true]);

  const again = run(r.raw, { reason: 'not_on_official_list' });
  check('the same verdict twice is a no-op', [again.noop, again.raw.not_running.recorded], [true, TODAY]);
  check('a different reason re-marks', run(r.raw, { reason: 'cancelled' }).raw.not_running.reason, 'cancelled');
  check('an unknown reason is refused', throwsWith(() => run(base, { reason: 'rejected' }), /must be one of/), true);
  check('...and the vocabulary is the documented one', REASONS, ['not_on_official_list', 'withdrawn', 'cancelled']);
}

/* --------------------------------------------- marking supersedes an ack */
{
  const acked = { ...base, review_ack: { official_list: LIST } };
  const r = run(acked, { reason: 'not_on_official_list', note: 'Moved to its own OpenReview namespace.' });
  check('marking an acknowledged entry drops the acknowledgement', r.raw.review_ack, undefined);
  check('...and marks it', r.raw.not_running?.reason, 'not_on_official_list');
  check('...saying so', /supersedes the acknowledgement/.test(r.summary), true);
  check('...never leaving both verdicts on the entry', exclusive(r.raw), true);

  // Other acknowledgements are about other questions and are kept.
  const withName = { ...base, review_ack: { official_list: LIST, name: 'Some Declined Title' } };
  check('a declined name survives the marking',
    run(withName, { reason: 'not_on_official_list' }).raw.review_ack, { name: 'Some Declined Title' });
}

/* ---------------------------------------------------- acknowledging */
{
  const r = run(base, { ack: true });
  check('acknowledges against the configured list', r.raw.review_ack, { official_list: LIST });
  check('an explicit source wins', run(base, { ack: true, source: 'https://example.org/list' }).raw.review_ack.official_list, 'https://example.org/list');
  check('no list and no source -> refused, with the fix named',
    throwsWith(() => run(base, { ack: true, listUrl: null }), /workshop_list_url/), true);

  // ...and supersedes a marking.
  const marked = { ...base, not_running: { reason: 'not_on_official_list', recorded: '2026-08-28', source: LIST } };
  const back = run(marked, { ack: true });
  check('acknowledging a marked entry unmarks it', back.raw.not_running, undefined);
  check('...and records the acknowledgement', back.raw.review_ack, { official_list: LIST });
  check('...saying which marking it replaced', /supersedes the not-running marking \(not_on_official_list, recorded 2026-08-28\)/.test(back.summary), true);
  check('...never leaving both verdicts on the entry', exclusive(back.raw), true);
}

/* --------------------------------------------------------- unmarking */
{
  const marked = { ...base, not_running: { reason: 'cancelled', recorded: '2026-08-28' } };
  check('unmark removes the marking', run(marked, { unmark: true }).raw.not_running, undefined);
  check('unmarking an unmarked entry is refused', throwsWith(() => run(base, { unmark: true }), /not marked/), true);
}

/* ------------------------------------------------- exactly one verdict */
{
  check('no verdict is refused', throwsWith(() => run(base, {}), /exactly one/), true);
  check('two verdicts are refused', throwsWith(() => run(base, { ack: true, unmark: true }), /exactly one/), true);
}

console.log(failed === 0 ? '\nOfficial-list decisions OK.' : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
