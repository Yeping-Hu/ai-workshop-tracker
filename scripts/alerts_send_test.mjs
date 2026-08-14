#!/usr/bin/env node
/**
 * Tests for alerts/send.mjs — the send-time contract of /admin/send.
 *
 * These exist because of a specific structural risk. The Action renders emails
 * with `{{UNSUB_URL}}` / `{{MANAGE_URL}}` placeholders (it holds no HMAC secret
 * and must never see a subscriber token), and the Worker substitutes real links
 * at the last moment. That keeps tokens out of workflow logs — but it means a
 * template edit introducing an unknown placeholder, or deleting the footer,
 * would mail the mistake to every subscriber at once.
 *
 * So the guard is pinned here rather than trusted:
 *
 *   - a normal digest substitutes cleanly and passes;
 *   - any surviving `{{` in the HTML *or* the plaintext is refused;
 *   - a message with no unsubscribe link is refused even though it has no
 *     placeholder left (a deleted footer leaves nothing behind to detect);
 *   - a recipient who unsubscribed between render and send is dropped.
 *
 * Refusals are returned, not thrown: /admin/send reports them per message in
 * its normal accepted/failed response, so a bad template fails loudly and
 * partially rather than silently and completely.
 *
 * Pure logic — no network. Run: node scripts/alerts_send_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { personalize, recipientState } from '../alerts/send.mjs';
import { renderDigest, renderUrgent, UNSUB_PLACEHOLDER, MANAGE_PLACEHOLDER } from '../alerts/render.mjs';
import { normalizeSubscriber } from '../alerts/match.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ids = JSON.parse(fs.readFileSync(path.join(ROOT, 'alerts', 'ids.json'), 'utf8'));

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}

const UNSUB = 'https://api.example.com/unsubscribe?token=v1.abc.def';
const MANAGE = 'https://aiworkshoptracker.com/alerts/manage/#t=v1.ghi.jkl';
const LINKS = { unsubUrl: UNSUB, manageUrl: MANAGE };

const NOW = Date.parse('2026-08-14T00:00:00Z');
const iso = (days) => new Date(NOW + days * 86_400_000).toISOString();

const ws = (slug, over = {}) => ({
  slug,
  name: `The ${slug} Workshop`,
  acronym: slug.split('-').pop().toUpperCase(),
  conference: 'neurips',
  year: 2026,
  topics: ['llms'],
  status: 'upcoming',
  status_label: 'Open call',
  deadline_utc: iso(3),
  abstract_deadline_utc: null,
  next_stage_utc: iso(3),
  next_stage_is_abstract: false,
  website: 'https://example.com/ws',
  ...over,
});

const sub = (over = {}) =>
  normalizeSubscriber({ email: 'test@example.com', nonce: 'n', cadence: 'weekly', confirmed_at: 'x', ...over });

/** A real digest, exactly as the Action would hand it to /admin/send. */
function realDigest() {
  const workshops = { 'neurips-2026-alpha': ws('neurips-2026-alpha') };
  const mail = renderDigest({
    sub: sub(),
    events: [{ slug: 'neurips-2026-alpha', kind: 'extended', days: 4, old_utc: iso(-1), new_utc: iso(3) }],
    workshops,
    nowMs: NOW,
    ids,
  });
  return { to: 'test@example.com', subject: mail.subject, html: mail.html, text: mail.text };
}

/* ------------------------------------------------- the happy path substitutes */
{
  const msg = realDigest();
  check('the rendered digest arrives carrying placeholders', msg.html.includes(UNSUB_PLACEHOLDER));

  const out = personalize(msg, LINKS);
  check('a normal digest passes the guard', out.ok, out.error);
  check('the unsubscribe URL is substituted into the HTML', out.message.html.includes(UNSUB));
  check('the manage URL is substituted into the HTML', out.message.html.includes(MANAGE));
  check('the unsubscribe URL is substituted into the plaintext', out.message.text.includes(UNSUB));
  check('no placeholder survives in the HTML', !out.message.html.includes('{{'));
  check('no placeholder survives in the plaintext', !out.message.text.includes('{{'));
  check('the unsub URL rides along for the List-Unsubscribe headers', out.message.unsubUrl === UNSUB);
  check('the recipient and subject are preserved',
    out.message.to === 'test@example.com' && out.message.subject === msg.subject);

  // Urgent mail goes through the same path.
  const urgent = renderUrgent({ sub: sub(), items: [ws('neurips-2026-alpha')], nowMs: NOW, ids });
  const uOut = personalize({ to: 'test@example.com', subject: urgent.subject, html: urgent.html, text: urgent.text }, LINKS);
  check('an urgent alert also passes the guard', uOut.ok, uOut.error);
  check('the urgent alert gets its unsubscribe link', uOut.message.text.includes(UNSUB));
}

