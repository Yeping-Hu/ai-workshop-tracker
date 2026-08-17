/**
 * Verifying a Cloudflare Access identity token.
 *
 * WHY THIS EXISTS AT ALL. Access already protects `/dashboard` at Cloudflare's
 * edge: an unauthenticated request gets a login screen and never reaches this
 * Worker. So this check is, today, redundant — and it is here precisely
 * because "today" is doing a lot of work in that sentence. Access protects a
 * *hostname*, not a script. Any second route to this Worker — a workers.dev
 * subdomain re-enabled by accident, another custom domain, a preview
 * deployment — would serve the dashboard with no login at all, and nothing
 * about that mistake would look like a mistake. `workers_dev = false` closes
 * the known door; this closes the ones nobody has thought of.
 *
 * It is deliberately not the HMAC scheme in alerts/tokens.mjs. Those tokens are
 * ours and symmetric; this one is issued by Cloudflare and signed RS256, so it
 * is verified against their published public keys.
 *
 * Every failure path returns null. There is no branch that returns a partial
 * result, and no `catch` that swallows an error and continues — matching
 * verifyTurnstile and verifyResendSignature, which also fail closed.
 */

const CERTS_TTL_MS = 3_600_000; // keys rotate rarely; an hour is Cloudflare's own guidance
let cache = { team: null, at: 0, keys: null };

const b64urlToBytes = (s) => {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/**
 * Cloudflare's signing keys for this team, as importable CryptoKeys.
 *
 * Cached in module scope, which on Workers means per-isolate — so a cold start
 * costs one fetch and nothing else does. A failed fetch caches nothing, or an
 * outage would lock the maintainer out for an hour.
 */
async function signingKeys(team) {
  const now = Date.now();
  if (cache.keys && cache.team === team && now - cache.at < CERTS_TTL_MS) return cache.keys;

  const res = await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  const jwks = body?.keys;
  if (!Array.isArray(jwks) || !jwks.length) return null;

  const keys = new Map();
  for (const jwk of jwks) {
    if (!jwk?.kid) continue;
    try {
      keys.set(
        jwk.kid,
        await crypto.subtle.importKey(
          'jwk',
          { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['verify'],
        ),
      );
    } catch {
      /* skip a key we cannot import rather than failing the whole set */
    }
  }
  if (!keys.size) return null;

  cache = { team, at: now, keys };
  return keys;
}

/**
 * Verify the `Cf-Access-Jwt-Assertion` header.
 *
 * Returns the claims ({ email, sub, ... }) or **null**. Callers must treat null
 * as "refuse", never as "unknown but probably fine".
 */
export async function verifyAccessJwt(request, env) {
  const team = env.ACCESS_TEAM;
  const aud = env.ACCESS_AUD;
  // Unconfigured means closed. The alternative — allowing the dashboard through
  // when the vars are missing — would mean a deploy that forgot them silently
  // publishes the numbers.
  if (!team || !aud) return null;

  const token =
    request.headers.get('Cf-Access-Jwt-Assertion') ||
    (request.headers.get('Cookie') || '').match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1];
  if (!token) return null;

  const parts = String(token).split('.');
  if (parts.length !== 3) return null;

  let header;
  let claims;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  } catch {
    return null;
  }

  // Pin the algorithm. Accepting whatever the token names is the classic JWT
  // hole — an attacker picks "none", or swaps RS256 for HS256 and signs with
  // the public key as the secret.
  if (header?.alg !== 'RS256' || !header?.kid) return null;

  const keys = await signingKeys(team);
  const key = keys?.get(header.kid);
  if (!key) return null;

  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    return null;
  }
  if (!ok) return null;

  // A valid signature only proves Cloudflare issued it. `aud` is what proves it
  // was issued for *this* application: without this check, a token minted for
  // any other Access app in any other account would be accepted here.
  const auds = [].concat(claims?.aud ?? []);
  if (!auds.includes(aud)) return null;

  const nowS = Math.floor(Date.now() / 1000);
  if (typeof claims?.exp !== 'number' || claims.exp <= nowS) return null;
  if (typeof claims?.nbf === 'number' && claims.nbf > nowS + 60) return null;
  if (claims?.iss && claims.iss !== `https://${team}.cloudflareaccess.com`) return null;

  return claims;
}
