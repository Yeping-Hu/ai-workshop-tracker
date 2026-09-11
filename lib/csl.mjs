/**
 * Metadata from the public registries -> Ref objects.
 *
 * The citation tools fetch from four browser-reachable sources, and each has
 * its own JSON shape:
 *   - doi.org content negotiation (Accept: application/vnd.citationstyles.csl+json),
 *     which Crossref and DataCite both answer with CSL-JSON and CORS headers;
 *   - the Crossref REST API (`/works?query.bibliographic=`), whose items are
 *     CSL-like but wrap title and container-title in arrays;
 *   - Open Library's books API (`jscmd=data`) for ISBNs;
 *   - NCBI E-utilities esummary for PubMed ids.
 * Everything is normalised here so the formatters see one shape. Pure
 * functions of the JSON, no fetching, so scripts/citations_test.mjs can pin
 * them on saved fixtures.
 */
import { parseOneName } from './citations.mjs';

const CSL_TYPES = {
  'article-journal': 'article',
  'article-magazine': 'article',
  'article-newspaper': 'article',
  article: 'article',
  'journal-article': 'article',
  'paper-conference': 'inproceedings',
  'proceedings-article': 'inproceedings',
  chapter: 'incollection',
  'book-chapter': 'incollection',
  'book-section': 'incollection',
  book: 'book',
  monograph: 'book',
  'edited-book': 'book',
  'reference-book': 'book',
  thesis: 'phdthesis',
  dissertation: 'phdthesis',
  report: 'techreport',
  'posted-content': 'misc',
  preprint: 'misc',
  dataset: 'misc',
  webpage: 'misc',
  'post-weblog': 'misc',
  software: 'misc',
};

// Registry strings arrive with HTML entities (&amp;) and inline tags (<i>,
// <sub>) from publisher deposits; a citation wants neither.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…' };
const unescapeHtml = (t) => String(t)
  .replace(/<\/?[a-z][^>]*>/gi, '')
  .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') { const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
