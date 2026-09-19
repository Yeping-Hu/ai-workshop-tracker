/**
 * A paper's title and abstract from the identifier someone pastes — the
 * matcher's prefill (site/src/scripts/find.js). Pure; the page does the fetch.
 *
 * Through doi.org, not arXiv's API. Every arXiv paper has a DataCite DOI,
 * 10.48550/arXiv.<id>, and DataCite's CSL-JSON carries the abstract along with
 * the title — the same content negotiation the citation tools already depend
 * on (site/src/scripts/tools/refs.js), from a host whose CORS the tools have
 * proven. arXiv's own export API was the obvious route and the wrong one: it
 * answered 429 to a single request from a shared address while this was
 * built (2026-09-18), and every reader behind a campus NAT shares one.
 */
import { classify, arxivDoi } from './identifiers.mjs';

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** The arXiv id in whatever was pasted — bare, versioned, `arXiv:` prefixed, an abs/pdf link, or the DataCite DOI — else null. */
export function arxivIdFrom(input) {
  const id = classify(String(input ?? ''));
  return id?.kind === 'arxiv' && id.value ? id.value : null;
}

/** Where the record lives: doi.org resolves the DataCite DOI with CSL-JSON content negotiation. */
export function paperDoiUrl(arxivId) {
  return `https://doi.org/${arxivDoi(arxivId)}`;
}

/** Title and abstract out of a CSL-JSON record, whitespace folded; null without a title. */
export function paperFromCsl(json) {
  const title = clean(Array.isArray(json?.title) ? json.title[0] : json?.title);
  if (!title) return null;
  return { title, abstract: clean(json?.abstract) };
}
