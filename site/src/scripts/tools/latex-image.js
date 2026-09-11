/**
 * LaTeX -> SVG (MathJax, in the page) -> PNG (a canvas), for the LaTeX to
 * PNG and LaTeX to SVG pages. MathJax's tex-svg bundle is a classic script
 * the page loads from /vendor/ (see site/vendor.mjs); this module waits for
 * it, re-renders on every keystroke, and turns the rendered SVG into a
 * standalone file with explicit pixel size and colour.
 *
 * The SVG is self-contained because MathJax is configured with
 * `fontCache: 'local'`: the glyph outlines it uses are written into the
 * file's <defs>, so nothing depends on a font being installed. The PNG is
 * drawn from that same SVG at the chosen scale, so it is sharp at any size.
 *
 * The picked size and colour are set on the rendered equation, never on the
 * preview box. The box outlives every render, and an inline style on it beat
 * the placeholder's class rule in tools.css, so once anything had been typed
 * "Type some LaTeX above." kept the last equation's 24 px and its picked
 * colour. Emptying the box is the resting state and puts the page back as it
 * arrived, status line included; ui_test.mjs pins that for every tool that
 * converts as you type.
 *
 * A render is numbered and gives up after each await if a newer one has
 * started. The renderer arrives on first use, so on a cold page the first
 * render waits for the bundle; the box can be emptied in that time, and the
 * empty branch is synchronous, so the equation for text no longer in the box
 * used to land on top of the placeholder. ui_test.mjs holds the bundle back
 * to pin it.
 *
 * A failed download of the renderer is forgotten, not cached. The load's
 * promise was kept whatever its outcome, so one refused fetch (a flaky
 * connection, an ad blocker) left every later keystroke failing at once with
 * "The renderer failed to load." until a reload; the next use now appends a
 * fresh <script>, and a bundle that loaded but never produced the API is
 * forgotten the same way. ui_test.mjs refuses the bundle for one expression,
 * serves it empty for the next, and lets the third through.
 */
import { $, setStatus, download, bindCopy, copyImage, used } from './ui.js';