const str = (v) => unescapeHtml(Array.isArray(v) ? (v[0] ?? '') : v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();

function cslName(n) {
  if (!n) return null;
  if (n.literal || (!n.family && n.name)) return { family: '', given: '', suffix: '', literal: n.literal || n.name };
  if (!n.family && !n.given) return null;
  return { family: str(n.family), given: str(n.given), suffix: str(n.suffix), literal: '' };
}

function dateParts(d) {
  const parts = d && Array.isArray(d['date-parts']) ? d['date-parts'][0] : null;
  if (parts && parts.length) return { year: String(parts[0]), month: parts[1] ? Number(parts[1]) : null };
  const raw = d && (d.raw || d.literal);
  const m = raw ? /(\d{4})(?:-(\d{2}))?/.exec(String(raw)) : null;
  return m ? { year: m[1], month: m[2] ? Number(m[2]) : null } : { year: null, month: null };
}

/** CSL-JSON (doi.org negotiation) or a Crossref REST work item -> Ref. */
export function fromCsl(item) {
  if (!item || typeof item !== 'object') return null;
  const type = CSL_TYPES[str(item.type)] || 'misc';
  const issued = dateParts(item.issued || item['published-print'] || item['published-online'] || item.published || item.created);
  // DOIs are case-insensitive; DataCite returns arXiv ones upper-cased.
  const doi = (str(item.DOI) || null) && str(item.DOI).replace(/^10\.48550\/arxiv\./i, '10.48550/arXiv.');
  const container = str(item['container-title']);
  const event = item.event && typeof item.event === 'object' ? str(item.event.name) : str(item['event-title']);
  const publisher = str(item.publisher);
  // Crossref keeps a subtitle apart from the title ("Optuna" + "A
  // Next-generation Hyperparameter Optimization Framework"); a citation wants both.
  const subtitle = str(item.subtitle);
  const mainTitle = cleanTitle(str(item.title));
  const title = subtitle && !mainTitle.toLowerCase().includes(subtitle.toLowerCase()) ? `${mainTitle}: ${subtitle}` : mainTitle;
  const ref = {
    type,
    key: null,
    title,
    authors: (item.author || []).map(cslName).filter(Boolean),
    editors: (item.editor || []).map(cslName).filter(Boolean),
    year: issued.year,
    month: issued.month,
    journal: type === 'article' ? container : '',
    booktitle: type === 'inproceedings' || type === 'incollection' ? container || event : '',
    volume: str(item.volume),
    number: str(item.issue) || (type === 'techreport' ? str(item.number) : ''),
    pages: str(item.page).replace(/-/g, '–'),
    publisher,
    address: str(item['publisher-place']) || (item.event && typeof item.event === 'object' ? str(item.event.location) : ''),
    institution: type === 'techreport' ? publisher : '',
    school: type === 'phdthesis' ? publisher : '',
    edition: str(item.edition),
    series: str(item['collection-title']),
    doi,
    // The canonical DOI link, not the dx.doi.org form Crossref still deposits.
    url: doi ? `https://doi.org/${doi}` : str(item.URL) || null,
    isbn: str(item.ISBN) || null,
    issn: str(item.ISSN) || null,
    eprint: null,
    archivePrefix: null,
    primaryClass: null,
    note: null,
    howpublished: null,
    accessed: null,
  };
  if (type === 'techreport') ref.publisher = '';
  if (type === 'phdthesis') ref.publisher = '';
  // arXiv DOIs are registered with DataCite as 10.48550/arXiv.<id>.
  const ax = doi && /^10\.48550\/arxiv\.(.+)$/i.exec(doi);
  if (ax) {
    ref.eprint = ax[1];
    ref.archivePrefix = 'arXiv';
    ref.type = 'misc';
    ref.journal = '';
    ref.booktitle = '';
    ref.publisher = 'arXiv';
    ref.primaryClass = arxivClass(item) || null;
    ref.url = `https://arxiv.org/abs/${ax[1]}`;
  }
  // A journal article whose container is empty but whose event is named is a
  // proceedings paper that Crossref filed under the wrong type.
  if (ref.type === 'article' && !ref.journal && event) { ref.type = 'inproceedings'; ref.booktitle = event; }
  return ref;
}

/** DataCite carries the arXiv category as a subject like "cs.LG" or
 *  "FOS: Computer and information sciences"; keep the short code only. */
function arxivClass(item) {
  const subjects = item.subject || item.subjects || item.categories || [];
  for (const s of subjects) {
    const v = typeof s === 'string' ? s : s && (s.subject || s.name);
    if (v && /^[a-z\-]+(\.[A-Z]{2})?$/.test(v)) return v;
  }
  return null;
}

function cleanTitle(t) {
  return String(t || '').replace(/\s+/g, ' ').trim();
}

/** Open Library `api/books?jscmd=data` record -> Ref (a book). */
export function fromOpenLibrary(rec, isbn) {
  if (!rec || typeof rec !== 'object') return null;
  const year = /(\d{4})/.exec(str(rec.publish_date))?.[1] ?? null;
  const ids = rec.identifiers || {};
  const isbn13 = (ids.isbn_13 || [])[0] || (ids.isbn_10 || [])[0] || isbn || null;
  return {
    type: 'book',
    key: null,
    title: [str(rec.title), str(rec.subtitle)].filter(Boolean).join(': '),
    authors: (rec.authors || []).map((a) => parseOneName(str(a.name))),
    editors: [],
    year,
    month: null,
    journal: '',
    booktitle: '',
    volume: '',
    number: '',
    pages: null,
    publisher: str((rec.publishers || [])[0]?.name),
    address: str((rec.publish_places || [])[0]?.name),
    institution: '',
    school: '',
    edition: '',
    series: '',
    doi: null,
    url: str(rec.url) || null,
    isbn: isbn13,
    issn: null,
    eprint: null,
    archivePrefix: null,
    primaryClass: null,
    note: null,
    howpublished: null,
    accessed: null,
  };
}

/** Google Books volume -> Ref (the fallback when Open Library has no record). */
export function fromGoogleBooks(vol, isbn) {
  const v = vol && vol.volumeInfo;
  if (!v) return null;
  const ids = v.industryIdentifiers || [];
  const isbn13 = ids.find((x) => x.type === 'ISBN_13')?.identifier || ids.find((x) => x.type === 'ISBN_10')?.identifier || isbn || null;
  return {
    type: 'book',
    key: null,
    title: [str(v.title), str(v.subtitle)].filter(Boolean).join(': '),
    authors: (v.authors || []).map((n) => parseOneName(str(n))),
    editors: [],
    year: /(\d{4})/.exec(str(v.publishedDate))?.[1] ?? null,
    month: null,
    journal: '',
    booktitle: '',
    volume: '',
    number: '',
    pages: null,
    publisher: str(v.publisher),
    address: '',
    institution: '',
    school: '',
    edition: '',
    series: '',
    doi: null,
    url: str(v.canonicalVolumeLink || v.infoLink) || null,
    isbn: isbn13,
    issn: null,
    eprint: null,
    archivePrefix: null,
    primaryClass: null,
    note: null,
    howpublished: null,
    accessed: null,
  };
}

/** NCBI esummary (retmode=json) result entry -> Ref (a journal article). */
export function fromPubmedSummary(doc, pmid) {
  if (!doc || typeof doc !== 'object' || doc.error) return null;
  const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const dm = /^(\d{4})(?:\s+([A-Za-z]{3}))?/.exec(str(doc.pubdate));
  const doi = (doc.articleids || []).find((a) => a.idtype === 'doi')?.value || /doi:\s*(\S+)/i.exec(str(doc.elocationid))?.[1] || null;
  const id = str(doc.uid) || pmid;
  return {
    type: 'article',
    key: null,
    title: str(doc.title).replace(/\.$/, ''),
    authors: (doc.authors || []).filter((a) => !a.authtype || a.authtype === 'Author').map((a) => pubmedName(str(a.name))),
    editors: [],
    year: dm ? dm[1] : null,
    month: dm && dm[2] ? months[dm[2].toLowerCase()] ?? null : null,
    journal: str(doc.fulljournalname) || str(doc.source),
    booktitle: '',
    volume: str(doc.volume),
    number: str(doc.issue),
    pages: str(doc.pages) ? expandRange(str(doc.pages)) : null,
    publisher: '',
    address: '',
    institution: '',
    school: '',
    edition: '',
    series: '',
    doi,
    url: id ? `https://pubmed.ncbi.nlm.nih.gov/${id}/` : null,
    isbn: null,
    issn: str(doc.issn) || null,
    eprint: null,
    archivePrefix: null,
    primaryClass: null,
    note: id ? `PMID: ${id}` : null,
    howpublished: null,
    accessed: null,
  };
}

/** "Smith J", "de Azevedo WF Jr" -> family, initials, suffix. */
function pubmedName(s) {
  const m = /^(.*?)\s+([A-Z]{1,3})(?:\s+(Jr|Sr|2nd|3rd|II|III|IV))?$/.exec(s.trim());
  if (!m) return parseOneName(s);
  return { family: m[1], given: m[2].split('').map((c) => `${c}.`).join(' '), suffix: m[3] || '', literal: '' };
}

function expandRange(pg) {
  const m = /^(\d+)-(\d+)$/.exec(pg);
  if (!m) return pg.replace(/-/, '–');
  const end = m[2].length < m[1].length ? m[1].slice(0, m[1].length - m[2].length) + m[2] : m[2];
  return `${m[1]}–${end}`;
}

/**
 * A workshop paper from this site's own OpenReview cache -> Ref. The
 * booktitle is the one thing no external registry can produce: the workshop's
 * full name with its conference and year, which is how a workshop paper is
 * cited in a bibliography.
 */
export function fromWorkshopPaper(paper, workshop) {
  if (!paper || !workshop) return null;
  const name = String(workshop.name || '').trim();
  const venue = `${workshop.conference} ${workshop.year}`;
  const booktitle = /workshop/i.test(name) ? `${name} at ${venue}` : `${name} Workshop at ${venue}`;
  return {
    type: 'inproceedings',
    key: null,
    title: String(paper.title || '').trim(),
    authors: (paper.authors || []).map((n) => parseOneName(String(n))),
    editors: [],
    year: String(workshop.year),
    month: null,
    journal: '',
    booktitle,
    volume: '',
    number: '',
    pages: null,
    publisher: '',
    address: '',
    institution: '',
    school: '',
    edition: '',
    series: '',
    doi: null,
    url: paper.forum_url || null,
    isbn: null,
    issn: null,
    eprint: null,
    archivePrefix: null,
    primaryClass: null,
    note: null,
    howpublished: null,
    accessed: null,
  };
}
