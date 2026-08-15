/**
 * sendEmail() — the single seam between this system and a mail provider.
 *
 * Resend is the v1 provider (decision D3) for both transactional mail and
 * digests. The abstraction exists because Resend's free tier caps at 100
 * emails/day: somewhere around 90 subscribers the maintainer either upgrades
 * ($20/mo) or swaps in SES ($0.10/1k). Everything provider-specific — auth
 * header, payload shape, batch endpoint, error parsing — is confined to the
 * adapter below so that swap is a one-file change.
 *
 * The API key lives only in the Worker. The GitHub Action that renders digests
 * never holds it and never sees a subscriber token; it posts finished messages
 * to /admin/send and this module does the rest.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const RESEND_BATCH_ENDPOINT = 'https://api.resend.com/emails/batch';

/**
 * Send one message. Used for the two transactional templates (confirm, magic
 * link), which are always singular and always urgent.
 *
 * @returns {Promise<{ok: boolean, id?: string, error?: string}>}
 */
export async function sendEmail(env, message) {
  const [result] = await sendBatch(env, [message]);
  return result;
}

/**
 * Send up to 100 messages in one provider call (we chunk at 50 upstream).
 * Returns one result per input message, in order, so the caller can log
 * `urgent_log` rows for accepted messages only — a failed send must not be
 * recorded as delivered, or the recipient silently loses that alert forever.
 *
 * Never throws: a provider outage degrades to "everything failed", which the
 * Action reports as a failed job rather than a half-written log.
 */
export async function sendBatch(env, messages) {
  if (!messages.length) return [];
  if (!env.RESEND_API_KEY) {
    return messages.map(() => ({ ok: false, error: 'RESEND_API_KEY is not configured' }));
  }

  const payload = messages.map((m) => ({
    from: env.MAIL_FROM,
    to: [m.to],
    subject: m.subject,
    html: m.html,
    text: m.text,
    // RFC 8058 one-click unsubscribe. Gmail and Yahoo require BOTH headers on
    // bulk mail; without them a sender's reputation degrades regardless of how
    // wanted the mail is. `List-Unsubscribe-Post` is what makes the mail
    // client's own "Unsubscribe" button POST directly instead of opening a page.
    headers: m.unsubUrl
      ? {
          'List-Unsubscribe': `<${m.unsubUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        }
      : undefined,
  }));

  // The batch endpoint rejects a single-element array on some plans, and a lone
  // transactional send is the common case, so route one message the plain way.
  const single = payload.length === 1;

  let res;
  try {
    res = await fetch(single ? RESEND_ENDPOINT : RESEND_BATCH_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(single ? payload[0] : payload),
    });
  } catch (err) {
    return messages.map(() => ({ ok: false, error: `network: ${err.message}` }));
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    /* a non-JSON body is only useful as "it failed" */
  }

  if (!res.ok) {
    // Provider errors quote the request back. Keep only the message so a
    // recipient address can never reach a log line (see the no-PII rule).
    const reason = body?.message || body?.name || `HTTP ${res.status}`;
    return messages.map(() => ({ ok: false, error: String(reason).slice(0, 200) }));
  }

  if (single) return [{ ok: true, id: body?.id }];

  // Batch responses come back as { data: [{id}, …] } in request order.
  const data = Array.isArray(body?.data) ? body.data : [];
  return messages.map((_, i) =>
    data[i]?.id ? { ok: true, id: data[i].id } : { ok: false, error: 'no id returned' },
  );
}

/**
 * TODO (docs/plans/email-alerts.md §12): SES adapter.
 *
 * Swapping providers means implementing this signature and pointing sendBatch
 * at it. SES needs SigV4 request signing (`aws4fetch` works in Workers) and a
 * support ticket to leave the sandbox. SES has no batch endpoint with
 * per-message HTML, so it becomes N parallel SendEmail calls — keep the same
 * "one result per message, in order" contract so no caller changes.
 */
export async function sendBatchSes() {
  throw new Error('SES adapter not implemented — see alerts/worker/src/mail.mjs');
}
