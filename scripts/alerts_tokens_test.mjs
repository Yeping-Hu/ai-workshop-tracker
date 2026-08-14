#!/usr/bin/env node
/**
 * Tests for alerts/tokens.mjs — the entire identity system for email alerts.
 *
 * There is no password and no session store, so these five properties are what
 * stands between a subscriber's preferences and anyone who gets hold of a link:
 * round-trip integrity, expiry, purpose isolation (an unsubscribe link must not
 * be able to read or edit prefs), nonce-rotation revocation, and tamper
 * detection on both halves of the token.
 *
 * Pure logic — no network. Run: node scripts/alerts_tokens_test.mjs
 */
import {
  mintToken,
  verifyToken,
  normalizeEmail,
  isPlausibleEmail,
  randomNonce,
  sha256Hex,
} from '../alerts/tokens.mjs';
import { CONFIRM_TTL_S, MAGIC_TTL_S } from '../alerts/config.mjs';

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}

/** Assert a verify() call rejects, and with the expected reason. */
async function rejects(label, promise, reason) {
  try {
    await promise;
    check(label, false, 'resolved, expected a rejection');
  } catch (err) {
    check(label, err.message === reason, `got "${err.message}", expected "${reason}"`);
  }
}

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const OTHER_SECRET = 'a-different-secret-value-entirely-0000000000';
const NOW = 1_780_000_000; // fixed epoch seconds so expiry tests are deterministic
const EMAIL = 'Someone@Example.COM';
const NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

/* -------------------------------------------------------- round trip + shape */
{
  const t = await mintToken({ email: EMAIL, nonce: NONCE, purpose: 'manage', nowS: NOW }, SECRET);
  check('token has the v1.<payload>.<sig> shape', /^v1\.[\w-]+\.[\w-]+$/.test(t), t.slice(0, 24));

  const p = await verifyToken(t, SECRET, { purpose: 'manage', nonce: NONCE, nowS: NOW });
  check('round-trips the email, normalized', p.e === 'someone@example.com', p.e);
  check('round-trips the nonce', p.n === NONCE);
  check('round-trips the purpose', p.p === 'manage');
  check('manage tokens carry no expiry', p.x === null, String(p.x));
}

/* ------------------------------------------------------------------- expiry */
{
  const confirm = await mintToken(
    { email: EMAIL, nonce: NONCE, purpose: 'confirm', ttlSeconds: CONFIRM_TTL_S, nowS: NOW },
    SECRET,
  );
  const justInside = NOW + CONFIRM_TTL_S - 1;
  const p = await verifyToken(confirm, SECRET, { purpose: 'confirm', nowS: justInside });
  check('confirm token valid one second before expiry', p.p === 'confirm');
  await rejects(
    'confirm token rejected at its expiry instant',
    verifyToken(confirm, SECRET, { purpose: 'confirm', nowS: NOW + CONFIRM_TTL_S }),
    'expired',
  );

  const magic = await mintToken(
    { email: EMAIL, nonce: NONCE, purpose: 'magic', ttlSeconds: MAGIC_TTL_S, nowS: NOW },
    SECRET,
  );
  await rejects(
    'magic token rejected 16 minutes later',
    verifyToken(magic, SECRET, { purpose: 'magic', nowS: NOW + 16 * 60 }),
    'expired',
  );
}

/* --------------------------------------------------------- purpose isolation */
// The load-bearing case: a leaked unsubscribe link (they travel in email
// headers and get clicked by scanners) must not be able to read or edit prefs.
{
  const unsub = await mintToken({ email: EMAIL, nonce: NONCE, purpose: 'unsub', nowS: NOW }, SECRET);
  await rejects(
    'unsub token rejected at a manage-only endpoint',
    verifyToken(unsub, SECRET, { purpose: 'manage', nonce: NONCE, nowS: NOW }),
    'wrong_purpose',
  );
  const okUnsub = await verifyToken(unsub, SECRET, { purpose: ['unsub', 'manage'], nonce: NONCE, nowS: NOW });
  check('unsub token accepted where unsub is allowed', okUnsub.p === 'unsub');

  const confirm = await mintToken(
    { email: EMAIL, nonce: NONCE, purpose: 'confirm', ttlSeconds: CONFIRM_TTL_S, nowS: NOW },
    SECRET,
  );
  await rejects(
    'confirm token cannot be used as a manage session',
    verifyToken(confirm, SECRET, { purpose: 'manage', nonce: NONCE, nowS: NOW }),
    'wrong_purpose',
  );
}

