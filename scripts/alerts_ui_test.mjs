/**
 * Headless UI tests for the alerts signup box's *sent* state.
 *
 * Run a build with the alerts vars set, serve it, then:
 *   PUBLIC_ALERTS_API=https://alerts.example.invalid \
 *   PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA npm run build --prefix site
 *   node scripts/alerts_ui_test.mjs [http://localhost:4321]
 *
 * Why this is a separate suite from ui_test.mjs rather than more checks inside
 * it: that one runs against the fork build, where PUBLIC_ALERTS_API is empty and
 * none of this markup exists. The two cannot share a build — ui_test.mjs clicks
 * the first `h2` on the homepage, and with alerts configured that is the signup
 * box's heading inside a collapsed <details>, which is not clickable. So the
 * workflow builds twice and points one suite at each artefact.
 *
 * What it guards: subscribing is a state change, not just a line of text. The
 * server sentence is deliberately invariant — the same words whether a
 * confirmation was sent, a sign-in link was sent, or nothing was sent at all,
 * because any variation is an account-enumeration oracle — so everything that
 * tells a subscriber what actually happened is composed on this side, and
 * nothing but a browser can check it.
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:4321';
let pass = 0, fail = 0;
const errors = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  const t = m.text();
  // The Turnstile script is aborted below on purpose; its failure is this
  // harness's doing, not the page's.
  if (m.type() === 'error' && !t.includes('net::ERR_FAILED')) errors.push(`console: ${t}`);
});

// Turnstile is third-party and would make the suite depend on a live CDN. The
// form is built to tolerate its absence (the Worker fails closed instead), so
// aborting it exercises a shape that really occurs — an ad blocker eating it.
await page.route('**challenges.cloudflare.com**', (r) => r.abort());
await page.route('**/subscribe', (r) => r.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ ok: true, message: 'Check your inbox to confirm your subscription.' }),
}));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
const box = page.locator('details.alerts-signup').first();
await box.locator('summary.alerts-summary').click();
await page.waitForTimeout(300);

console.log('— before submitting: the sender is named up front —');
// It cannot go in the reply: that sentence is also returned when a sign-in link
// was sent, and when nothing was sent at all, so "look for mail from ..." would
// be false on two of three paths. Said here it is true unconditionally.
const hint = box.locator('.alerts-hint');
check('hint names the sending address', (await hint.innerText()).includes('@'), await hint.innerText());
check('hint is visible', await hint.isVisible());
check('preference fieldsets visible', await box.locator('fieldset.alerts-cadence').first().isVisible());
check('button reads Subscribe', (await box.locator('#alertsSubmit').innerText()).trim() === 'Subscribe');
// Captured, not hard-coded: this line is marketing copy and gets rewritten. What
// must hold is that it starts on the pitch, switches to the pending message, and
// returns — pinning the words made a copy edit look like a behaviour regression.
const PITCH = (await box.locator('.alerts-summary-hint').innerText()).trim();
check('summary hint starts on the pitch',
  PITCH.length > 0 && !/inbox|confirm/i.test(PITCH), PITCH);

await box.locator('#alertsEmail').fill('tester@stanford.edu');
await box.locator('#alertsSubmit').click();
await page.waitForFunction(() => document.querySelector('#alertsStatus')?.classList.contains('is-ok'), null, { timeout: 8000 });

console.log('— after submitting: a state, not just a message —');
const status = (await box.locator('#alertsStatus').innerText()).trim();
// Without the echo a mistyped address produces exactly this green line and then
// permanent silence: the unconfirmed row is deleted when its token expires.
check('status echoes the address back', status.includes('Sent to tester@stanford.edu'), status);
check('status keeps the neutral sentence', status.includes('Check your inbox to confirm your subscription.'), status);
check('box marked data-sent', (await box.getAttribute('data-sent')) !== null);
check('email field keeps its value', (await box.locator('#alertsEmail').inputValue()) === 'tester@stanford.edu');
check('button relabelled to resend', (await box.locator('#alertsSubmit').innerText()).trim() === 'Send it again');
// Never disabled: for an unconfirmed row /subscribe re-sends, and that is the
// only in-page recovery from a typo or a mail that never arrived.
check('button stays enabled', await box.locator('#alertsSubmit').isEnabled());
check('preference fieldsets hidden', !(await box.locator('fieldset.alerts-cadence').first().isVisible()));
check('facet pickers hidden', !(await box.locator('.alerts-row details.dd').first().isVisible()));
check('pre-submit hint hidden', !(await hint.isVisible()));
check('privacy note still visible', await box.locator('.alerts-privacy').isVisible());
check('summary hint switches to check-your-inbox', (await box.locator('.alerts-summary-hint').innerText()).includes('check your inbox to confirm'));
// The submit handler resets the widget, which does not work inside a
// display:none parent — so the sent state must not hide it.
const ts = box.locator('.cf-turnstile');
check('turnstile container not hidden by the sent state',
  (await ts.count()) === 0 || (await ts.evaluate((el) => getComputedStyle(el).display !== 'none')));

console.log('— editing the address makes it a new signup again —');
await box.locator('#alertsEmail').fill('tester2@stanford.edu');
await page.waitForTimeout(150);
check('data-sent cleared', (await box.getAttribute('data-sent')) === null);
check('button back to Subscribe', (await box.locator('#alertsSubmit').innerText()).trim() === 'Subscribe');
check('fieldsets back', await box.locator('fieldset.alerts-cadence').first().isVisible());
check('summary hint back to the pitch', (await box.locator('.alerts-summary-hint').innerText()).trim() === PITCH);

console.log('— a collapsed box still says something is pending —');
// Three of the four placements render collapsed; the summary hint is the only
// line visible once it is shut, so this is what stops them reverting to a
// clean, unmet offer after someone has already signed up.
await box.locator('#alertsSubmit').click();
await page.waitForFunction(() => document.querySelector('#alertsStatus')?.classList.contains('is-ok'), null, { timeout: 8000 });
await box.locator('summary.alerts-summary').click();
await page.waitForTimeout(200);
check('summary hint survives collapse', (await box.locator('.alerts-summary-hint').innerText()).includes('check your inbox to confirm'));

check('no page/console errors during the whole run', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
