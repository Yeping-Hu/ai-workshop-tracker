/**
 * The few DOM helpers every tool page shares: status lines, copying (with
 * and without formatting), downloading a generated file, reading a picked
 * file, and the one analytics event a tool sends.
 *
 * `used(slug)` fires a GoatCounter event the first time a tool produces
 * output on a page load. Pageviews say which tools are found; this says
 * which are used, which is the number that decides whether a tool stays.
 * A no-op when analytics is off (forks, previews), like every other event.
 */

export const $ = (sel, root = document) => root.querySelector(sel);

export function setStatus(el, msg, kind = '') {
  if (!el) return;
  el.textContent = msg || '';
  el.className = `tool-status${kind ? ` is-${kind}` : ''}`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

/** Copy HTML (italics kept in Word and Docs) with a plain-text fallback. */
export async function copyHtml(html, text) {
  try {
    if (window.ClipboardItem && navigator.clipboard.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        }),
      ]);
      return true;
    }
  } catch {
    // Fall back to plain text below.
  }
  return copyText(text);
}

/** Wire a button to copy something, flashing "Copied" for a moment. */
export function bindCopy(button, getPayload, { html = false } = {}) {
  if (!button) return;
  const label = button.textContent;
  button.addEventListener('click', async () => {
    const payload = getPayload();
    if (!payload) return;
    const ok = html ? await copyHtml(payload.html, payload.text) : await copyText(typeof payload === 'string' ? payload : payload.text);
    button.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => { button.textContent = label; }, 1400);
  });
}

/**
 * Save a generated file through a one-off `<a download>`. The site's link
 * handler (Base.astro) opens any link whose host differs from the page's in
 * a new tab, and a blob: URL has no host, so this anchor once ended up there
 * with the equation shown as a page; the handler now leaves download links
 * alone. The anchor stays in the document until the click has been handled.
 */
export function download(filename, content, type = 'text/plain;charset=utf-8') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 2000);
}

/**
 * Put a PNG on the clipboard. `blobPromise` is the image still being made:
 * Safari only allows a clipboard write inside the click that asked for it,
 * and a ClipboardItem built from a promise keeps that gesture alive while the
 * canvas draws (Chrome accepts the same). Browsers that want a finished Blob
 * get the second attempt. Returns false where images cannot be copied.
 */
export async function copyImage(blobPromise, mime = 'image/png') {
  if (!window.ClipboardItem || !navigator.clipboard?.write) return false;
  try {
    await navigator.clipboard.write([new ClipboardItem({ [mime]: blobPromise })]);
    return true;
  } catch {
    try {
      const blob = await blobPromise;
      if (!blob) return false;
      await navigator.clipboard.write([new ClipboardItem({ [mime]: blob })]);
      return true;
    } catch {
      return false;
    }
  }
}

/** A picked file's text, or null when nothing was picked. */
export function readFile(input) {
  const f = input && input.files && input.files[0];
  if (!f) return Promise.resolve(null);
  return f.text();
}

const usedOnce = new Set();
export function used(slug) {
  if (usedOnce.has(slug)) return;
  usedOnce.add(slug);
  try {
    window.goatcounter?.count?.({ path: `tools/${slug}/used`, title: `${slug} used`, event: true });
  } catch {
    // Analytics is optional everywhere on this site.
  }
}

export const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A safe filename stem from a title or key. */
export function fileStem(s, fallback = 'references') {
  const stem = String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
  return stem || fallback;
}
