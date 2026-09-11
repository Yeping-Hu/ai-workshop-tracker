/**
 * The one place the citation tools fetch from. Every page (BibTeX generator,
 * the per-format converters, the style pages, the DOI finder) turns its
 * input into Ref objects through here, so a DOI resolves the same way on all
 * of them and a registry quirk is fixed once.
 *
 * Sources, all called straight from the browser (each sends CORS headers,
 * verified before this was built):
 *   doi.org        content negotiation for CSL-JSON; Crossref and DataCite
 *                  both answer, so one path covers journals, proceedings,
 *                  books and arXiv (10.48550/arXiv.<id>).
 *   Open Library   ISBN lookups, with Google Books as the fallback.
 *   NCBI esummary  PubMed ids.
 *   this site      /api/openreview-papers.json, the tracker's own index of
 *                  workshop papers, loaded once and only when an OpenReview
 *                  link is pasted (the OpenReview API refuses browser calls).
 * Nothing is proxied through this site and nothing is stored.
 */
import { classify, isbn13, arxivDoi } from '../../../../lib/identifiers.mjs';
import { fromCsl, fromOpenLibrary, fromGoogleBooks, fromPubmedSummary, fromWorkshopPaper } from '../../../../lib/csl.mjs';
import { parseBibtex } from '../../../../lib/bibtex_parse.mjs';
import { parseRis } from '../../../../lib/ris.mjs';
import { parseNbib } from '../../../../lib/nbib.mjs';
import { parseOneName } from '../../../../lib/citations.mjs';

const base = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');

export class LookupError extends Error {}

async function getJson(url) {
  let r;
  try {
    r = await fetch(url);
  } catch {
    throw new LookupError(`Could not reach ${new URL(url).host}. Check your connection, or an ad blocker that blocks it.`);
  }
  if (!r.ok) throw new LookupError(`${new URL(url).host} answered ${r.status}`);
  return r.json();
}

/** A DOI -> Ref via doi.org content negotiation. */
export async function refFromDoi(doi) {
  const url = `https://doi.org/${encodeURIComponent(doi).replace(/%2F/gi, '/')}`;
  let r;
  try {
    r = await fetch(url, { headers: { Accept: 'application/vnd.citationstyles.csl+json' } });
  } catch {
    throw new LookupError('Could not reach doi.org. Check your connection, or an ad blocker that blocks it.');
  }
  if (r.status === 404) throw new LookupError(`No record for DOI ${doi}`);
  if (!r.ok) throw new LookupError(`doi.org answered ${r.status} for ${doi}`);
  const ref = fromCsl(await r.json());
  if (!ref || !ref.title) throw new LookupError(`The record for ${doi} has no title; the registry entry is incomplete.`);
  return ref;
}

/** An arXiv id -> Ref, through the DataCite DOI every arXiv paper has. */
export function refFromArxiv(id) {
  return refFromDoi(arxivDoi(id));
}

/** An ISBN -> Ref (@book): Open Library first, Google Books if it has nothing. */
export async function refFromIsbn(isbn) {
  const i13 = isbn13(isbn);
  try {
    const data = await getJson(`https://openlibrary.org/api/books?bibkeys=ISBN:${i13}&format=json&jscmd=data`);
    const rec = data[`ISBN:${i13}`];
    if (rec && rec.title) return fromOpenLibrary(rec, i13);
  } catch {
    // Fall through to Google Books.
  }
  try {
    const g = await getJson(`https://www.googleapis.com/books/v1/volumes?q=isbn:${i13}`);
    const vol = g.items && g.items[0];
    if (vol) return fromGoogleBooks(vol, i13);
  } catch {
    // Reported below.
  }
  throw new LookupError(`No book found for ISBN ${isbn} in Open Library or Google Books.`);
}

/** A PubMed id -> Ref (@article) via NCBI esummary. */
export async function refFromPmid(pmid) {
  const j = await getJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${pmid}&retmode=json`);
  const ref = fromPubmedSummary(j.result && j.result[pmid], pmid);
  if (!ref || !ref.title) throw new LookupError(`No PubMed record for ${pmid}`);
  return ref;
}

let corpus = null;
/** An OpenReview forum id -> Ref, from this site's workshop-paper index. */
export async function refFromOpenReview(id) {
  corpus ||= getJson(`${base}/api/openreview-papers.json`).catch(() => null);
  const c = await corpus;
  const row = c && c.papers && c.papers[id];
  if (!row) {
    throw new LookupError(`OpenReview paper ${id} is not in this site's index of workshop papers (it may be a main-conference paper, or a workshop not tracked here). Paste its title into the DOI finder, or cite it as a URL.`);
  }
  const [title, authors, slug] = row;
  const [name, conference, year] = c.workshops[slug];
  return fromWorkshopPaper({ title, authors, forum_url: `https://openreview.net/forum?id=${id}` }, { name, conference, year });
}

