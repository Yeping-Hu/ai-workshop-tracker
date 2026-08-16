#!/usr/bin/env node
/**
 * Structural checks on the alerts session — the rules that keep a sign-in link
 * working from any page without the logic being copied into each one.
 *
 * These are source-level, in the spirit of scripts/imports_test.mjs, because
 * the behaviour lives in the DOM and cannot be exercised under node. What they
 * protect is not a computation but an *arrangement*, and the arrangement is the
 * thing that broke before: the saved-list merge existed in two places, the fix
 * went to one, and the other silently kept the old behaviour for days.
 *
 * Run: node scripts/alerts_session_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site', 'src');
const SESSION = 'scripts/alerts-session.js';

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}

/** Every .astro/.js file under site/src, as [relativePath, contents]. */
function sources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(astro|js|ts)$/.test(entry.name)) out.push([path.relative(SITE, full), fs.readFileSync(full, 'utf8')]);
    }
  };
  walk(SITE);
  return out;
}

const files = sources();
const session = files.find(([f]) => f === SESSION);

/* ------------------------------------------------- exactly one owner ------ */
{
  check('the session module exists', !!session, SESSION);

  // Writing the token is what "links this device" means. Reading it is fine
  // anywhere — favorites.js and the manage page both need it to call the API —
  // but more than one *writer* is how the rule drifts out of step.
  const WRITE = /(?:setItem|removeItem|store)\(\s*(?:TOKEN_KEY|['"]awt-alerts-token['"])/;
  const writers = files.filter(([f, src]) => f !== SESSION && WRITE.test(src));
  check('no module other than the session writes the token',
    writers.length === 0, writers.map(([f]) => f).join(', '));
  check('...and the session module does write it', WRITE.test(session?.[1] ?? ''));

  // Reading `#t=` is the other half: a page that parses the fragment itself is
  // a page that will forget to exchange the one-shot magic token.
  const fragReaders = files.filter(([, src]) => /location\.hash/.test(src));
  check('exactly one module reads the #t= fragment',
    fragReaders.length === 1 && fragReaders[0][0] === SESSION,
    fragReaders.map(([f]) => f).join(', ') || 'none');
}

/* --------------------------------------------- what the module must do ---- */
{
  const src = session?.[1] ?? '';
  check('it clears the fragment before any await',
    src.indexOf('history.replaceState') < src.indexOf('await fetch'),
    'a token must not sit in the address bar while the network is slow');
  check('it exchanges a one-shot magic token for the durable one',
    /me\.manage_token/.test(src));
  check('it unlinks on a 401 rather than leaving a dead token',
    /401[\s\S]{0,200}signOut\(\)/.test(src));
  check('it reconciles the saved list after linking', /awtFavsSync/.test(src));
  check('it announces changes so blocks can repaint', /awt:alerts-session/.test(src));
  check('it is exposed for landing pages', /window\.awtAlertsAdopt/.test(src));

  // The module is deferred, so every inline consumer paints once before it
  // exists — as signed out. Unless it announces on init, a signed-in visitor
  // stays looking signed out on every page that has no `#t=` fragment, which
  // is every page after the first.
  const init = src.slice(src.indexOf('__awtAlertsSessionInit'));
  check('it announces on init, not only when adopting a token',
    /announce\(\);/.test(init.slice(0, init.indexOf('awtAlertsAdopt'))),
    'a deferred module must tell inline scripts the real state');
}

/* ------------------------------------------- consumers use it, not localStorage */
{
  for (const page of ['pages/alerts/manage.astro', 'pages/alerts/confirmed.astro', 'pages/saved.astro']) {
    const src = files.find(([f]) => f === page)?.[1] ?? '';
    check(`${page} defers to the shared module`, /awtAlertsAdopt|awtAlertsSession/.test(src));
  }
  const signup = files.find(([f]) => f === 'components/AlertsSignup.astro')?.[1] ?? '';
  check('the signup block reacts to session state', /awt:alerts-session/.test(signup));
  check('...and hides itself when linked', /box\.hidden = s\.linked/.test(signup));
}

/* ------------------------------------------------ the two link types differ */
{
  const worker = fs.readFileSync(path.join(ROOT, 'alerts', 'worker', 'src', 'index.mjs'), 'utf8');
  const magic = (worker.match(/\/saved\/#t=/g) || []).length;
  const manage = (worker.match(/\/alerts\/manage\/#t=/g) || []).length;
  // Sign-in links go where someone signing in wants to be; the digest footer's
  // "Manage preferences" link must still open the preferences form.
  check('both sign-in links land on the saved list', magic === 2, String(magic));
  check('the digest footer still links to the preferences page', manage === 1, String(manage));
}

console.log(failed === 0 ? '\nAlerts session arrangement OK.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