/* ------------------------------------------------------- nonce = revocation */
{
  const t = await mintToken({ email: EMAIL, nonce: NONCE, purpose: 'manage', nowS: NOW }, SECRET);
  await rejects(
    'rotating the nonce revokes an already-issued token',
    verifyToken(t, SECRET, { purpose: 'manage', nonce: randomNonce(), nowS: NOW }),
    'revoked',
  );
  // Signature-only verification still passes — which is exactly why the caller
  // must always pass the row's current nonce.
  const p = await verifyToken(t, SECRET, { purpose: 'manage', nowS: NOW });
  check('signature alone still verifies without the nonce check', p.n === NONCE);
}

/* -------------------------------------------------------------- tampering */
{
  const t = await mintToken({ email: EMAIL, nonce: NONCE, purpose: 'unsub', nowS: NOW }, SECRET);
  const [v, body, sig] = t.split('.');

  // Swap the payload for one claiming a different address, keeping the old sig.
  const forgedBody = Buffer.from(
    JSON.stringify({ e: 'victim@example.com', n: NONCE, p: 'unsub', x: null }),
  ).toString('base64url');
  await rejects(
    'a swapped payload fails the signature check',
    verifyToken(`${v}.${forgedBody}.${sig}`, SECRET, { purpose: 'unsub', nowS: NOW }),
    'bad_signature',
  );

  // Mutate the FIRST signature character, not the last: a 32-byte HMAC encodes
  // to 43 base64url chars, of which the final one carries only 2 significant
  // bits — several distinct trailing characters decode to identical bytes, so
  // flipping it is a genuine no-op rather than a missed forgery.
  const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
  await rejects(
    'a mutated signature is rejected',
    verifyToken(`${v}.${body}.${flipped}`, SECRET, { purpose: 'unsub', nowS: NOW }),
    'bad_signature',
  );

  await rejects(
    'a token signed with another secret is rejected',
    verifyToken(t, OTHER_SECRET, { purpose: 'unsub', nowS: NOW }),
    'bad_signature',
  );

  for (const junk of ['', 'not-a-token', 'v1.only-two', 'v2.aaa.bbb']) {
    await rejects(`malformed input rejected: ${JSON.stringify(junk)}`,
      verifyToken(junk, SECRET, { purpose: 'unsub', nowS: NOW }), 'malformed');
  }
}

/* ------------------------------------------------------- email + nonce utils */
{
  check('email normalization trims and lowercases', normalizeEmail('  A@B.Co  ') === 'a@b.co');
  check('plausible email accepted', isPlausibleEmail('someone@example.com'));
  check('address with no dot in the domain rejected', !isPlausibleEmail('someone@localhost'));
  check('address with a space rejected', !isPlausibleEmail('some one@example.com'));
  check('address with no @ rejected', !isPlausibleEmail('example.com'));
  check('empty address rejected', !isPlausibleEmail(''));

  const n1 = randomNonce();
  const n2 = randomNonce();
  check('nonce is 32 hex chars', /^[0-9a-f]{32}$/.test(n1), n1);
  check('two nonces differ', n1 !== n2);

  const h = await sha256Hex('203.0.113.7|salt');
  check('sha256Hex returns 64 hex chars', /^[0-9a-f]{64}$/.test(h), h);
  check('sha256Hex is stable', h === (await sha256Hex('203.0.113.7|salt')));
}

console.log(failed === 0 ? '\nToken logic OK.' : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
