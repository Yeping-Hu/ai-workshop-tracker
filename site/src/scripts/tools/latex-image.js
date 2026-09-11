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

  // The renderer is 686 KB over the wire (2.1 MB unzipped) and used to load on
  // every page view, whether or not the visitor typed anything. It now arrives on
  // first use: focusing the box, typing, changing an option, or asking for a file.
  // Someone who lands here and leaves pays nothing, and the download overlaps
  // their first keystrokes.
  let loader = null;
  function loadRenderer() {
    if (loader) return loader;
    loader = new Promise((resolve, reject) => {
      // Test for the API, not for window.MathJax: the page sets a CONFIG object
      // of that name in the head, and it has its own `startup` key, so checking
      // `MathJax.startup` sees the config and concludes the library is already
      // here — the script never loads and tex2svgPromise is missing.
      if (typeof window.MathJax?.tex2svgPromise === 'function') { resolve(); return; }
      const src = form.dataset.mathjaxSrc;
      if (!src) { reject(new Error('The renderer URL is missing.')); return; }
      const el = document.createElement('script');
      el.src = src;
      el.async = true;
      el.addEventListener('load', () => resolve());
      el.addEventListener('error', () => reject(new Error('The renderer failed to load.')));
      document.head.appendChild(el);
    });
    return loader;
  }

  async function mathjax() {
    await loadRenderer();
    // The bundle replaces the config object with the real one, and on a slow parse
    // the load event can land a tick early, so wait for the API to appear.
    for (let n = 0; typeof window.MathJax?.tex2svgPromise !== 'function' && n < 200; n += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (typeof window.MathJax?.tex2svgPromise !== 'function') throw new Error('The renderer did not initialise.');
    await window.MathJax.startup.promise;
    return window.MathJax;
  }

  async function render() {
    const tex = input.value.trim();
    if (!tex) {
      preview.textContent = 'Type some LaTeX above.';
      preview.classList.add('is-empty');
      svgEl = null;
      return;
    }
    try {
      const M = await mathjax();
      if (M.texReset) M.texReset();
      const node = await M.tex2svgPromise(tex, { display: !(inline && inline.checked) });
      const svg = node.querySelector('svg');
      if (!svg) throw new Error('Nothing was rendered.');
      // MathJax adds a visually-hidden MathML copy of every equation for screen
      // readers and hides it with a stylesheet that only a full typeset run
      // injects. This page only converts, so the copy rendered natively under
      // the SVG and the preview showed the equation twice. The bundle is now
      // configured without it (enableAssistiveMml: false); this is the belt to
      // that brace, for a cached older bundle.
      for (const mml of node.querySelectorAll('mjx-assistive-mml')) mml.remove();
      preview.innerHTML = '';
      preview.classList.remove('is-empty');
      preview.style.fontSize = `${Number(size.value) || 24}px`;
      preview.style.color = color.value;
      preview.appendChild(node);
      svgEl = svg;
      const err = node.querySelector('[data-mjx-error]');
      if (err) setStatus(status, `LaTeX error: ${err.getAttribute('data-mjx-error') || 'see the preview'}`, 'error');
      else setStatus(status, '');
      if (!err) used(slug);
    } catch (e) {
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
    // CSS `color` of the nearest ancestor. In the preview that is the page's
    // container; in a standalone file there is no ancestor, so the colour
    // fell back to black whatever was picked. `color` is an SVG presentation
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
  const warm = () => { loadRenderer().catch(() => {}); };
  input.addEventListener('focus', warm, { once: true });
  for (const el of [size, color, bg, scale, inline]) {
    if (el) el.addEventListener('change', warm, { once: true });
  }
  void ready;
}
