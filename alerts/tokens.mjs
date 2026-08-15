/**
 * Signed, stateless tokens — the entire identity system for email alerts.
 *
 * There are no passwords and no sessions table. A token is
 *
 *     v1.<base64url(payloadJson)>.<base64url(hmacSha256(payloadJson, secret))>
 *
 * with payload `{ e: email, n: nonce, p: purpose, x: expiryEpochSeconds|null }`.
 *
 * Two properties do the security work:
 *
 *   1. **Purpose is signed in.** A leaked unsubscribe link can only
 *      unsubscribe; it cannot read or edit preferences. Verification demands
 *      the exact purpose the caller expects, so a token minted for one endpoint
 *      is useless at another.
 *   2. **The nonce is checked against the live row.** Every subscriber carries
 *      a random `nonce`; rotating it invalidates every token ever issued for
 *      that address at once. That is the revocation mechanism ("unlink all
 *      devices", "delete my data") — no revocation list to store.
 *
 * Implemented on WebCrypto (`crypto.subtle`) rather than node:crypto so the
 * same module runs unmodified inside the Worker and under `node` in tests.
 *
 * Purposes and their TTLs (see docs/plans/email-alerts.md §4.3):
 *   confirm  48 h    complete double opt-in only
 *   magic    15 min  exchanged once at /alerts/manage/ for a manage token
 *   manage   none    /me, /update, /sync, unsubscribe  (nonce-bound)
 *   unsub    none    unsubscribe ONLY                  (nonce-bound)
 */

export const PURPOSES = ['confirm', 'magic', 'manage', 'unsub'];

const enc = new TextEncoder();
const dec = new TextDecoder();

/* ---------------------------------------------------------------- base64url */
// btoa/atob exist in Workers and in Node ≥16, so this stays isomorphic.

function b64urlEncode(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ------------------------------------------------------------------- crypto */

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/**
 * Compare two byte arrays without leaking where they first differ. Length is
 * not secret (it is fixed at 32 bytes for SHA-256), so an early length check is
 * fine; the content comparison accumulates every byte.
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Constant-time comparison of two secret strings — used for the `ADMIN_TOKEN`
 * bearer, so the one route that can dump the whole subscriber list is compared
 * the same way signatures are. Length is not hidden (both are fixed-length
 * random tokens), but no byte position leaks through timing.
 */
export function constantTimeEqual(a, b) {
  const x = enc.encode(String(a ?? ''));
  const y = enc.encode(String(b ?? ''));
  return timingSafeEqual(x, y);
}

/** Normalize an address the one way the whole system does it: trim + lowercase. */
export function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

/** Deliberately permissive — the confirmation email is the real validator. */
export function isPlausibleEmail(email) {
  const e = normalizeEmail(email);
  return e.length >= 6 && e.length <= 254 && /^[^\s@,;:<>"']+@[^\s@.,;:<>"']+\.[^\s@.,;:<>"']{2,}$/.test(e);
}

/** 16 random bytes, hex — a subscriber's revocation handle. */
export function randomNonce(bytes = 16) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Hex SHA-256, used to store IPs as salted hashes in the rate-limit table. */
export async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(String(input)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------------- tokens */

/**
 * Build a token payload. `ttlSeconds` null means "no expiry" — correct for
 * `manage` and `unsub`, which are revoked by rotating the subscriber's nonce
 * instead.
 */
export function tokenPayload({ email, nonce, purpose, ttlSeconds = null, nowS = null }) {
  if (!PURPOSES.includes(purpose)) throw new Error(`unknown token purpose: ${purpose}`);
  const issued = nowS ?? Math.floor(Date.now() / 1000);
  return {
    e: normalizeEmail(email),
    n: String(nonce),
    p: purpose,
    x: ttlSeconds == null ? null : issued + ttlSeconds,
  };
}

/** Sign a payload produced by tokenPayload() with the shared secret. */
export async function encodeToken(payload, secret) {
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  return `v1.${body}.${b64urlEncode(sig)}`;
}

/** Mint + sign in one step — what every call site actually wants. */
export async function mintToken(opts, secret) {
  return encodeToken(tokenPayload(opts), secret);
}

/**
 * Verify a token. Returns the payload, or throws with a short machine-readable
 * reason. Callers must still compare `payload.n` with the subscriber's current
 * nonce (pass `nonce` to have it done here) — the signature alone proves the
 * token was issued by us, not that it is still valid for this account.
 *
 * `purpose` may be a string or an array (the /me endpoint accepts both `manage`
 * and a one-shot `magic`).
 */
export async function verifyToken(token, secret, { purpose, nonce = null, nowS = null } = {}) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('malformed');

  const [, body, sig] = parts;
  const key = await hmacKey(secret);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));

  let given;
  try {
    given = b64urlDecode(sig);
  } catch {
    throw new Error('malformed');
  }
  if (!timingSafeEqual(expected, given)) throw new Error('bad_signature');

  let payload;
  try {
    payload = JSON.parse(dec.decode(b64urlDecode(body)));
  } catch {
    throw new Error('malformed');
  }

  const want = purpose == null ? PURPOSES : [].concat(purpose);
  if (!want.includes(payload.p)) throw new Error('wrong_purpose');

  const now = nowS ?? Math.floor(Date.now() / 1000);
  if (payload.x != null && now >= payload.x) throw new Error('expired');

  // Nonce rotation is the revocation mechanism: a token minted before the
  // rotation still verifies cryptographically but no longer names this account.
  if (nonce != null && String(nonce) !== String(payload.n)) throw new Error('revoked');

  return payload;
}
