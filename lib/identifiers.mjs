/**
 * What did the visitor paste? One classifier for every citation tool.
 *
 * The BibTeX generator and its per-format pages accept a DOI, an arXiv id or
 * link, an ISBN, a PubMed id or link, an OpenReview link, any URL that
 * carries a DOI, a plain URL, or free text (a title to look up). The rules
 * live here, in one place, so "DOI to BibTeX" and "URL to BibTeX" cannot
 * disagree about what a DOI looks like. Pure string work; no fetching.
 *
 * Returns { kind, value, ...extras }:
 *   doi         value = "10.1145/3292500.3330701"
 *   arxiv       value = "2106.09685" (version stripped; `version` kept separately)
 *   isbn        value = digits only, 10 or 13 long, checksum verified
 *   pmid        value = digits
 *   openreview  value = the forum id
 *   url         value = the URL as given
 *   query       value = the trimmed text
 */

const DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>{}\[\]]+)/i;
const ARXIV_NEW = /(?:^|[^\d.])(\d{4}\.\d{4,5})(v\d+)?(?![\d.])/;
const ARXIV_OLD = /\b([a-z][a-z\-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?\b/;

export function classify(input) {
  const s = String(input ?? '').trim();
  if (!s) return { kind: 'query', value: '' };

  // OpenReview links: the id is a forum id in the query string.
  const or = /openreview\.net\/(?:forum|pdf|attachment)\?[^ ]*\bid=([\w\-]+)/i.exec(s);
  if (or) return { kind: 'openreview', value: or[1] };

  // arXiv links and bare ids, before DOI: an arXiv DOI is derived from the id.
  const ax = /arxiv\.org\/(?:abs|pdf|html|format)\/([^\s?#]+?)(?:\.pdf)?(?:[?#].*)?$/i.exec(s);
  if (ax) {
    const id = ax[1];
    const v = /v(\d+)$/.exec(id);
    return { kind: 'arxiv', value: v ? id.slice(0, -v[0].length) : id, version: v ? v[1] : null };
  }
  const axDoi = /10\.48550\/arxiv\.([^\s]+)/i.exec(s);
  if (axDoi) return { kind: 'arxiv', value: axDoi[1].replace(/v\d+$/, ''), version: /v(\d+)$/.exec(axDoi[1])?.[1] ?? null };
  if (/^(arxiv:)?\s*\d{4}\.\d{4,5}(v\d+)?$/i.test(s)) {
    const id = s.replace(/^arxiv:\s*/i, '');
    const v = /v(\d+)$/.exec(id);
    return { kind: 'arxiv', value: v ? id.slice(0, -v[0].length) : id, version: v ? v[1] : null };
  }
  if (/^(arxiv:)?\s*[a-z][a-z\-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?$/i.test(s)) {
    const id = s.replace(/^arxiv:\s*/i, '');
    const v = /v(\d+)$/.exec(id);
    return { kind: 'arxiv', value: v ? id.slice(0, -v[0].length) : id, version: v ? v[1] : null };
  }

  // A DOI, bare, prefixed, or inside any URL (doi.org, a publisher page).
  const doi = DOI_RE.exec(s.replace(/^doi:\s*/i, ''));
  if (doi) return { kind: 'doi', value: doi[1].replace(/[.,;:)]+$/, '') };

  // PubMed.
  const pm = /pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i.exec(s) || /^pmid:?\s*(\d+)$/i.exec(s);
  if (pm) return { kind: 'pmid', value: pm[1] };

  // ISBN: 10 or 13 digits once hyphens and spaces go, with a valid check digit.
  const compact = s.replace(/^isbn(?:-1[03])?:?\s*/i, '').replace(/[\s\-]/g, '');
  if (/^(\d{9}[\dXx]|\d{13})$/.test(compact) && isbnValid(compact)) return { kind: 'isbn', value: compact.toUpperCase() };

  // A bare number of up to eight digits is a PubMed id.
  if (/^\d{1,8}$/.test(s)) return { kind: 'pmid', value: s };

  if (/^https?:\/\/\S+$/i.test(s)) return { kind: 'url', value: s };
  if (/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(s) && !/\s/.test(s)) return { kind: 'url', value: `https://${s}` };

  return { kind: 'query', value: s.replace(/\s+/g, ' ') };
}

/** ISBN-10 (mod 11) or ISBN-13 (mod 10) check digit. */
export function isbnValid(compact) {
  const s = String(compact).toUpperCase();
  if (/^\d{9}[\dX]$/.test(s)) {
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += (s[i] === 'X' ? 10 : Number(s[i])) * (10 - i);
    return sum % 11 === 0;
  }
  if (/^\d{13}$/.test(s)) {
    let sum = 0;
    for (let i = 0; i < 13; i++) sum += Number(s[i]) * (i % 2 ? 3 : 1);
    return sum % 10 === 0;
  }
  return false;
}

/** ISBN-10 -> ISBN-13 (the form Open Library and Google Books index best). */
export function isbn13(compact) {
  const s = String(compact).toUpperCase();
  if (s.length === 13) return s;
  const core = `978${s.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 ? 3 : 1);
  return core + String((10 - (sum % 10)) % 10);
}

/** The arXiv DOI DataCite registers for every arXiv paper. */
export function arxivDoi(id) {
  return `10.48550/arXiv.${id}`;
}
