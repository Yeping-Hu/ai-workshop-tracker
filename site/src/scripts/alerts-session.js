/**
 * The one place that turns a link from an email into a linked device, and the
 * one place that answers "is this browser signed in?".
 *
 * Loaded by Base.astro on every page and self-initialising, so **any** page can
 * be a landing page for a sign-in link. That is what lets the sign-in email
 * point at /saved/ — the list someone actually came back for — rather than at a
 * preferences form.
 *
 * WHY THIS IS ONE MODULE. The exchange used to live in /alerts/manage/ and a
 * near-copy in /alerts/confirmed/. Adding /saved/ would have been a third. A
 * second copy of shared logic is precisely how the saved-list merge lost its
 * upload half: the fix went to one of them and nobody noticed the other. So the
 * rule here is that exactly one module reads `#t=` and writes the token, and a
 * test asserts that stays true.
 *
 * TOKENS TRAVEL IN THE FRAGMENT. Everything after `#` is never sent to a
 * server, so a token cannot end up in an access log, a Referer header or an
 * analytics hit. It is cleared from the address bar the instant it is read, so
 * it also cannot survive in a bookmark or a shared screenshot.
 */

const TOKEN_KEY = 'awt-alerts-token';
const EMAIL_KEY = 'awt-alerts-email';

const api = () => document.querySelector('meta[name="alerts-api"]')?.content || null;

const read = (k) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const store = (k, v) => {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
};

/** What this browser knows about the subscription. Safe to call anywhere. */
export function session() {
  const token = read(TOKEN_KEY);
  return { linked: !!token, email: read(EMAIL_KEY) || null };
}

function announce() {
  document.dispatchEvent(new CustomEvent('awt:alerts-session', { detail: session() }));
}

/** Forget this device. The subscription and the saved list are untouched. */
export function signOut() {
  store(TOKEN_KEY, null);
  store(EMAIL_KEY, null);
  announce();
}

/**
 * Consume a `#t=` fragment if there is one, then reconcile the saved list.
 *
 * A `magic` token is single-use and short-lived, so it is exchanged here for
 * the long-lived `manage` token that /me returns; a `manage` token arriving
 * directly (the confirmation redirect) is simply stored.
 *
 * Resolves to the resulting session either way, so a landing page can report
 * what happened without repeating any of this.
 */
export async function adoptFromUrl() {
  const base = api();
  const params = new URLSearchParams((location.hash || '').replace(/^#/, ''));
  const token = params.get('t');
  const email = params.get('e');

  // Clear it before any await: a slow network must not leave the token sitting
  // in the address bar while the page is on screen.
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);

  if (!token || !base) return session();

  if (!store(TOKEN_KEY, token)) return { ...session(), blocked: true };
  if (email) store(EMAIL_KEY, email);
  announce();

  try {
    const res = await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      const me = await res.json();
      // A one-shot magic token is spent now; keep the durable one instead.
      if (me.manage_token) store(TOKEN_KEY, me.manage_token);
      if (me.email) store(EMAIL_KEY, me.email);
      announce();
    } else if (res.status === 401) {
      // Expired or already used. Leaving a dead token behind would make every
      // page claim to be signed in while nothing worked.
      signOut();
      return { ...session(), expired: true };
    }
  } catch {
    /* offline — the token is stored and the next page load will reconcile */
  }

  // favorites.js owns the saved list; reconcile now so the landing page shows
  // the merged result rather than whatever this device happened to hold.
  try {
    await window.awtFavsSync?.();
  } catch {}

  return session();
}

if (!window.__awtAlertsSessionInit) {
  window.__awtAlertsSessionInit = true;
  window.awtAlertsSession = session;
  window.awtAlertsSignOut = signOut;

  // Announce immediately, before anything else happens.
  //
  // This module is a bundled <script src>, so it is deferred and runs AFTER the
  // inline scripts that consume it. Those inline scripts therefore paint once
  // with `window.awtAlertsSession` still undefined — i.e. as signed out — and
  // will never correct themselves unless told. Announcing here is what tells
  // them, and it has to happen whether or not there is a token to adopt: a
  // page loaded with no `#t=` fragment is the *normal* case, and it was the
  // one that silently stayed signed out.
  announce();

  // Landing pages await this to report a result; every other page just lets it
  // run, which is a no-op without a fragment. It announces again when the
  // exchange changes anything.
  //
  // Base.astro has already put a promise on `window.awtAlertsAdopt` from an
  // inline <head> script, because this module is deferred and every inline
  // consumer runs first — see ALERTS_BOOTSTRAP there for the whole story. So
  // *resolve* that one rather than only overwriting it: a consumer that already
  // captured it is holding the bootstrap's promise, and reassigning would leave
  // it waiting on the 3s fallback. Resolving a promise with a promise chains
  // them, so `await window.awtAlertsAdopt` still yields the session either way.
  //
  // The assignment stays for the case where the bootstrap did not run at all
  // (a page rendered without Base, or alerts disabled mid-build).
  const adopted = adoptFromUrl().then((s) => {
    announce();
    return s;
  });
  window.awtAlertsAdopt = adopted;
  window.__awtAlertsAdoptResolve?.(adopted);
}