const form = $('#toolForm');
if (form) {
  const slug = form.dataset.slug;
  const input = $('#toolInput');
  const preview = $('#toolPreview');
  const status = $('#toolStatus');
  const size = $('#optSize');
  const color = $('#optColor');
  const bg = $('#optBg');
  const scale = $('#optScale');
  const inline = $('#optInline');
  let svgEl = null;
  let timer = null;
  let ready = false;
  // The number of the latest render (see the header): a render that finds a
  // newer number after an await is about text no longer in the box.
  let renders = 0;

  // The renderer is 686 KB over the wire (2.1 MB unzipped) and used to load on
  // every page view, whether or not the visitor typed anything. It now arrives on
  // first use: focusing the box, typing, changing an option, or asking for a file.
  // Someone who lands here and leaves pays nothing, and the download overlaps
  // their first keystrokes.
  //
  // `attempt` is the current load, `{ promise, el }`: shared by every caller
  // while it is in flight and kept once it has succeeded. A failed one is
  // forgotten (forget, below), so the next use starts afresh.
  let attempt = null;
  function loadRenderer() {
    if (attempt) return attempt;
    const a = { promise: null, el: null };
    a.promise = new Promise((resolve, reject) => {
      // Test for the API, not for window.MathJax: the page sets a CONFIG object
      // of that name in the head, and it has its own `startup` key, so checking
      // `MathJax.startup` sees the config and concludes the library is already
      // here — the script never loads and tex2svgPromise is missing.
      if (typeof window.MathJax?.tex2svgPromise === 'function') { resolve(); return; }
      const src = form.dataset.mathjaxSrc;
      if (!src) { reject(new Error('The renderer URL is missing.')); return; }
      a.el = document.createElement('script');
      a.el.src = src;
      a.el.async = true;
      a.el.addEventListener('load', () => resolve());
      a.el.addEventListener('error', () => { forget(a); reject(new Error('The renderer failed to load.')); });
      document.head.appendChild(a.el);
    });
    attempt = a;
    return a;
  }

  // A failed attempt is forgotten, so the next use appends a fresh <script>,
  // and the dead one goes. The load's promise used to be kept whatever its
  // outcome: one refused fetch (a flaky connection, an ad blocker) left every
  // later keystroke failing at once with the same message until a reload, and
  // the prefetch on focus swallows its failure, so nobody had seen why.
  function forget(a) {
    if (attempt === a) attempt = null;
    a.el?.remove();
  }

  async function mathjax() {
    const a = loadRenderer();
    await a.promise;
    // The bundle replaces the config object with the real one, and on a slow parse
    // the load event can land a tick early, so wait for the API to appear.
    for (let n = 0; typeof window.MathJax?.tex2svgPromise !== 'function' && n < 200; n += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (typeof window.MathJax?.tex2svgPromise !== 'function') {
      // The script loaded but the API never came: a captive portal or a proxy
      // answering 200 with something else. Kept, this attempt would send every
      // later render through the same wait; forgotten, the next use fetches
      // again.
      forget(a);
      throw new Error('The renderer did not initialise.');
    }
    await window.MathJax.startup.promise;
    return window.MathJax;
  }

  async function render() {
    const seq = ++renders;
    const tex = input.value.trim();
    if (!tex) {
      // Everything the last render wrote goes with it: the equation, the file
      // behind the buttons, and the status line, which once kept a "LaTeX
      // error" about an expression that was no longer there. The size and
      // colour went with the equation (below), so the placeholder's own rule
      // in tools.css (`.latex-preview.is-empty`) applies unaided.
      preview.textContent = 'Type some LaTeX above.';
      preview.classList.add('is-empty');
      svgEl = null;
      setStatus(status, '');
      return;
    }
    try {
      const M = await mathjax();
      if (seq !== renders) return;
      if (M.texReset) M.texReset();
      const node = await M.tex2svgPromise(tex, { display: !(inline && inline.checked) });
      if (seq !== renders) return;
      const svg = node.querySelector('svg');
      if (!svg) throw new Error('Nothing was rendered.');
      // MathJax adds a visually-hidden MathML copy of every equation for screen
      // readers and hides it with a stylesheet that only a full typeset run
      // injects. This page only converts, so the copy rendered natively under
      // the SVG and the preview showed the equation twice. The bundle is now
      // configured without it (enableAssistiveMml: false); this is the belt to
      // that brace, for a cached older bundle.
      for (const mml of node.querySelectorAll('mjx-assistive-mml')) mml.remove();
      // The size and colour go on the equation's own container, not on the
      // preview box. MathJax sizes the SVG in `ex` and paints it in
      // `currentColor`, both resolved from the nearest ancestor's font and
      // colour, so the container serves as well as the box did; and the box
      // outlives every render, where an inline style beat the placeholder's
      // class rule and "Type some LaTeX above." wore the last equation's
      // 24 px and its picked colour after the box was emptied.
      node.style.fontSize = `${Number(size.value) || 24}px`;
      node.style.color = color.value;
      preview.innerHTML = '';
      preview.classList.remove('is-empty');
      preview.appendChild(node);
      svgEl = svg;
      const err = node.querySelector('[data-mjx-error]');
      if (err) setStatus(status, `LaTeX error: ${err.getAttribute('data-mjx-error') || 'see the preview'}`, 'error');
      else setStatus(status, '');
      if (!err) used(slug);
    } catch (e) {
      if (seq !== renders) return;
      setStatus(status, e.message || String(e), 'error');
    }
  }

  /** The rendered SVG as a standalone document with pixel dimensions. */
  function standalone() {
    if (!svgEl) return null;
    const rect = svgEl.getBoundingClientRect();
    const w = Math.max(1, Math.ceil(rect.width));
    const h = Math.max(1, Math.ceil(rect.height));
    const c = svgEl.cloneNode(true);
    c.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    c.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    c.setAttribute('width', `${w}px`);
    c.setAttribute('height', `${h}px`);
    // MathJax paints every glyph and rule with `currentColor`, which is the
    // CSS `color` of the nearest ancestor. In the preview that is the
    // equation's own container, where render() put it; in a standalone file
    // there is no ancestor, so the colour fell back to black whatever was
    // picked. `color` is an SVG presentation
    // attribute, so setting it on the root gives the file its own default,
    // the browser's rasteriser honours it for the PNG, and the fills stay
    // `currentColor` as the SVG page's FAQ promises: a CSS `color` rule on an
    // inline copy still recolours the whole equation. (Root `fill`/`stroke`
    // attributes did nothing: MathJax's own group overrides them.)
    c.setAttribute('color', color.value);
    c.removeAttribute('style');
    c.removeAttribute('role');
    c.removeAttribute('focusable');
    const xml = new XMLSerializer().serializeToString(c);
    return { xml: `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`, w, h };
  }

  async function toPng() {
    const s = standalone();
    if (!s) return null;
    const k = Number(scale && scale.value) || 2;
    const url = URL.createObjectURL(new Blob([s.xml], { type: 'image/svg+xml;charset=utf-8' }));
    const img = new Image();
    try {
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('The browser could not rasterise the SVG.'));
        img.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(s.w * k);
      canvas.height = Math.round(s.h * k);
      const ctx = canvas.getContext('2d');
      if (bg && bg.value === 'white') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const schedule = () => { clearTimeout(timer); timer = setTimeout(render, 220); };
  input.addEventListener('input', schedule);
  for (const el of [size, color, inline]) el && el.addEventListener('input', schedule);
  form.addEventListener('submit', (e) => { e.preventDefault(); render(); });

  $('#dlPng')?.addEventListener('click', async () => {
    try {
      const blob = await toPng();
      if (blob) download('equation.png', blob);
      else setStatus(status, 'Render something first.', 'error');
    } catch (e) {
      setStatus(status, e.message || String(e), 'error');
    }
  });
  $('#dlSvg')?.addEventListener('click', () => {
    const s = standalone();
    if (s) download('equation.svg', s.xml, 'image/svg+xml;charset=utf-8');
    else setStatus(status, 'Render something first.', 'error');
  });
  bindCopy($('#copySvg'), () => (standalone() || {}).xml || '');
  // The PNG goes to the clipboard as an image, so it pastes straight into
  // slides, docs and chat. SVG has no such path: browsers do not accept
  // image/svg+xml on the clipboard, which is why the SVG button copies code.
  const copyPng = $('#copyPng');
  copyPng?.addEventListener('click', async () => {
    if (!svgEl) { setStatus(status, 'Render something first.', 'error'); return; }
    const label = copyPng.textContent;
    const ok = await copyImage(toPng());
    copyPng.textContent = ok ? 'Copied' : 'Copy failed';
    setStatus(status, ok ? '' : 'This browser cannot copy images to the clipboard. Download the PNG instead.', ok ? '' : 'error');
    setTimeout(() => { copyPng.textContent = label; }, 1400);
  });

  // Nothing renders until there is something to render. The box starts empty with
  // the sample as its placeholder, so this is the resting state, not a loading
  // one — "Loading the renderer…" was a claim about a download that had not
  // started.
  preview.textContent = 'Type some LaTeX above.';
  preview.classList.add('is-empty');

  // Fetch the renderer at the first sign the tool will be used, so it is usually
  // there by the time an expression is complete. Focus alone is enough.
  const warm = () => { loadRenderer().promise.catch(() => {}); };
  input.addEventListener('focus', warm, { once: true });
  for (const el of [size, color, bg, scale, inline]) {
    if (el) el.addEventListener('change', warm, { once: true });
  }
  void ready;
}
