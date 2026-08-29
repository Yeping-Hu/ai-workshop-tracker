/**
 * Extract a conference's ACCEPTED-WORKSHOP list from its announcement page.
 *
 * Pure: HTML in, items out. No network, no filesystem — so it is unit-tested
 * against committed fixtures rather than against the live web, which is the only
 * way a page reformat shows up as a red test instead of as a silent day where
 * every workshop looks rejected.
 *
 * Deliberately dependency-free. The repo's deps are ajv, js-yaml and playwright;
 * pulling in an HTML parser for two pages a year is not worth it, and the tiered
 * scan below plus the caller's sanity guard are what make a hand-rolled scanner
 * safe here. `warnings` is the tell that it is drifting.
 *
 * Two real page shapes are supported and pinned by fixtures, because they are
 * genuinely different and neither is "the" convention:
 *   - NeurIPS 2026 — a <ul> of 102 <li>, one <a> each
 *   - ICLR 2026    — a 40-row <table>, one <a> per <tr>
 */

/**
 * A page with fewer than this many items is not a workshop list — it is a page
 * we failed to read. Callers must treat that as "could not check", never as
 * "the corpus is all rejected".
 */
export const MIN_LISTED = 5;

/** Block elements scanned, in order. The first tier yielding a real list wins. */
const TIERS = ['li', 'tr', 'p', 'dd'];

const stripTags = (html) => html.replace(/<[^>]+>/g, ' ');

const decode = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&'); // last: an encoded &amp;lt; must not become <

const text = (html) => decode(stripTags(html)).replace(/\s+/g, ' ').trim();

/** Drop the page chrome — that is where the stray anchors live. */
function mainContent(html) {
  let s = html
    .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  // Prefer the innermost of the usual content containers.
  for (const re of [
    /<div[^>]*class="[^"]*(?:entry|post|page)[-_]?content[^"]*"[^>]*>([\s\S]*)<\/div>/i,
    /<article\b[^>]*>([\s\S]*)<\/article>/i,
    /<main\b[^>]*>([\s\S]*)<\/main>/i,
  ]) {
    const m = s.match(re);
    if (m) {
      s = m[1];
      break;
    }
  }
  s = s.replace(/<(nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  // Chrome is not always marked up semantically. Bootstrap-style conference
  // sites wrap their menus in <div class="navbar"> / <ul class="nav">, which the
  // tag sweep above cannot see — and a nav is a list of single-anchor <li>, i.e.
  // exactly the shape being scanned for. Dropping it by class/id is what stops a
  // JS-rendered schedule page from reporting its own menu as the workshop list.
  return s.replace(
    /<(div|ul|section)\b[^>]*(?:class|id)=["'][^"']*\b(?:navbar|nav|menu|sidebar|breadcrumb|footer|header|masthead|pagination|social|share|widget)\b[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
    '',
  );
}

/** Normalised key for de-duplication within one page. */
const urlKey = (u) =>
  u
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('#')[0]
    .replace(/\/+$/, '');

function absolute(href, baseUrl) {
  try {
    return baseUrl ? new URL(href, baseUrl).href : href;
  } catch {
    return href;
  }
}

/**
 * @returns {{ items: {url:string,title:string,section:string|null}[], warnings: string[] }}
 *   `section` is the nearest preceding heading (NeurIPS groups by host city). It
 *   is carried into the report for a human's benefit and is NEVER used for
 *   matching — a location mismatch is a different bug from an absent workshop.
 */
export function extractListedWorkshops(html, { baseUrl = null } = {}) {
  const warnings = [];
  const body = mainContent(String(html ?? ''));
  const selfKey = baseUrl ? urlKey(baseUrl) : null;

  for (const [tierIndex, tag] of TIERS.entries()) {
    const seen = new Map();
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    for (const m of body.matchAll(re)) {
      const block = m[1];
      // Exactly one external anchor. A block with two is a sentence with links
      // in it, not a list entry; a block with none is prose.
      const hrefs = [...block.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)]
        .map((a) => decode(a[1]).trim())
        .filter((h) => /^https?:\/\//i.test(h) || (baseUrl && /^\/[^/]/.test(h)));
      if (hrefs.length !== 1) continue;
      const url = absolute(hrefs[0], baseUrl);
      const key = urlKey(url);
      if (!key || key === selfKey) continue;
      const title = text(block);
      if (!title) continue;
      if (!seen.has(key)) seen.set(key, { url, title, section: sectionFor(body, m.index) });
    }
    if (seen.size >= MIN_LISTED) {
      if (tierIndex > 0) {
        warnings.push(
          `list found in <${tag}> blocks rather than <li> — the page shape changed, or this conference formats its list differently`,
        );
      }
      return { items: [...seen.values()], warnings };
    }
  }
  warnings.push(`no workshop list found: fewer than ${MIN_LISTED} single-anchor blocks in the page's main content`);
  return { items: [], warnings };
}

/** Nearest preceding <h1>–<h4> text before `offset`. */
function sectionFor(body, offset) {
  let section = null;
  for (const h of body.matchAll(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/gi)) {
    if (h.index > offset) break;
    const t = text(h[1]);
    if (t) section = t;
  }
  return section;
}

/**
 * The count a page states about itself ("102 accepted workshops", "40 accepted
 * workshops"). A soft cross-check only — the phrasing is not guaranteed and a
 * disagreement is a warning, never a failure.
 */
export function statedWorkshopCount(html) {
  const flat = text(String(html ?? ''));
  // The word "accepted" is REQUIRED, in either order — NeurIPS writes "we have
  // accepted 102 workshops", ICLR writes "40: accepted workshops". A looser
  // "<n> workshops" would happily read the proposal count off the same
  // paragraph ("122 workshop proposal submissions", "151 (135 valid) workshop
  // proposal submissions") or a per-city subtotal ("Sydney (48 workshops)").
  // This is only a cross-check, so returning nothing is far better than
  // returning a number that is confidently wrong.
  for (const re of [/accepted\s+(\d+)\s+workshops?\b/gi, /(\d+)\s*:?\s*accepted\s+workshops?\b/gi]) {
    for (const m of flat.matchAll(re)) {
      const n = Number(m[1]);
      if (n > 0 && n < 1000) return n;
    }
  }
  return null;
}

/**
 * Which posts in a conference's announcement feed might BE the workshop list.
 *
 * Pure and exported so the rule is unit-tested against a committed feed rather
 * than against whatever the blog happens to be publishing today. The rule is
 * deliberately general — a post about workshops, for this year — because it has
 * to work for a conference nobody has looked at yet. Competitions, tutorials,
 * newsletters and calls for proposals share the same feed and are the specific
 * things it must not pick up.
 *
 * Verified against both feeds that exist: NeurIPS's "Announcing the NeurIPS 2026
 * Workshops" and ICLR's "Workshops at ICLR 2026".
 */
export function selectAnnouncementCandidates(feedXml, year) {
  const out = [];
  const seen = new Set();
  for (const m of String(feedXml ?? '').matchAll(/<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/gi)) {
    const b = m[1];
    const title = (b.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1] ?? '').trim();
    const link = (b.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1] ?? b.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? '').trim();
    if (!title || !link || seen.has(link)) continue;
    seen.add(link);
    if (!/\bworkshops?\b/i.test(title)) continue;
    if (!title.includes(String(year))) continue;
    if (/\b(competition|tutorial|newsletter|proposal|call for)\b/i.test(title)) continue;
    out.push({ title, url: link });
  }
  return out;
}
