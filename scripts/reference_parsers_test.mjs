#!/usr/bin/env node
/**
 * Pins the readers that turn pasted or fetched metadata into the citation
 * model: RIS and NBIB text, CSL-JSON from doi.org, Crossref work items,
 * DataCite (arXiv), Open Library and Google Books (ISBN), PubMed summaries,
 * the site's own workshop-paper cache, and the classifier that decides what
 * kind of identifier was pasted.
 *
 * Run: node scripts/reference_parsers_test.mjs
 */
import { parseRis } from '../lib/ris.mjs';
import { parseNbib, expandPages } from '../lib/nbib.mjs';
import { fromCsl, fromOpenLibrary, fromGoogleBooks, fromPubmedSummary, fromWorkshopPaper } from '../lib/csl.mjs';
import { classify, isbnValid, isbn13, arxivDoi } from '../lib/identifiers.mjs';
import { formatApa, toBibtex } from '../lib/citations.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ''}`); }
}
const eq = (name, got, want) => check(name, got === want, `got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);

console.log('— RIS —');
const ris = `TY  - JOUR
AU  - Smith, John A.
AU  - Doe, Jane
TI  - A study of
      things
JO  - Journal of Stuff
PY  - 2021/03/01/
VL  - 12
IS  - 3
SP  - 100
EP  - 110
UR  - https://doi.org/10.1000/xyz123
SN  - 1234-5678
ER  -

TY  - CONF
AU  - Lee, K.
T1  - Conference paper title
T2  - Proceedings of the Big Conference
PY  - 2020
SP  - 1-9
PB  - ACM
CY  - New York
ER  -

TY  - BOOK
AU  - Goodfellow, Ian
BT  - Deep Learning
PB  - MIT Press
PY  - 2016
SN  - 9780262035613
ER  -

TY  - THES
AU  - Doe, Jane
TI  - My thesis
PB  - MIT
M3  - Master's thesis
PY  - 2019
ER  -

TY  - PREPRINT
AU  - Hu, Edward
TI  - LoRA
UR  - https://arxiv.org/abs/2106.09685v2
PY  - 2021
ER  - `;
const r = parseRis(ris);
eq('five records', r.refs.length, 5);
const [j, c, b, th, pre] = r.refs;
eq('JOUR -> article', j.type, 'article');
eq('continuation line joins the title', j.title, 'A study of things');
eq('year and month from PY', `${j.year}-${j.month}`, '2021-3');
eq('SP/EP make a range', j.pages, '100–110');
eq('DOI recovered from UR', j.doi, '10.1000/xyz123');
eq('SN on an article is an ISSN', j.issn, '1234-5678');
eq('CONF -> inproceedings with booktitle', `${c.type}|${c.booktitle}|${c.publisher}|${c.address}`, 'inproceedings|Proceedings of the Big Conference|ACM|New York');
eq('SP with a dash is a range', c.pages, '1–9');
eq('BOOK title from BT, ISBN from SN', `${b.type}|${b.title}|${b.isbn}`, 'book|Deep Learning|9780262035613');
eq('THES with M3 Master -> mastersthesis, school from PB', `${th.type}|${th.school}`, 'mastersthesis|MIT');
eq('PREPRINT with an arXiv URL carries the eprint', `${pre.eprint}|${pre.archivePrefix}`, '2106.09685|arXiv');
eq('a record with no ER is still read', parseRis('TY  - JOUR\nTI  - Lonely\n').refs.length, 1);

console.log('— NBIB —');
const nbib = `PMID- 31452104
DP  - 2019 Sep 3
TI  - Deep learning in medicine: a review of the current
      state.
FAU - Smith, John
AU  - Smith J
FAU - Nguyen, Thi Minh
AU  - Nguyen TM
JT  - Journal of Medical Systems
TA  - J Med Syst
VI  - 43
IP  - 10
PG  - 1234-40
IS  - 0148-5598 (Print)
AID - 10.1007/s10916-019-1234-5 [doi]

PMID- 2
DP  - 2001
TI  - Old record.
AU  - Old AB
JT  - J Old
`;
const nn = parseNbib(nbib);
eq('two records', nn.refs.length, 2);
const [m1, m2] = nn.refs;
eq('title continuation joined, trailing period dropped', m1.title, 'Deep learning in medicine: a review of the current state');
eq('FAU names preferred', `${m1.authors[1].family}|${m1.authors[1].given}`, 'Nguyen|Thi Minh');
eq('year and month from DP', `${m1.year}-${m1.month}`, '2019-9');
eq('journal from JT', m1.journal, 'Journal of Medical Systems');
eq('pages expanded', m1.pages, '1234–1240');
eq('DOI from AID', m1.doi, '10.1007/s10916-019-1234-5');
eq('ISSN without its qualifier', m1.issn, '0148-5598');
eq('PMID as a note and a URL', `${m1.note}|${m1.url}`, 'PMID: 31452104|https://pubmed.ncbi.nlm.nih.gov/31452104/');
eq('AU-only record gets initials', `${m2.authors[0].family}|${m2.authors[0].given}`, 'Old|A. B.');
eq('AU with a suffix', (() => { const a = parseNbib('PMID- 3\nTI  - X\nAU  - de Azevedo WF Jr\n').refs[0].authors[0]; return `${a.family}|${a.given}|${a.suffix}`; })(), 'de Azevedo|W. F.|Jr');
eq('expandPages', expandPages('12-8'), '12–18');

console.log('— CSL / Crossref / DataCite —');
const crossref = { type: 'proceedings-article', title: ['Attention Is All You Need'], author: [{ given: 'Ashish', family: 'Vaswani' }, { name: 'The Team' }], 'container-title': ['Advances in Neural Information Processing Systems'], issued: { 'date-parts': [[2017, 12, 4]] }, DOI: '10.5555/3295222.3295349', page: '5998-6008', publisher: 'Curran', event: { name: 'NIPS 2017', location: 'Long Beach, CA' }, ISBN: ['9781510860964'] };
const cr = fromCsl(crossref);
eq('proceedings-article -> inproceedings', cr.type, 'inproceedings');
eq('array-wrapped title and container unwrapped', `${cr.title}|${cr.booktitle}`, 'Attention Is All You Need|Advances in Neural Information Processing Systems');
eq('literal author kept', cr.authors[1].literal, 'The Team');
eq('date parts', `${cr.year}-${cr.month}`, '2017-12');
eq('pages en-dash', cr.pages, '5998–6008');
eq('event location as address', cr.address, 'Long Beach, CA');
eq('URL derived from the DOI', cr.url, 'https://doi.org/10.5555/3295222.3295349');
const journal = { type: 'article-journal', title: 'Deep learning', author: [{ family: 'LeCun', given: 'Yann' }], 'container-title': 'Nature', volume: '521', issue: '7553', page: '436-444', issued: { 'date-parts': [[2015, 5]] }, DOI: '10.1038/nature14539' };
eq('article-journal formats as an article', formatApa(fromCsl(journal)).text, 'LeCun, Y. (2015). Deep learning. Nature, 521(7553), 436–444. https://doi.org/10.1038/nature14539');
const eventOnly = { type: 'journal-article', title: 'Paper', author: [{ family: 'A', given: 'B' }], issued: { 'date-parts': [[2020]] }, event: { name: 'The Conference' } };
eq('an article with no journal but an event is a proceedings paper', `${fromCsl(eventOnly).type}|${fromCsl(eventOnly).booktitle}`, 'inproceedings|The Conference');
const datacite = { type: 'article', title: 'LoRA: Low-Rank Adaptation of Large Language Models', author: [{ given: 'Edward J.', family: 'Hu' }], issued: { 'date-parts': [[2021]] }, DOI: '10.48550/ARXIV.2106.09685', publisher: 'arXiv', subject: ['Machine Learning (cs.LG)', 'cs.LG', 'FOS: Computer and information sciences'] };
const dc = fromCsl(datacite);
eq('arXiv DOI -> misc with eprint', `${dc.type}|${dc.eprint}|${dc.archivePrefix}`, 'misc|2106.09685|arXiv');
eq('arXiv category from subjects', dc.primaryClass, 'cs.LG');
eq('arXiv DOI case normalised', dc.doi, '10.48550/arXiv.2106.09685');
eq('arXiv abs URL', dc.url, 'https://arxiv.org/abs/2106.09685');
check('BibTeX for an arXiv paper carries eprint fields', toBibtex(dc).includes('archivePrefix = {arXiv}') && toBibtex(dc).includes('primaryClass = {cs.LG}'));
eq('report keeps the publisher as institution', `${fromCsl({ type: 'report', title: 'R', publisher: 'NIST', number: '42', issued: { 'date-parts': [[2020]] } }).institution}|${fromCsl({ type: 'report', title: 'R', publisher: 'NIST', number: '42', issued: { 'date-parts': [[2020]] } }).number}`, 'NIST|42');
eq('thesis keeps the publisher as school', fromCsl({ type: 'dissertation', title: 'T', publisher: 'MIT', issued: { raw: '2019' } }).school, 'MIT');
eq('raw date string', fromCsl({ type: 'book', title: 'B', issued: { raw: '2019-06' } }).month, 6);
eq('garbage in, null out', fromCsl(null), null);
const optuna = { type: 'proceedings-article', title: ['Optuna'], subtitle: ['A Next-generation Hyperparameter Optimization Framework'], 'container-title': ['Proceedings of the 25th ACM SIGKDD International Conference on Knowledge Discovery &amp; Data Mining'], author: [{ given: 'Takuya', family: 'Akiba' }], issued: { 'date-parts': [[2019, 7]] }, DOI: '10.1145/3292500.3330701', URL: 'http://dx.doi.org/10.1145/3292500.3330701' };
const op = fromCsl(optuna);
eq('a Crossref subtitle joins the title', op.title, 'Optuna: A Next-generation Hyperparameter Optimization Framework');
eq('HTML entities and tags in registry strings are decoded', op.booktitle, 'Proceedings of the 25th ACM SIGKDD International Conference on Knowledge Discovery & Data Mining');
eq('the URL is the canonical doi.org link', op.url, 'https://doi.org/10.1145/3292500.3330701');
eq('inline tags are stripped', fromCsl({ type: 'article-journal', title: 'Effects of <i>E. coli</i> on H<sub>2</sub>O', 'container-title': 'J', issued: { 'date-parts': [[2020]] } }).title, 'Effects of E. coli on H2O');

console.log('— ISBN sources —');
const ol = { title: 'Deep Learning', authors: [{ name: 'Ian Goodfellow' }, { name: 'Yoshua Bengio' }], publishers: [{ name: 'MIT Press' }], publish_places: [{ name: 'Cambridge, MA' }], publish_date: 'November 2016', identifiers: { isbn_13: ['9780262035613'] }, url: 'https://openlibrary.org/books/OL1' };
const olr = fromOpenLibrary(ol, '9780262035613');
eq('Open Library -> book', `${olr.type}|${olr.year}|${olr.publisher}|${olr.address}|${olr.isbn}`, 'book|2016|MIT Press|Cambridge, MA|9780262035613');
eq('Open Library author names split', `${olr.authors[0].family}|${olr.authors[0].given}`, 'Goodfellow|Ian');
const gb = { volumeInfo: { title: 'Deep Learning', subtitle: 'A Book', authors: ['Ian Goodfellow'], publisher: 'MIT Press', publishedDate: '2016-11-18', industryIdentifiers: [{ type: 'ISBN_10', identifier: '0262035618' }, { type: 'ISBN_13', identifier: '9780262035613' }], canonicalVolumeLink: 'https://books.google.com/x' } };
const gbr = fromGoogleBooks(gb);
eq('Google Books -> book with subtitle and ISBN-13', `${gbr.title}|${gbr.isbn}|${gbr.year}`, 'Deep Learning: A Book|9780262035613|2016');
eq('Google Books with no volumeInfo', fromGoogleBooks({}), null);

console.log('— PubMed summary —');
const pm = { uid: '31452104', title: 'Deep learning in medicine.', authors: [{ name: 'Smith J', authtype: 'Author' }, { name: 'Nguyen TM', authtype: 'Author' }], fulljournalname: 'Journal of Medical Systems', source: 'J Med Syst', volume: '43', issue: '10', pages: '1234-40', pubdate: '2019 Sep 3', elocationid: 'doi: 10.1007/s10916-019-1234-5', articleids: [{ idtype: 'doi', value: '10.1007/s10916-019-1234-5' }], issn: '0148-5598' };
const pmr = fromPubmedSummary(pm);
eq('esummary -> article', `${pmr.type}|${pmr.journal}|${pmr.volume}|${pmr.number}|${pmr.pages}`, 'article|Journal of Medical Systems|43|10|1234–1240');
eq('esummary names', `${pmr.authors[1].family}|${pmr.authors[1].given}`, 'Nguyen|T. M.');
eq('esummary DOI and PMID', `${pmr.doi}|${pmr.note}`, '10.1007/s10916-019-1234-5|PMID: 31452104');
eq('esummary error entry', fromPubmedSummary({ error: 'not found' }), null);
const jr = fromPubmedSummary({ uid: '1', title: 'T', authors: [{ name: 'de Azevedo WF Jr', authtype: 'Author' }], pubdate: '2019', source: 'J' });
eq('a PubMed name with a suffix keeps family, initials and suffix', `${jr.authors[0].family}|${jr.authors[0].given}|${jr.authors[0].suffix}`, 'de Azevedo|W. F.|Jr');

console.log('— workshop paper from the site cache —');
const ws = { name: 'AI Agents: Capabilities and Safety', conference: 'COLM', year: 2025, slug: 'colm-2025-aia' };
const paper = { title: 'Agentic Superoptimization', authors: ['Xuefei Wang', 'Jonathan Chen'], forum_url: 'https://openreview.net/forum?id=ozFyM0IVh1' };
const wp = fromWorkshopPaper(paper, ws);
eq('booktitle names the workshop, conference and year', wp.booktitle, 'AI Agents: Capabilities and Safety Workshop at COLM 2025');
eq('a name that already says Workshop is not doubled', fromWorkshopPaper(paper, { ...ws, name: 'Workshop on Agents' }).booktitle, 'Workshop on Agents at COLM 2025');
eq('authors and URL carried', `${wp.authors[0].family}|${wp.url}`, 'Wang|https://openreview.net/forum?id=ozFyM0IVh1');
check('BibTeX is @inproceedings', toBibtex(wp).startsWith('@inproceedings{wang2025agentic,'));

console.log('— identifiers —');
const cases = [
  ['10.1145/3292500.3330701', 'doi', '10.1145/3292500.3330701'],
  ['doi:10.1000/xyz.12.', 'doi', '10.1000/xyz.12'],
  ['https://doi.org/10.1000/xyz.12', 'doi', '10.1000/xyz.12'],
  ['https://dl.acm.org/doi/10.1145/3292500.3330701', 'doi', '10.1145/3292500.3330701'],
  ['https://arxiv.org/abs/2106.09685v2', 'arxiv', '2106.09685'],
  ['https://arxiv.org/pdf/2106.09685.pdf', 'arxiv', '2106.09685'],
  ['2106.09685', 'arxiv', '2106.09685'],
  ['arXiv:1810.04805', 'arxiv', '1810.04805'],
  ['hep-th/9901001', 'arxiv', 'hep-th/9901001'],
  ['10.48550/arXiv.2106.09685', 'arxiv', '2106.09685'],
  ['978-0-262-03561-3', 'isbn', '9780262035613'],
  ['ISBN 0262035618', 'isbn', '0262035618'],
  ['0-306-40615-2', 'isbn', '0306406152'],
  ['31452104', 'pmid', '31452104'],
  ['PMID: 12345', 'pmid', '12345'],
  ['https://pubmed.ncbi.nlm.nih.gov/31452104/', 'pmid', '31452104'],
  ['https://openreview.net/forum?id=ozFyM0IVh1', 'openreview', 'ozFyM0IVh1'],
  ['https://openreview.net/pdf?id=ozFyM0IVh1', 'openreview', 'ozFyM0IVh1'],
  ['https://example.com/page', 'url', 'https://example.com/page'],
  ['example.com/page', 'url', 'https://example.com/page'],
  ['Attention is all you need', 'query', 'Attention is all you need'],
  ['   ', 'query', ''],
];
for (const [input, kind, value] of cases) {
  const got = classify(input);
  eq(`classify ${JSON.stringify(input)}`, `${got.kind}|${got.value}`, `${kind}|${value}`);
}
eq('arXiv version is kept aside', classify('https://arxiv.org/abs/2106.09685v2').version, '2');
check('ISBN-10 checksum', isbnValid('0306406152') && !isbnValid('0306406153'));
check('ISBN-13 checksum', isbnValid('9780262035613') && !isbnValid('9780262035614'));
eq('ISBN-10 -> ISBN-13', isbn13('0262035618'), '9780262035613');
eq('arXiv DOI', arxivDoi('2106.09685'), '10.48550/arXiv.2106.09685');
eq('a 13-digit string with a bad checksum is not an ISBN', classify('9780262035614').kind, 'query');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
