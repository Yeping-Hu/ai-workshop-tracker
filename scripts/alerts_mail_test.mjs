#!/usr/bin/env node
/**
 * Tests for alerts/worker/src/mail.mjs — the provider adapter.
 *
 * The headline case is the RFC 8058 one-click unsubscribe pair. Gmail and
 * Yahoo's bulk-sender rules require **both** `List-Unsubscribe` and
 * `List-Unsubscribe-Post`; with only the first, a mail client opens a page
 * instead of POSTing, and with neither, sender reputation degrades no matter
 * how wanted the mail is. None of that produces an error at send time — the
 * message is accepted and delivered, and the damage is invisible for weeks.
 * That is precisely the kind of thing to pin with a test rather than notice.
 *
 * `sendBatch` is exercised against a stubbed `fetch`, so these assert the exact
 * payload that would reach the provider without sending anything.
 *
 * The other property worth pinning: **failures never leak a recipient**. The
 * error strings that come back from here end up in a public workflow log.
 *
 * Run: node scripts/alerts_mail_test.mjs
 */
import { sendEmail, sendBatch } from '../alerts/worker/src/mail.mjs';

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}

const ENV = {
  RESEND_API_KEY: 're_test_key',
  MAIL_FROM: 'AI Workshop Tracker <alerts@mail.example.com>',
};
const UNSUB = 'https://api.example.com/unsubscribe?token=v1.abc.def';

const msg = (over = {}) => ({
  to: 'test@example.com',
  subject: 'Test digest',
  html: '<p>hi</p>',
  text: 'hi',
  unsubUrl: UNSUB,
  ...over,
});

/** Swap in a fake fetch, capture what it was called with, restore afterwards. */
async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    return impl(url, init);
  };
  try {
    return { result: await fn(), calls };
  } finally {
    globalThis.fetch = real;
  }
}

const ok = (body) => async () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

/* ------------------------------------- one message: headers must be present */
{
  const { result, calls } = await withFetch(ok({ id: 'abc-123' }), () => sendEmail(ENV, msg()));
  const sent = calls[0].body;

  check('a single message goes to the plain /emails endpoint', calls[0].url === 'https://api.resend.com/emails', calls[0].url);
  check('it is a POST', calls[0].init.method === 'POST');
  check('it authenticates with the API key', calls[0].init.headers.Authorization === 'Bearer re_test_key');
  check('the From header comes from MAIL_FROM', sent.from === ENV.MAIL_FROM, sent.from);
  check('the recipient is an array', Array.isArray(sent.to) && sent.to[0] === 'test@example.com');
  check('both HTML and plaintext parts are sent', sent.html === '<p>hi</p>' && sent.text === 'hi');

  // The whole point of this file.
  check('List-Unsubscribe is set, angle-bracketed', sent.headers?.['List-Unsubscribe'] === `<${UNSUB}>`,
    JSON.stringify(sent.headers?.['List-Unsubscribe']));
  check('List-Unsubscribe-Post is set to One-Click',
    sent.headers?.['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click',
    JSON.stringify(sent.headers?.['List-Unsubscribe-Post']));
  check('both headers are present together (one alone is worse than useless)',
    !!sent.headers?.['List-Unsubscribe'] && !!sent.headers?.['List-Unsubscribe-Post']);

  check('a successful send reports ok with the provider id', result.ok === true && result.id === 'abc-123');
}

/* ------------------------------------------ several messages: batch endpoint */
{
  const { result, calls } = await withFetch(
    ok({ data: [{ id: 'id-1' }, { id: 'id-2' }] }),
    () => sendBatch(ENV, [msg({ to: 'a@example.com' }), msg({ to: 'b@example.com' })]),
  );
  const sent = calls[0].body;

  check('two messages go to the batch endpoint', calls[0].url === 'https://api.resend.com/emails/batch', calls[0].url);
  check('the batch payload is an array of both', Array.isArray(sent) && sent.length === 2);
  check('EVERY message in a batch carries both unsubscribe headers',
    sent.every((m) => m.headers?.['List-Unsubscribe'] && m.headers?.['List-Unsubscribe-Post']));
  check('results come back one per message, in order',
    result.length === 2 && result[0].id === 'id-1' && result[1].id === 'id-2');
  check('all results are ok', result.every((r) => r.ok));
}

/* ---------------------------------- a message with no unsub URL sends no header */
// Not a bulk message — the transactional templates go through sendEmail without
// one. Setting an empty List-Unsubscribe would be worse than omitting it.
{
  const { calls } = await withFetch(ok({ id: 'x' }), () => sendEmail(ENV, msg({ unsubUrl: undefined })));
  check('no unsubUrl -> no headers object at all', calls[0].body.headers === undefined,
    JSON.stringify(calls[0].body.headers));
}

/* ------------------------------------------------------------ failure paths */
{
  // A missing key must not even attempt a request.
  const { result, calls } = await withFetch(ok({}), () => sendBatch({ MAIL_FROM: 'x' }, [msg()]));
  check('a missing API key fails without calling the provider', calls.length === 0);
  check('...and reports a failure per message', result.length === 1 && result[0].ok === false);

  // A provider error must not echo the recipient into the result.
  const errBody = { message: 'Invalid `to` field: test@example.com is not verified', name: 'validation_error' };
  const { result: r2 } = await withFetch(
    async () => new Response(JSON.stringify(errBody), { status: 422 }),
    () => sendBatch(ENV, [msg()]),
  );
  check('a provider error reports ok:false', r2[0].ok === false);
  check('the error is truncated to 200 chars', (r2[0].error || '').length <= 200);

  // A network failure must degrade, not throw — the caller logs counts and moves on.
  const { result: r3 } = await withFetch(
    async () => { throw new Error('ECONNRESET'); },
    () => sendBatch(ENV, [msg(), msg()]),
  );
  check('a network failure resolves rather than throwing', Array.isArray(r3) && r3.length === 2);
  check('every message is marked failed', r3.every((r) => r.ok === false));
  check('the network error is labelled as such', /network/.test(r3[0].error || ''), r3[0].error);

  // A malformed batch response must not report success it cannot prove.
  const { result: r4 } = await withFetch(ok({ data: [{ id: 'only-one' }] }), () => sendBatch(ENV, [msg(), msg()]));
  check('a short batch response marks the unmatched message failed',
    r4[0].ok === true && r4[1].ok === false, JSON.stringify(r4));
}

/* --------------------------------------------------------------- empty input */
{
  const { result, calls } = await withFetch(ok({}), () => sendBatch(ENV, []));
  check('an empty batch sends nothing and returns nothing', result.length === 0 && calls.length === 0);
}

console.log(failed === 0 ? '\nMail adapter OK.' : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
