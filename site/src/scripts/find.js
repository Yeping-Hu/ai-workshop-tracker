/**
 * /find/ — the page half of the paper matcher. Posts the title and abstract to
 * the Worker's /match and renders its typed answer. Every sentence written here
 * is a template over fields the response carries — a fit label, a deadline, a
 * count of past papers — because the model returns probabilities, not prose,
 * and nothing may be invented about a workshop (ARCHITECTURE.md, "Find
 * workshops for your paper").
 *
 * Shipped only in a build with PUBLIC_ALERTS_API: find.astro includes this
 * script inside that condition, and the API base is read from the same <meta>
 * the alerts scripts use. The Worker's errors are a closed set (alerts/fit.mjs,
 * handleMatch), so each has its own sentence here; anything else shows the
 * status code rather than a guess.
 */
import { arxivIdFrom, paperDoiUrl, paperFromCsl } from '../../../lib/paper_meta.mjs';

const api = () => document.querySelector('meta[name="alerts-api"]')?.content || null;
const $ = (id) => document.getElementById(id);

const FIT_LABEL = { strong: 'Strong fit', good: 'Good fit', possible: 'Possible fit', poor: 'Unlikely fit' };
const ERROR_TEXT = {
  unavailable: 'The matcher is switched off right now. The deadline board and search work as usual.',
  rate_limited: 'That is a lot of requests for one hour from this connection. Please try again later.',
  busy: 'The matcher has reached its limit for today. Please try again tomorrow.',
  captcha: 'The anti-bot check did not pass. Tick "Verify you are human" again and retry; if it keeps failing, reload the page.',
  too_long: 'The title or abstract is too long: the limits are 300 and 4,000 characters.',
  bad_request: 'A title of at least three characters is needed.',
};

/** createElement with attributes and children; strings become text nodes, so nothing is ever parsed as HTML. */
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function renderMatch(m) {
  const conf = `${m.conference?.name ?? ''} ${m.year ?? ''}`.trim();
  const meta = el('p', { class: 'find-meta muted small' });
  meta.append(
    m.deadline_wall_clock
      ? el('span', null, 'Deadline ', el('strong', null, m.deadline_wall_clock))
      : el('span', null, 'Deadline not announced yet'),
  );
  if (m.website) meta.append(' · ', el('a', { href: m.website }, 'Website'));
  meta.append(
    ' · ',
    m.basis === 'past_papers'
      ? `judged from ${m.past_paper_count} past paper${m.past_paper_count === 1 ? '' : 's'}`
      : 'judged from the name and topics',
  );
  if (m.topics?.length) meta.append(' · ', m.topics.join(', '));
  return el(
    'li',
    { class: 'find-match', 'data-fit': m.fit },
    el(
      'div',
      { class: 'find-head' },
      el('span', { class: 'find-fit' }, FIT_LABEL[m.fit] ?? m.fit),
      el('a', { class: 'find-title', href: m.url }, m.short_name || m.name),
      conf ? el('span', { class: 'find-conf' }, conf) : null,
    ),
    m.name && m.name !== m.short_name ? el('p', { class: 'find-name' }, m.name) : null,
    meta,
  );
}

function render(data) {
  const list = $('findList');
  list.replaceChildren();
  const topics = (data.paper_topics ?? []).map((t) => t.label);
  const parts = [`Judged ${data.considered} of ${data.open_calls} open calls.`];
  if (topics.length) parts.push(`Your paper reads as: ${topics.join(', ')}.`);
  if (data.partial) parts.push('Some calls could not be judged this time; try again in a minute for the rest.');
  if (!data.matches?.length) parts.push('None of the open calls looks like a fit. Adding the abstract helps, and the deadline board lists every call.');
  $('findSummary').textContent = parts.join(' ');
  for (const m of data.matches ?? []) list.append(renderMatch(m));
  $('findOut').hidden = false;
}

const form = $('findForm');

