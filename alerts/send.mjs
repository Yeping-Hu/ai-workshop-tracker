/**
 * The send-time contract — everything /admin/send decides *before* a message
 * reaches the mail provider. Pure functions, so the rules are testable under
 * Node rather than only observable in production mail.
 *
 * Two responsibilities:
 *
 *   1. **Personalization.** The Action renders digests with `{{UNSUB_URL}}` and
 *      `{{MANAGE_URL}}` placeholders because it holds no HMAC secret and must
 *      never see a subscriber token. The Worker substitutes real per-recipient
 *      links here, at the last possible moment.
 *
 *   2. **The guard.** That design has one new failure mode: a template edit that
 *      introduces a placeholder the substitution doesn't know about would mail a
 *      literal `{{…}}` to every subscriber. So a message is inspected after
 *      substitution and refused if any `{{` survives, or if the unsubscribe link
 *      is missing altogether. Refused messages are reported per-message in the
 *      endpoint's normal accepted/failed response — never silently dropped, and
 *      never sent.
 *
 * The unsubscribe check is not redundant with the `{{` check: a footer deleted
 * outright leaves no placeholder behind, and bulk mail without an unsubscribe
 * link is both a Gmail/Yahoo bulk-sender violation and a broken promise to the
 * subscriber. Everything routed through /admin/send is bulk mail; the two
 * transactional templates are sent directly by the Worker and never come here.
 */

import { MANAGE_PLACEHOLDER, UNSUB_PLACEHOLDER } from './render.mjs';

/** Any surviving `{{` after substitution is an unrendered template variable. */
const LEFTOVER = /\{\{/;

/**
 * Can this recipient be mailed at all?
 *
 * `row` is the subscribers row as read at send time, or null/undefined when it
 * no longer exists. Rendering happens minutes before sending, so a subscriber
 * can unsubscribe in between — this is the check that honors it. (It is also
 * why tokens are minted here rather than in the Action: there is no row to mint
 * from once they are gone.)
 */
export function recipientState(row) {
  if (!row) return 'not_subscribed';
  if (row.suppressed_at) return 'suppressed';
  if (!row.confirmed_at) return 'unconfirmed';
  return 'ok';
}

/**
 * Substitute per-recipient links into a rendered message and verify the result
 * is safe to send.
 *
 * @returns `{ ok: true, message }` with substituted html/text and the unsub URL
 *          attached for the List-Unsubscribe headers, or `{ ok: false, error }`
 *          with a short machine-readable reason.
 */
export function personalize(message, { unsubUrl, manageUrl }) {
  if (!message || typeof message.html !== 'string' || typeof message.text !== 'string') {
    return { ok: false, error: 'malformed_message' };
  }
  if (!unsubUrl || !manageUrl) return { ok: false, error: 'missing_links' };

  // split/join rather than a regex: the URLs are data, and a `$&` in a token
  // would be interpreted as a replacement pattern by String.replace.
  const swap = (s) =>
    s.split(UNSUB_PLACEHOLDER).join(unsubUrl).split(MANAGE_PLACEHOLDER).join(manageUrl);

  const html = swap(message.html);
  const text = swap(message.text);

  if (LEFTOVER.test(html)) return { ok: false, error: 'unsubstituted_placeholder_html' };
  if (LEFTOVER.test(text)) return { ok: false, error: 'unsubstituted_placeholder_text' };

  // A missing unsubscribe link means the footer was lost, not merely unrendered.
  if (!html.includes(unsubUrl)) return { ok: false, error: 'missing_unsubscribe_html' };
  if (!text.includes(unsubUrl)) return { ok: false, error: 'missing_unsubscribe_text' };

  return {
    ok: true,
    message: { to: message.to, subject: message.subject, html, text, unsubUrl },
  };
}