/** A web page with no identifier -> an @misc Ref with today's access date. */
export function miscFromUrl(url, { title = '', author = '' } = {}) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep empty */ }
  return {
    type: 'misc',
    // No author to build a key from: the site's name and the year, "huggingfaceco2026".
    key: `${host.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'web'}${now.getFullYear()}`,
    title: title.trim() || `Page at ${host}`,
    // "Family, Given" is a person; anything else ("Hugging Face", "World
    // Health Organization") is kept whole, since a web page's author is more
    // often an organisation than a person and BibTeX would otherwise sort
    // "Hugging Face" under F.
    authors: author.trim() ? author.split(/\s+and\s+|;/).map((n) => n.trim()).filter(Boolean).map((n) => (n.includes(',') ? parseOneName(n) : { family: '', given: '', suffix: '', literal: n })) : [],
    editors: [],
    year: String(now.getFullYear()),
    month: null,
    journal: '', booktitle: '', volume: '', number: '', pages: null,
    publisher: '', address: '', institution: '', school: '', edition: '', series: '',
    doi: null,
    url,
    isbn: null, issn: null, eprint: null, archivePrefix: null, primaryClass: null,
    note: `Accessed ${today}`,
    howpublished: `\\url{${url}}`,
    accessed: today,
  };
}

const KIND_LABEL = {
  doi: 'a DOI', arxiv: 'an arXiv id', isbn: 'an ISBN', pmid: 'a PubMed id', openreview: 'an OpenReview link', url: 'a URL',
};

/** One identifier (or URL) -> Ref. `allow` limits the kinds a page accepts. */
export async function refFromInput(text, { allow = null, urlExtras = {} } = {}) {
  const id = classify(text);
  if (allow && !allow.includes(id.kind)) {
    const wanted = allow.map((k) => KIND_LABEL[k]).filter(Boolean).join(', ');
    throw new LookupError(id.kind === 'query' ? `Not an identifier. Paste ${wanted}.` : `That is ${KIND_LABEL[id.kind] || 'something else'}; this page takes ${wanted}.`);
  }
  switch (id.kind) {
    case 'doi': return refFromDoi(id.value);
    case 'arxiv': return refFromArxiv(id.value);
    case 'isbn': return refFromIsbn(id.value);
    case 'pmid': return refFromPmid(id.value);
    case 'openreview': return refFromOpenReview(id.value);
    case 'url': return miscFromUrl(id.value, urlExtras);
    default: throw new LookupError('Not an identifier. Paste a DOI, an arXiv id or link, an ISBN, a PubMed id, an OpenReview link or a URL.');
  }
}

/**
 * The paste box -> Refs. BibTeX entries, an RIS export and an NBIB export are
 * recognised by shape; anything else is one identifier per line. Lines that
 * fail are reported in `errors`, the rest still convert.
 */
export async function refsFromText(text, opts = {}) {
  const t = String(text ?? '').trim();
  if (!t) return { refs: [], errors: [] };
  if (/^\s*@[A-Za-z]+\s*[{(]/m.test(t)) {
    const { refs, errors } = parseBibtex(t);
    return { refs, errors };
  }
  if (/^TY  - /m.test(t)) return parseRis(t);
  if (/^(PMID|TI|FAU)\s*- /m.test(t)) return parseNbib(t);
  const lines = t.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const refs = [];
  const errors = [];
  for (const line of lines) {
    try {
      refs.push(await refFromInput(line, opts));
    } catch (e) {
      errors.push(`${line}: ${e.message}`);
    }
  }
  return { refs, errors };
}

/** Crossref bibliographic search -> rows for the DOI finder. */
export async function searchCrossref(query, rows = 6) {
  const select = 'DOI,title,author,container-title,issued,type,volume,issue,page,publisher,URL,score,event';
  const j = await getJson(`https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=${rows}&select=${select}`);
  return (j.message && j.message.items ? j.message.items : []).map(fromCsl).filter((r) => r && r.title).map((r) => ({ ref: r, source: 'Crossref' }));
}

/**
 * DataCite search for the DOI finder, limited to arXiv (the DataCite client
 * that registers arXiv DOIs): the preprints of papers that never got a
 * publisher DOI, which in machine learning is most of them. DataCite ranks
 * by term frequency, so an exact title match is sorted to the front here and
 * a query that also carries authors or a year falls back to a word search.
 */
export async function searchDatacite(query, rows = 4) {
  const q = query.replace(/["\\()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!q) return [];
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const words = norm(q).split(' ').filter((w) => w.length > 2);
  const fetchRows = async (expr) => {
    const j = await getJson(`https://api.datacite.org/dois?client-id=arxiv.content&query=${encodeURIComponent(expr)}&page[size]=25`);
    return (j.data || []).map((d) => {
      const a = d.attributes || {};
      const title = (a.titles || []).map((t) => t.title).find(Boolean) || '';
      if (!title) return null;
      const authors = (a.creators || []).map((c) => (c.familyName ? { family: c.familyName, given: c.givenName || '', suffix: '', literal: '' } : { family: '', given: '', suffix: '', literal: c.name || '' }));
      const ref = fromCsl({ type: 'article', title, author: authors, issued: { 'date-parts': [[a.publicationYear || null]] }, DOI: a.doi || d.id, publisher: 'arXiv' });
      return ref ? { ref, source: 'arXiv (DataCite)' } : null;
    }).filter(Boolean);
  };
  let items = await fetchRows(`titles.title:"${q}"`);
  if (!items.length && words.length) items = await fetchRows(`titles.title:(${words.join(' ')})`);
  const score = (r) => {
    const t = norm(r.ref.title);
    if (t === norm(q)) return 2;
    return words.filter((w) => t.includes(w)).length / Math.max(1, words.length);
  };
  return items.sort((a, b) => score(b) - score(a) || a.ref.title.length - b.ref.title.length).slice(0, rows);
}
