#!/usr/bin/env node
/**
 * Pins the citation model: LaTeX <-> text, name parsing, BibTeX reading and
 * writing, and the four reference styles (APA 7, MLA 9, IEEE, ACM) the
 * /tools/ pages emit. Every rule a tool page relies on is a line here, so a
 * change that reorders authors or drops a DOI fails before it ships.
 *
 * Run: node scripts/citations_test.mjs
 */
import {
  latexToText, textToLatex, parseNames, parseOneName, initials, formatName, namesToBibtex,
  bibtexKey, protectCapitals, toBibtex, formatApa, formatMla, formatIeee, formatAcm, formatAll, render,
} from '../lib/citations.mjs';
import { parseBibtex, cleanDoi } from '../lib/bibtex_parse.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ''}`); }
}
const eq = (name, got, want) => check(name, got === want, `got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);

console.log('— LaTeX to text —');
eq('accents in braces', latexToText("Fern{\\'a}ndez and Jos{\\'{e}}"), 'Fernández and José');
eq('umlaut and hacek', latexToText('M{\\"u}ller, {\\v{S}}koda, \\v{c}'), 'Müller, Škoda, č');
eq('ligatures', latexToText('{\\L}ukasz, {\\ss}, \\o{}, \\AE'), 'Łukasz, ß, ø, Æ');
eq('cedilla and dotless i', latexToText("Fran\\c{c}ois, \\'{\\i}"), 'François, í');
eq('text commands unwrap', latexToText('\\textbf{Bold} and \\emph{\\textit{nested}}'), 'Bold and nested');
eq('escapes and dashes', latexToText('A \\& B, 50\\% done, pp. 1--10, x---y'), 'A & B, 50% done, pp. 1–10, x—y');
eq('protective braces vanish', latexToText('{BERT}: {Pre-training} of {{Deep}} models'), 'BERT: Pre-training of Deep models');
eq('unknown command keeps its argument', latexToText('\\foo{bar} baz'), 'bar baz');
eq('textToLatex escapes markup, keeps math', textToLatex('A & B: 10% of $x_1$ and x_2'), 'A \\& B: 10\\% of $x_1$ and x\\_2');

console.log('— names —');
const n = parseNames('Vaswani, Ashish and Noam Shazeer and van der Berg, Anna and Jean-Pierre Dupont and {The OpenAI Team} and others');
eq('six names parsed', n.length, 6);
eq('"Family, Given"', `${n[0].family}|${n[0].given}`, 'Vaswani|Ashish');
eq('"Given Family"', `${n[1].family}|${n[1].given}`, 'Shazeer|Noam');
eq('particles stay with the family name', `${n[2].family}|${n[2].given}`, 'van der Berg|Anna');
eq('particles are found in "Given Family" order too', parseOneName('Ludwig van Beethoven').family, 'van Beethoven');
eq('hyphenated given name', n[3].given, 'Jean-Pierre');
eq('braced name is literal', n[4].literal, 'The OpenAI Team');
eq('"others" is a marker', n[5].literal, 'others');
eq('suffix "Family, Jr., Given"', JSON.stringify(parseOneName('King, Jr., Martin Luther')), JSON.stringify({ family: 'King', given: 'Martin Luther', suffix: 'Jr.', literal: '' }));
eq('initials', initials('Jean-Pierre Marie'), 'J.-P. M.');
eq('initials from dotted input', initials('A.B.'), 'A. B.');
eq('APA shape', formatName(n[0], 'family-initials'), 'Vaswani, A.');
eq('IEEE shape', formatName(n[3], 'initials-family'), 'J.-P. Dupont');
eq('MLA first-author shape', formatName(n[2], 'family-given'), 'van der Berg, Anna');
eq('ACM shape', formatName(n[0], 'given-family'), 'Ashish Vaswani');
eq('back to BibTeX', namesToBibtex(n.slice(0, 2)), 'Vaswani, Ashish and Shazeer, Noam');
eq('literal back to BibTeX is braced', namesToBibtex([n[4], n[5]]), '{The OpenAI Team} and others');

console.log('— BibTeX writing —');
const vaswani = {
  type: 'inproceedings', key: null,
  title: 'Attention is all you need',
  authors: parseNames('Vaswani, Ashish and Shazeer, Noam'),
  editors: [], year: '2017', month: 12,
  journal: '', booktitle: 'Advances in Neural Information Processing Systems',
  volume: '30', number: '', pages: '5998–6008', publisher: 'Curran Associates, Inc.', address: '',
  institution: '', school: '', edition: '', series: '', doi: null, url: null, isbn: null, issn: null,
  eprint: null, archivePrefix: null, primaryClass: null, note: null, howpublished: null, accessed: null,
};
eq('key = family + year + first real title word', bibtexKey(vaswani), 'vaswani2017attention');
eq('key skips stopwords', bibtexKey({ ...vaswani, title: 'On the Importance of Things' }), 'vaswani2017importance');
eq('key strips accents', bibtexKey({ ...vaswani, authors: parseNames('Müller, Jörg') }), 'muller2017attention');
eq('protectCapitals braces inner capitals only', protectCapitals('BERT: Pre-training of Deep Bidirectional Models with LoRA and GPUs'), '{BERT}: Pre-training of Deep Bidirectional Models with {LoRA} and {GPUs}');
const bib = toBibtex(vaswani);
check('entry type and key', bib.startsWith('@inproceedings{vaswani2017attention,'), bib);
check('pages use a double hyphen', bib.includes('pages        = {5998--6008}'), bib);
check('month is a macro, unbraced', /month\s+= dec[,\n]/.test(bib), bib);
check('author field joins with "and"', bib.includes('author       = {Vaswani, Ashish and Shazeer, Noam}'), bib);
check('ampersand is escaped in a title', toBibtex({ ...vaswani, title: 'Cats & dogs' }).includes('{Cats \\& dogs}'));
check('a journal article drops the registry publisher', !toBibtex({ ...vaswani, type: 'article', journal: 'Nature', publisher: 'Springer Science and Business Media LLC' }).includes('publisher'));
check('howpublished keeps a \\url{} command unescaped', toBibtex({ ...vaswani, type: 'misc', howpublished: '\\url{https://example.com/a_b}', booktitle: '', pages: null, publisher: '' }).includes('howpublished = {\\url{https://example.com/a_b}}'));

console.log('— BibTeX reading —');
const src = `@comment{ignored}
@string{nips = "Advances in Neural Information Processing Systems"}
@InProceedings{vaswani2017attention,
  title     = {Attention is all you need},
  author    = "Vaswani, Ashish and Shazeer, Noam",
  booktitle = nips # ", Volume 30",
  pages     = {5998--6008},
  year      = 2017,
  month     = dec,
  url       = {https://doi.org/10.5555/3295222.3295349}
}
@article{devlin2019bert, title = "{BERT}: Pre-training of Deep Bidirectional Transformers", author = "Devlin, Jacob and Chang, Ming-Wei", journal = {NAACL}, year = {2019}, doi = {https://doi.org/10.18653/v1/N19-1423}}
@misc{lora, author = {Hu, Edward J.}, title = {LoRA}, year = 2021, eprint = {2106.09685}, archivePrefix = {arXiv}, primaryClass = {cs.LG}}
@phdthesis{t, author = {Doe, Jane}, title = {Thesis}, school = {MIT}, year = {2020}, type = {Master's thesis}}
@book{broken, title = {Unbalanced {brace}, author = {X}}
`;
const parsed = parseBibtex(src);
eq('entries read (broken final entry skipped or reported)', parsed.refs.length >= 4, true);
const [v, d, l, t] = parsed.refs;
eq('type is normalised', v.type, 'inproceedings');
eq('key kept', v.key, 'vaswani2017attention');
eq('macro concatenation', v.booktitle, 'Advances in Neural Information Processing Systems, Volume 30');
eq('quoted author field', v.authors.length, 2);
eq('month macro to number', v.month, 12);
eq('pages en-dash', v.pages, '5998–6008');
eq('DOI recovered from a doi.org URL', v.doi, '10.5555/3295222.3295349');
eq('braces stripped from the title', d.title, 'BERT: Pre-training of Deep Bidirectional Transformers');
eq('doi field with a URL prefix is cleaned', d.doi, '10.18653/v1/N19-1423');
eq('cleanDoi', cleanDoi('doi:10.1/x'), '10.1/x');
eq('arXiv eprint kept', `${l.eprint}|${l.archivePrefix}|${l.primaryClass}`, '2106.09685|arXiv|cs.LG');
eq('phdthesis with a Master type becomes mastersthesis', t.type, 'mastersthesis');
check('round trip keeps the DOI', toBibtex(d).includes('doi          = {10.18653/v1/N19-1423}'));

console.log('— APA 7 —');
eq('conference paper', formatApa(v).text, 'Vaswani, A., & Shazeer, N. (2017). Attention is all you need. In Advances in Neural Information Processing Systems, Volume 30 (pp. 5998–6008). https://doi.org/10.5555/3295222.3295349');
eq('journal article', formatApa({ ...vaswani, type: 'article', journal: 'Nature', volume: '521', number: '7553', pages: '436–444', doi: '10.1038/nature14539', booktitle: '' }).text, 'Vaswani, A., & Shazeer, N. (2017). Attention is all you need. Nature, 521(7553), 436–444. https://doi.org/10.1038/nature14539');
eq('book, italic title, edition, no URL', formatApa({ ...vaswani, type: 'book', title: 'Deep learning', edition: '2', publisher: 'MIT Press', booktitle: '', pages: null }).text, 'Vaswani, A., & Shazeer, N. (2017). Deep learning (2nd ed.). MIT Press.');
eq('arXiv preprint', formatApa(l).text, 'Hu, E. J. (2021). LoRA (arXiv:2106.09685). arXiv.');
eq('thesis', formatApa(t).text, "Doe, J. (2020). Thesis [Master's thesis, MIT].");
eq('one author', formatApa({ ...vaswani, authors: parseNames('Vaswani, Ashish'), booktitle: 'NeurIPS', pages: null, publisher: '' }).text, 'Vaswani, A. (2017). Attention is all you need. In NeurIPS.');
eq('three authors use serial comma and ampersand', formatApa({ ...vaswani, authors: parseNames('A, X and B, Y and C, Z'), booktitle: 'P', pages: null, publisher: '' }).text, 'A, X., B, Y., & C, Z. (2017). Attention is all you need. In P.');
const many = parseNames(Array.from({ length: 22 }, (_, i) => `Author${i + 1}, A`).join(' and '));
check('more than 20 authors: 19, ellipsis, last', formatApa({ ...vaswani, authors: many }).text.includes('Author19, A., … Author22, A. (2017)'));
eq('no author: title first', formatApa({ ...vaswani, authors: [], type: 'misc', title: 'Some page', booktitle: '', pages: null, publisher: '', howpublished: 'Web' }).text, 'Some page. (2017). Web.');
eq('"and others" becomes et al.', formatApa({ ...vaswani, authors: parseNames('Vaswani, Ashish and others'), booktitle: 'P', pages: null, publisher: '' }).text, 'Vaswani, A., et al. (2017). Attention is all you need. In P.');
const html = formatApa({ ...vaswani, type: 'book', title: 'Cats & <dogs>', publisher: 'P', booktitle: '', pages: null }).html;
check('HTML output italicises and escapes', html.includes('<i>Cats &amp; &lt;dogs&gt;</i>'), html);

console.log('— MLA 9 —');
eq('two authors', formatMla(v).text, 'Vaswani, Ashish, and Noam Shazeer. "Attention is all you need." Advances in Neural Information Processing Systems, Volume 30, 2017, pp. 5998–6008. https://doi.org/10.5555/3295222.3295349.');
eq('three or more authors: et al.', formatMla({ ...vaswani, authors: parseNames('A, X and B, Y and C, Z'), booktitle: 'P', pages: null, publisher: '' }).text, 'A, X, et al. "Attention is all you need." P, 2017.');
eq('journal article', formatMla({ ...vaswani, type: 'article', journal: 'Nature', volume: '521', number: '7553', pages: '436–444', doi: '10.1038/nature14539', booktitle: '' }).text, 'Vaswani, Ashish, and Noam Shazeer. "Attention is all you need." Nature, vol. 521, no. 7553, 2017, pp. 436–444. https://doi.org/10.1038/nature14539.');
eq('book', formatMla({ ...vaswani, type: 'book', title: 'Deep Learning', publisher: 'MIT Press', booktitle: '', pages: null }).text, 'Vaswani, Ashish, and Noam Shazeer. Deep Learning. MIT Press, 2017.');

console.log('— IEEE —');
eq('numbered conference paper', formatIeee(v, 3).text, '[3] A. Vaswani and N. Shazeer, "Attention is all you need," in Advances in Neural Information Processing Systems, Volume 30, Dec. 2017, pp. 5998–6008, doi: 10.5555/3295222.3295349.');
eq('journal article with month', formatIeee({ ...vaswani, type: 'article', journal: 'Nature', volume: '521', number: '7553', pages: '436–444', doi: '10.1038/nature14539', booktitle: '', month: 5 }, 1).text, '[1] A. Vaswani and N. Shazeer, "Attention is all you need," Nature, vol. 521, no. 7553, pp. 436–444, May 2017, doi: 10.1038/nature14539.');
eq('seven or more authors: et al.', formatIeee({ ...vaswani, authors: parseNames('A, X and B, Y and C, Z and D, W and E, V and F, U and G, T'), booktitle: 'P', pages: null, publisher: '', month: null }).text, 'X. A et al., "Attention is all you need," in P, 2017.');
eq('arXiv', formatIeee(l).text, 'E. J. Hu, "LoRA," arXiv:2106.09685, 2021.');
eq('book with place and publisher', formatIeee({ ...vaswani, type: 'book', title: 'Deep Learning', publisher: 'MIT Press', address: 'Cambridge, MA', booktitle: '', pages: null, month: null }).text, 'A. Vaswani and N. Shazeer, Deep Learning. Cambridge, MA: MIT Press, 2017.');

console.log('— ACM —');
eq('conference paper', formatAcm(v).text, 'Ashish Vaswani and Noam Shazeer. 2017. Attention is all you need. In Advances in Neural Information Processing Systems, Volume 30. 5998–6008. https://doi.org/10.5555/3295222.3295349');
eq('journal article with month', formatAcm({ ...vaswani, type: 'article', journal: 'Nature', volume: '521', number: '7553', pages: '436–444', doi: '10.1038/nature14539', booktitle: '', month: 5 }).text, 'Ashish Vaswani and Noam Shazeer. 2017. Attention is all you need. Nature 521, 7553 (May 2017), 436–444. https://doi.org/10.1038/nature14539');
eq('three authors: serial "and"', formatAcm({ ...vaswani, authors: parseNames('A, X and B, Y and C, Z'), booktitle: 'P', pages: null, publisher: '', doi: null }).text, 'X A, Y B, and Z C. 2017. Attention is all you need. In P.');
eq('arXiv', formatAcm(l).text, 'Edward J. Hu. 2021. LoRA. arXiv:2106.09685.');

console.log('— formatAll and render —');
const all = formatAll(v);
check('formatAll carries five outputs', ['apa', 'mla', 'ieee', 'acm', 'bibtex'].every((k) => all[k]));
eq('render collapses whitespace before punctuation', render('a , b .').text, 'a, b.');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