async function submit(e) {
  e.preventDefault();
  const base = api();
  if (!base) return;
  const status = $('findStatus');
  const go = $('findGo');
  const title = $('findTitle').value.trim();
  const abstract = $('findAbstract').value.trim();
  if (title.length < 3) {
    status.textContent = ERROR_TEXT.bad_request;
    return;
  }
  // Turnstile writes its token into a hidden field of the form once its
  // widget rendered and its challenge passed. A rendered widget with no token
  // is a challenge still waiting — usually a "Verify you are human" box the
  // reader has not ticked — and sending anyway only buys a 403 whose message
  // cannot say that. Say it here, and take them to the box. When the script
  // never loaded at all (an ad blocker), there is no field: send, and let the
  // Worker fail closed — the honest outcome, and the one the tests exercise.
  const tsField = form.querySelector('[name="cf-turnstile-response"]');
  if (tsField && !tsField.value) {
    const ts = window.__findTurnstile ?? {};
    status.textContent = ts.state === 'error'
      ? `The anti-bot check could not load (Turnstile error ${ts.code || 'unknown'}). An ad blocker or a strict privacy setting may be blocking challenges.cloudflare.com; reload the page to try again.`
      : 'Tick "Verify you are human" above first, then press Find workshops again.';
    form.querySelector('.cf-turnstile')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  const turnstile_token = tsField ? tsField.value : '';
  go.disabled = true;
  status.textContent = 'Judging your paper against the open calls…';
  try {
    const res = await fetch(`${base}/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, abstract, turnstile_token }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      // A 503 says why in `detail` (no key, no feed, what the model answered);
      // shown verbatim so the person who can fix it reads the cause here.
      const detail = typeof data?.detail === 'string' && data.detail ? ` (${data.detail})` : '';
      status.textContent = (ERROR_TEXT[data?.error] ?? `The matcher answered ${res.status}. Please try again.`) + detail;
      return;
    }
    render(data);
    status.textContent = '';
  } catch {
    status.textContent = 'Could not reach the matcher. Check your connection, or an ad blocker that blocks it.';
  } finally {
    go.disabled = false;
    window.turnstile?.reset?.();
  }
}

if (form) form.addEventListener('submit', submit);

/**
 * The prefill: an arXiv id or link becomes a title and abstract through
 * doi.org's CSL-JSON for the paper's DataCite DOI — the route the citation
 * tools already use, and one whose CORS they have proven. lib/paper_meta.mjs
 * says why arXiv's own API is not used. Fills the fields and stops; the reader
 * still reviews and presses "Find workshops".
 */
async function prefill() {
  const status = $('findStatus');
  const id = arxivIdFrom($('findArxiv').value);
  if (!id) {
    status.textContent = 'That does not look like an arXiv id or link (for example 2106.09685).';
    return;
  }
  const btn = $('findPrefill');
  btn.disabled = true;
  status.textContent = `Fetching arXiv:${id}…`;
  try {
    const res = await fetch(paperDoiUrl(id), { headers: { Accept: 'application/vnd.citationstyles.csl+json' } });
    if (!res.ok) {
      status.textContent = res.status === 404
        ? `No record for arXiv:${id} yet — paste the title and abstract instead.`
        : `doi.org answered ${res.status} — paste the title and abstract instead.`;
      return;
    }
    const paper = paperFromCsl(await res.json());
    if (!paper) {
      status.textContent = 'That record has no title — paste it instead.';
      return;
    }
    $('findTitle').value = paper.title;
    $('findAbstract').value = paper.abstract;
    status.textContent = paper.abstract
      ? 'Filled in from arXiv. Check it, then find workshops.'
      : 'Filled in the title from arXiv; the record carries no abstract.';
  } catch {
    status.textContent = 'Could not reach doi.org. Check your connection, or an ad blocker that blocks it.';
  } finally {
    btn.disabled = false;
  }
}

$('findPrefill')?.addEventListener('click', prefill);
$('findArxiv')?.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  prefill();
});
