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
import { $, setStatus, download, bindCopy, used } from './ui.js';

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

  async function mathjax() {
    if (!window.MathJax || !window.MathJax.startup) throw new Error('The renderer is still loading; try again in a moment.');
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
    c.setAttribute('fill', color.value);
    c.setAttribute('stroke', color.value);
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

  // The vendor script is async; poll briefly for it, then render the default.
  const waitStart = Date.now();
  const poll = setInterval(() => {
    if (window.MathJax && window.MathJax.startup) {
      clearInterval(poll);
      ready = true;
      render();
    } else if (Date.now() - waitStart > 20000) {
      clearInterval(poll);
      setStatus(status, 'The renderer did not load. Reload the page, or check an ad blocker.', 'error');
    }
  }, 100);
  void ready;
}