/* ------------------------------------------------ a leftover placeholder fails */
{
  const base = realDigest();

  const htmlLeftover = { ...base, html: base.html.replace('</p>', '</p>{{FIRST_NAME}}') };
  const r1 = personalize(htmlLeftover, LINKS);
  check('an unknown placeholder in the HTML is refused', !r1.ok && r1.error === 'unsubstituted_placeholder_html', r1.error);

  const textLeftover = { ...base, text: `${base.text}\nHello {{FIRST_NAME}}` };
  const r2 = personalize(textLeftover, LINKS);
  check('an unknown placeholder in the plaintext is refused', !r2.ok && r2.error === 'unsubstituted_placeholder_text', r2.error);

  // The exact regression the guard exists for: a placeholder misspelled in the
  // template, so substitution silently misses it.
  const typo = {
    ...base,
    html: base.html.split(UNSUB_PLACEHOLDER).join('{{UNSUB_URI}}'),
    text: base.text.split(UNSUB_PLACEHOLDER).join('{{UNSUB_URI}}'),
  };
  const r3 = personalize(typo, LINKS);
  check('a misspelled unsubscribe placeholder is refused, not mailed', !r3.ok, r3.error);
  check('...and the refusal names the HTML part first', r3.error === 'unsubstituted_placeholder_html', r3.error);
}

/* --------------------------------------------- a missing footer fails too */
{
  const base = realDigest();
  // A deleted footer leaves no placeholder behind, so the `{{` check alone
  // would pass it. Bulk mail without an unsubscribe link is a Gmail/Yahoo
  // bulk-sender violation and a broken promise to the subscriber.
  const noFooterHtml = { ...base, html: base.html.split(UNSUB_PLACEHOLDER).join('') };
  const r1 = personalize(noFooterHtml, LINKS);
  check('HTML with no unsubscribe link is refused', !r1.ok && r1.error === 'missing_unsubscribe_html', r1.error);

  const noFooterText = { ...base, text: base.text.split(UNSUB_PLACEHOLDER).join('') };
  const r2 = personalize(noFooterText, LINKS);
  check('plaintext with no unsubscribe link is refused', !r2.ok && r2.error === 'missing_unsubscribe_text', r2.error);
}

/* ------------------------------------------------------------- malformed input */
{
  check('a message with no plaintext part is refused',
    personalize({ to: 'test@example.com', subject: 's', html: '<p>hi</p>' }, LINKS).error === 'malformed_message');
  check('a null message is refused', personalize(null, LINKS).error === 'malformed_message');
  check('missing links are refused rather than substituted as "undefined"',
    personalize(realDigest(), { unsubUrl: '', manageUrl: MANAGE }).error === 'missing_links');
}

/* ----------------------------------------- URLs are data, not replace patterns */
{
  // A `$&` inside a token would be expanded by String.replace into the matched
  // text. split/join is used precisely so a token can never be reinterpreted.
  const tricky = 'https://api.example.com/unsubscribe?token=v1.a$&b.c$`d';
  const out = personalize(realDigest(), { unsubUrl: tricky, manageUrl: MANAGE });
  check('a token containing $& survives substitution byte-for-byte',
    out.ok && out.message.html.includes(tricky), out.error);
}

/* ------------------------------------------------------- recipient eligibility */
{
  const live = { email: 'test@example.com', nonce: 'n', confirmed_at: '2026-08-01T00:00:00Z', suppressed_at: null };
  check('a confirmed, unsuppressed subscriber is mailable', recipientState(live) === 'ok');
  // Unsubscribing DELETES the row, so "gone" is the shape an unsubscribe takes.
  check('a recipient who unsubscribed between render and send is dropped',
    recipientState(null) === 'not_subscribed');
  check('a hard-bounced (suppressed) recipient is dropped',
    recipientState({ ...live, suppressed_at: '2026-08-10T00:00:00Z' }) === 'suppressed');
  check('an unconfirmed recipient is dropped', recipientState({ ...live, confirmed_at: null }) === 'unconfirmed');
}

/* ------------------------- the worker actually routes through the guard */
// A source-level check, in the spirit of scripts/imports_test.mjs: the guard is
// worthless if /admin/send is refactored to substitute inline again.
{
  const worker = fs.readFileSync(path.join(ROOT, 'alerts', 'worker', 'src', 'index.mjs'), 'utf8');
  check('the worker imports the shared send contract', /import \{[^}]*personalize[^}]*\} from '\.\.\/\.\.\/send\.mjs'/.test(worker));
  check('/admin/send calls personalize()', /const built = personalize\(/.test(worker));
  check('/admin/send only forwards messages the guard accepted',
    /if \(!built\.ok\) \{[\s\S]{0,200}?results\[i\] = \{ ok: false, error: built\.error \}/.test(worker));
  check('the worker no longer substitutes placeholders inline',
    !/split\(UNSUB_PLACEHOLDER\)/.test(worker));
}

console.log(failed === 0 ? '\nSend-time contract OK.' : `\n${failed} test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
