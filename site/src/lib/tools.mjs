/**
 * The registry of free tools under /tools/: one entry per page, one keyword
 * per entry.
 *
 * Each tool page is built from its entry here (ToolPage.astro reads it), and
 * scripts/tools_registry_test.mjs checks the rules the pages live by: the
 * keyword appears in the <title>, the meta description and the H1; the FAQ
 * has real questions; the copy carries no em dashes; every entry has a page
 * and every page an entry. Plain JavaScript on purpose, so the test can import
 * it under node without Astro.
 *
 * The /tools/ index shows `blurb`, not `lede`: one line in a fixed shape,
 * "what you give it. what you get.", ten words at most. The lede is the
 * tool page's opening paragraph, and seventeen of them stacked as cards made
 * the index a wall of near-identical "Paste ... and get ..." text. Each card
 * also carries the tool's icon, site/src/assets/tools/<slug>.svg, keyed by
 * slug rather than by a field here so the registry test can insist on one
 * icon per tool and one tool per icon (lib/icons.mjs inlines them).
 * The pages stay separate: the index is a list, the pages are what rank.
 *
 * Why these tools: they are the keywords with measured search demand, low
 * competition and a job a researcher does while writing a paper (the
 * research is recorded in docs/ARCHITECTURE.md, "Free tools"). Anything that
 * would need a server, an LLM or a paid API is not here by design.
 */

export const GROUPS = {
  citations: 'Citations & references',
  latex: 'LaTeX',
  deadlines: 'Deadlines & time zones',
};

export const TOOLS = [
  // ---------------------------------------------------------------- citations
  {
    slug: 'doi-finder',
    group: 'citations',
    blurb: 'A paper title or reference line. Its DOI.',
    name: 'DOI Finder',
    keyword: 'DOI finder',
    title: 'DOI Finder: Find the DOI of Any Paper or Article (Free)',
    description: 'Free DOI finder. Paste a paper title or a reference and get its DOI from Crossref and DataCite, with a one-click BibTeX citation. No sign-up.',
    h1: 'DOI finder',
    lede: 'Paste a paper title, a reference line, or an author and year. The finder searches Crossref and DataCite and returns the DOI with a copyable link.',
    howTo: [
      'Paste the title of the paper, or the whole reference line from a bibliography.',
      'Press Find. The best matches appear with their authors, venue and year.',
      'Copy the DOI, open it, or click Cite to get BibTeX and formatted references for it.',
    ],
    why: [
      'A DOI is the one identifier that survives a journal moving its website or a preprint becoming a paper. Reference managers, submission systems and many journals ask for it, and a reference without one is the first thing a copy editor sends back.',
      'Searching for a DOI by hand means opening the publisher page and hunting for it. This page asks the two registries that assign DOIs, Crossref for journals and conference proceedings and DataCite for arXiv and datasets, and shows what they know.',
    ],
    faqs: [
      { q: 'How do I find the DOI of an article?', a: 'Paste its title into the box above and press Find. The DOI is shown under the matching title. If you only have a citation, paste the whole line; the search ignores the parts it cannot match.' },
      { q: 'Why does my paper have no DOI?', a: 'Not everything gets one. Many workshop papers, older conference papers and theses were never registered. arXiv preprints do have DOIs (10.48550/arXiv followed by the arXiv id), and this finder returns those through DataCite.' },
      { q: 'Where does the data come from?', a: 'Crossref, the registry used by almost every publisher, and DataCite, which registers arXiv, Zenodo and dataset DOIs. Both are queried live from your browser; nothing is stored here.' },
      { q: 'Is the first result always the right paper?', a: 'Usually, but not always. Check the authors and year before copying. A short or generic title can match several papers, and a preprint and its published version are two different records.' },
      { q: 'Can I get a citation from the DOI?', a: 'Yes. Every result has a Cite button that opens the BibTeX generator with the DOI filled in, and from there APA, MLA, IEEE and ACM.' },
    ],
    related: ['bibtex-citation-generator', 'doi-to-bibtex', 'bibtex-to-apa'],
  },
  {
    slug: 'bibtex-citation-generator',
    group: 'citations',
    blurb: 'Any paper identifier or link. BibTeX.',
    name: 'BibTeX Citation Generator',
    keyword: 'BibTeX citation generator',
    title: 'BibTeX Citation Generator: DOI, arXiv, ISBN or URL to BibTeX (Free)',
    description: 'Free BibTeX citation generator. Paste a DOI, arXiv link, ISBN, PubMed id, OpenReview link or URL and get a clean BibTeX entry with a sensible key.',
    h1: 'BibTeX citation generator',
    lede: 'Paste any identifier and get a BibTeX entry you can drop into your .bib file: a DOI, an arXiv id or link, an ISBN, a PubMed id, an OpenReview link, or a web page.',
    howTo: [
      'Paste a DOI, arXiv id or link, ISBN, PubMed id, OpenReview link or any URL.',
      'Press Generate. The entry appears with a key built from the first author, year and first title word.',
      'Copy it into your .bib file, or switch to APA, MLA, IEEE or ACM below the entry.',
    ],
    why: [
      'Publisher BibTeX exports are inconsistent: keys like Smith_2020, titles with braces around every word, months as numbers, journal names in capitals. This generator writes one consistent shape from the registry metadata, so a bibliography built from many sources looks like one bibliography.',
      'For arXiv papers it fills eprint, archivePrefix and primaryClass, the fields the arXiv style guides ask for. For workshop papers hosted on OpenReview it adds the workshop\'s full name with its conference and year, which no registry provides.',
    ],
    faqs: [
      { q: 'What can I paste?', a: 'A DOI in any form (bare, doi:, or a doi.org link), an arXiv id or abs/pdf link, an ISBN-10 or ISBN-13, a PubMed id or link, an OpenReview forum link, or any URL that contains a DOI. A plain web page becomes an @misc entry with the URL and access date.' },
      { q: 'How is the citation key chosen?', a: 'First author\'s family name, year, and the first word of the title that is not a stopword, all lowercase: vaswani2017attention. Edit it in the box before copying if your .bib file uses another convention.' },
      { q: 'Why are some words in the title wrapped in braces?', a: 'BibTeX styles may lowercase titles. Words with a capital letter inside them, such as BERT, LoRA or GPUs, are wrapped in braces so they keep their case. Other words are left alone.' },
      { q: 'Does it handle accents and Unicode?', a: 'Yes. Names and titles are written as Unicode, which biber and inputenc both read. If you use classic bibtex without inputenc, replace the accented characters with their LaTeX form.' },
      { q: 'Is anything uploaded or stored?', a: 'No. Your browser talks directly to Crossref, DataCite, Open Library and PubMed; this site sees nothing and stores nothing.' },
    ],
    related: ['doi-to-bibtex', 'doi-finder', 'ris-to-bibtex', 'bibtex-to-apa'],
  },
  {
    slug: 'doi-to-bibtex',
    group: 'citations',
    blurb: 'A DOI or doi.org link. A clean BibTeX entry.',
    name: 'DOI to BibTeX',
    keyword: 'DOI to BibTeX',
    title: 'DOI to BibTeX Converter (Free, No Sign-up)',
    description: 'Convert a DOI to BibTeX in one click. Works for journal articles, conference papers, books, arXiv preprints and datasets, with a clean citation key.',
    h1: 'DOI to BibTeX',
    lede: 'Paste a DOI, or a doi.org link, and get a BibTeX entry with a clean key and the fields your bibliography style expects.',
    howTo: [
      'Paste the DOI (10.1145/... or a doi.org link). Several DOIs on separate lines are converted together.',
      'Press Convert.',
      'Copy the entry, or download all entries as a .bib file.',
    ],
    why: [
      'The DOI is on the paper and in the reference you are copying from; the BibTeX is not. Resolving it by hand means a publisher page, a Cite button that may or may not exist, and an export you then clean up.',
      'This converter asks the DOI registry itself through content negotiation, the same mechanism reference managers use, and writes the entry in one consistent shape.',
    ],
    faqs: [
      { q: 'Which DOIs work?', a: 'Any DOI registered with Crossref or DataCite, which covers nearly all journal articles, conference proceedings, books and chapters, plus arXiv preprints, Zenodo records and datasets.' },
      { q: 'What does an arXiv DOI produce?', a: 'An @misc entry with eprint, archivePrefix and primaryClass set, plus the arXiv abstract page URL. That is the form the arXiv citation guidelines recommend.' },
      { q: 'Can I convert many DOIs at once?', a: 'Yes. Put one DOI per line. Entries that could not be resolved are listed by DOI so you can check them.' },
      { q: 'The entry type is wrong. Why?', a: 'The type comes from the registry record. Publishers sometimes register a proceedings paper as a journal article; the converter fixes the obvious case (a paper with an event but no journal) and otherwise reports what the publisher said. Edit the type before copying.' },
    ],
    related: ['bibtex-citation-generator', 'doi-finder', 'url-to-bibtex', 'bibtex-to-ieee'],
  },
  {
    slug: 'ris-to-bibtex',
    group: 'citations',
    blurb: 'An RIS export or .ris file. A .bib file.',
    name: 'RIS to BibTeX',
    keyword: 'RIS to BibTeX',
    title: 'RIS to BibTeX Converter (Free, Works in Your Browser)',
    description: 'RIS to BibTeX converter for EndNote, Zotero, Mendeley, Scopus and Web of Science exports. Paste or upload a .ris file and download the .bib. Nothing is uploaded.',
    h1: 'RIS to BibTeX',
    lede: 'Paste an RIS export, or upload a .ris file, and download a .bib file with every record converted.',
    howTo: [
      'Export your references as RIS from EndNote, Zotero, Mendeley, Scopus, Web of Science or a publisher\'s Cite button.',
      'Paste the text or pick the .ris file.',
      'Press Convert, then copy the result or download it as a .bib file.',
    ],
    why: [
      'Half the tools in academic publishing speak RIS and the other half speak BibTeX. Moving a reference list from a manager or a database export into a LaTeX manuscript is this conversion, done once per project.',
      'The conversion runs in your browser: the file never leaves your machine, and a library of several thousand records converts in a second.',
    ],
    faqs: [
      { q: 'Which RIS record types are supported?', a: 'JOUR, EJOUR and MGZN become @article; CONF and CPAPER become @inproceedings; BOOK and EBOOK become @book; CHAP becomes @incollection; THES becomes @phdthesis or @mastersthesis; RPRT becomes @techreport; everything else becomes @misc.' },
      { q: 'What happens to fields BibTeX has no name for?', a: 'Keywords, abstracts and notes are dropped; the fields a bibliography style prints (authors, title, journal or book title, volume, issue, pages, year, publisher, DOI, URL, ISBN) are kept.' },
      { q: 'How are pages handled?', a: 'SP and EP become a page range with a double hyphen (100--110), which BibTeX styles typeset as an en dash.' },
      { q: 'My file has thousands of records. Is there a limit?', a: 'No practical one. Conversion is local and takes a second for a few thousand records.' },
    ],
    related: ['bibtex-citation-generator', 'nbib-to-bibtex', 'doi-to-bibtex', 'bibtex-to-apa'],
  },
  {
    slug: 'isbn-to-bibtex',
    group: 'citations',
    blurb: 'An ISBN. A @book entry with publisher and year.',
    name: 'ISBN to BibTeX',
    keyword: 'ISBN to BibTeX',
    title: 'ISBN to BibTeX: Cite a Book from Its ISBN (Free)',
    description: 'ISBN to BibTeX in one step: an ISBN-10 or ISBN-13 becomes a @book entry with authors, publisher, year and place, from Open Library and Google Books. Free.',
    h1: 'ISBN to BibTeX',
    lede: 'Type or paste the ISBN from the back of the book and get a @book entry with the authors, publisher, year and place of publication.',
    howTo: [
      'Paste the ISBN, with or without hyphens. ISBN-10 and ISBN-13 both work.',
      'Press Convert. The book\'s details are looked up in Open Library, then Google Books if needed.',
      'Check the edition and year, then copy the entry.',
    ],
    why: [
      'Books are the references most often typed by hand, and the ones with the most typos in author lists and publisher names. The ISBN pins the exact edition, and the library record has the details right.',
      'Two sources are consulted because neither is complete: Open Library covers most books and Google Books fills the gaps.',
    ],
    faqs: [
      { q: 'Which ISBN should I use, 10 or 13?', a: 'Either. The check digit is verified before the lookup, so a mistyped digit is caught immediately.' },
      { q: 'The book was not found. What now?', a: 'Recent and academic books are sometimes missing from both catalogues. Try the ISBN printed on the copyright page rather than the barcode, or the ISBN of the hardcover edition. Otherwise fill the @book template that appears so you at least start from the right shape.' },
      { q: 'Why is the year the edition year, not the first publication year?', a: 'The ISBN identifies one edition, and the record reports that edition\'s publication date. For a classic text, cite the edition you actually used.' },
      { q: 'Does the entry include the ISBN?', a: 'Yes, as an isbn field, which biblatex prints and classic BibTeX styles ignore.' },
    ],
    related: ['bibtex-citation-generator', 'doi-to-bibtex', 'bibtex-to-apa', 'bibtex-to-mla'],
  },
  {
    slug: 'nbib-to-bibtex',
    group: 'citations',
    blurb: 'PubMed\'s NBIB export or a PubMed id. @article entries.',
    name: 'NBIB to BibTeX (PubMed)',
    keyword: 'NBIB to BibTeX',
    title: 'NBIB to BibTeX: Convert PubMed Citations to BibTeX (Free)',
    description: 'NBIB to BibTeX converter for PubMed: paste the export from PubMed\'s Cite button, an .nbib file or a PMID and get @article entries with the DOI. Free.',
    h1: 'NBIB to BibTeX',
    lede: 'Paste the NBIB text PubMed exports, or just a PubMed id, and get @article entries with full author names, journal, volume, pages and DOI.',
    howTo: [
      'On PubMed, open Cite and choose Download .nbib, or use Send to, then Citation manager. You can also paste a PMID or a PubMed link.',
      'Paste the text or pick the .nbib file.',
      'Press Convert, then copy the entries or download them as a .bib file.',
    ],
    why: [
      'PubMed\'s own Cite button offers AMA, APA, MLA and NLM, but not BibTeX. The NBIB export has everything a BibTeX entry needs, in a format nothing else reads.',
      'Full author names come from the FAU lines, so the entry says Nguyen, Thi Minh rather than Nguyen TM, and the DOI is taken from the AID line.',
    ],
    faqs: [
      { q: 'What is an NBIB file?', a: 'PubMed\'s export format, also called MEDLINE format: one tagged line per field (PMID, TI, FAU, JT, DP, VI, IP, PG, AID). It is what PubMed downloads when you choose Citation manager.' },
      { q: 'Can I paste a PMID instead of a file?', a: 'Yes. A bare PubMed id, PMID: 12345, or a pubmed.ncbi.nlm.nih.gov link is looked up through NCBI\'s E-utilities and converted the same way.' },
      { q: 'Why are the page numbers longer than in PubMed?', a: 'PubMed abbreviates ranges (1234-40). The entry expands them to 1234--1240, which every bibliography style prints correctly.' },
      { q: 'Is the PMID kept?', a: 'Yes, in the note field and as the URL, so the entry still points back to PubMed when the DOI is missing.' },
    ],
    related: ['ris-to-bibtex', 'bibtex-citation-generator', 'doi-to-bibtex', 'bibtex-to-apa'],
  },
  {
    slug: 'url-to-bibtex',
    group: 'citations',
    blurb: 'A link to a paper or page. A BibTeX entry.',
    name: 'URL to BibTeX',
    keyword: 'URL to BibTeX',
    title: 'URL to BibTeX: Cite a Web Page, arXiv Link or Paper URL (Free)',
    description: 'URL to BibTeX: paste a link and get an entry. DOI, arXiv, PubMed and OpenReview paper links become full entries; any other page becomes an @misc with the access date.',
    h1: 'URL to BibTeX',
    lede: 'Paste the link. If it points at a paper (a DOI on a publisher page, arXiv, PubMed, or an OpenReview workshop paper), you get the full entry; for any other page you get an @misc entry with the URL and today\'s access date.',
    howTo: [
      'Paste the URL from your browser\'s address bar.',
      'Press Convert. Paper links resolve to full entries; other pages get an @misc entry.',
      'For a plain web page, add the title and author if you know them, then copy.',
    ],
    why: [
      'The link is what you have; the BibTeX is what the manuscript needs. Publisher pages hide the DOI in the address, arXiv links carry the paper id, and OpenReview links carry the forum id. The page reads the identifier out of the URL and resolves it, instead of asking you to find it.',
      'Web pages without an identifier still need citing. The @misc entry follows the shape biblatex and the common .bst files expect: title, author, howpublished with the URL, year, and the date you accessed it.',
    ],
    faqs: [
      { q: 'Which links are resolved to full entries?', a: 'Any URL containing a DOI (dl.acm.org, ieeexplore, springer, nature, wiley, sciencedirect, doi.org), arXiv abs or pdf links, PubMed links, and OpenReview forum links for the workshop papers this site tracks.' },
      { q: 'What about a page with no identifier?', a: 'You get an @misc entry with the URL in howpublished, a note with the access date, and empty title and author fields to fill in. Web page metadata cannot be read from another site by a browser page, so those two fields are yours.' },
      { q: 'How are OpenReview links handled?', a: 'The forum id is looked up in this site\'s index of workshop papers. If the paper is there, the entry gets the workshop\'s full name with its conference and year as the booktitle.' },
      { q: 'Why does the access date matter?', a: 'Web pages change. Styles that cite web pages (APA, MLA, IEEE) ask for the date you saw the page, and biblatex prints the urldate field.' },
    ],
    related: ['bibtex-citation-generator', 'doi-to-bibtex', 'doi-finder', 'bibtex-to-mla'],
  },
  {
    slug: 'bibtex-to-apa',
    group: 'citations',
    blurb: 'BibTeX or a DOI. APA 7 references, alphabetised.',
    name: 'BibTeX to APA',
    keyword: 'BibTeX to APA',
    title: 'BibTeX to APA Converter: APA 7 References from a .bib File (Free)',
    description: 'Convert BibTeX to APA 7th edition references. Paste an entry, a whole .bib file or a DOI and get an alphabetised reference list for Word or Google Docs.',
    h1: 'BibTeX to APA',
    lede: 'Paste BibTeX entries, or a DOI, and get APA 7th edition references, alphabetised, with italics in place, ready to paste into a document.',
    howTo: [
      'Paste one or more BibTeX entries, or a DOI, arXiv id or ISBN.',
      'Press Convert. The references appear in APA order (alphabetical by first author).',
      'Copy the list with formatting into Word or Google Docs, or copy it as plain text.',
    ],
    why: [
      'Not every venue takes LaTeX. A grant application, a thesis in Word, a journal that wants APA: the references you already have in a .bib file have to become formatted text, and doing it by hand is where the mistakes go in.',
      'The converter follows the APA 7 rules for the cases that matter: up to 20 authors listed, an ampersand before the last, italics on journal names and volumes, the DOI as a link, and arXiv preprints cited as preprints.',
    ],
    faqs: [
      { q: 'Which edition of APA?', a: 'APA 7th edition (2020). Author lists of up to 20 names are written in full; longer lists show the first 19, an ellipsis, and the last author.' },
      { q: 'Does it convert in-text citations?', a: 'No. It produces the reference list. In-text citations follow from the entries: (Vaswani et al., 2017) for three or more authors, (Smith & Doe, 2021) for two.' },
      { q: 'Are titles converted to sentence case?', a: 'No. APA wants sentence case for article titles, but a converter cannot tell a proper noun from a capitalised word, so titles are kept as written. Check them before submitting.' },
      { q: 'Can I paste a DOI instead of BibTeX?', a: 'Yes. A DOI, arXiv id or ISBN is resolved first and then formatted, so you can build a reference list without touching BibTeX at all.' },
    ],
    related: ['bibtex-to-mla', 'bibtex-to-ieee', 'acm-citation-generator', 'bibtex-citation-generator'],
  },
  {
    slug: 'bibtex-to-mla',
    group: 'citations',
    blurb: 'BibTeX or a DOI. MLA 9 Works Cited entries.',
    name: 'BibTeX to MLA',
    keyword: 'BibTeX to MLA',
    title: 'BibTeX to MLA Converter: MLA 9 Works Cited from BibTeX (Free)',
    description: 'BibTeX to MLA converter: MLA 9th edition Works Cited entries from a .bib file or a DOI, ready to copy into your document. Free, no sign-up.',
    h1: 'BibTeX to MLA',
    lede: 'Paste BibTeX entries, or a DOI, and get MLA 9th edition Works Cited entries with the containers, volume and issue numbers and page ranges in MLA\'s order.',
    howTo: [
      'Paste one or more BibTeX entries, or a DOI, arXiv id or ISBN.',
      'Press Convert. Entries are ordered alphabetically by first author, as a Works Cited list is.',
      'Copy with formatting into your document, or as plain text.',
    ],
    why: [
      'MLA is the style of the humanities, and the bibliography you have is in BibTeX because you wrote your last paper in LaTeX. Rekeying references between the two is slow and easy to get wrong in the details MLA cares about: the comma after the first author\'s name, et al. from the third author, vol. and no. before the numbers.',
      'This converter applies those rules from the fields in the entry and leaves nothing to memory.',
    ],
    faqs: [
      { q: 'Which edition of MLA?', a: 'MLA Handbook, 9th edition (2021). It is the same core-element format as the 8th edition, so the output is valid for both.' },
      { q: 'How are multiple authors written?', a: 'One author: Last, First. Two: Last, First, and First Last. Three or more: Last, First, et al.' },
      { q: 'What about the DOI or URL?', a: 'MLA 9 asks for the DOI as a link (https://doi.org/...) at the end of the entry, or the URL when there is no DOI. Both are included when the entry has them.' },
      { q: 'Can it format a book chapter or a thesis?', a: 'Yes: @incollection becomes a chapter in an edited book with the editors named, and @phdthesis or @mastersthesis becomes a dissertation entry with the institution.' },
    ],
    related: ['bibtex-to-apa', 'bibtex-to-ieee', 'acm-citation-generator', 'bibtex-citation-generator'],
  },
  {
    slug: 'bibtex-to-ieee',
    group: 'citations',
    blurb: 'BibTeX or a DOI. Numbered IEEE references.',
    name: 'BibTeX to IEEE',
    keyword: 'BibTeX to IEEE',
    title: 'BibTeX to IEEE Converter: Numbered IEEE References (Free)',
    description: 'Convert BibTeX to IEEE reference format. Paste entries or a DOI and get numbered [1] references with initials first, quoted titles and abbreviated months.',
    h1: 'BibTeX to IEEE',
    lede: 'Paste BibTeX entries, or a DOI, and get numbered IEEE references in the order you pasted them, with initials before surnames, titles in quotes and journals in italics.',
    howTo: [
      'Paste one or more BibTeX entries, or a DOI, arXiv id or ISBN.',
      'Press Convert. References are numbered [1], [2], and so on in the order given, which is how IEEE orders them (by first citation).',
      'Copy with formatting, or as plain text.',
    ],
    why: [
      'IEEE conferences and journals use the numbered style, and so do many computer science venues that take Word submissions. If the manuscript is not in LaTeX, the .bib entries have to be typed out in IEEE form: A. Author, B. Author, and C. Author, followed by the title in quotes and the venue in italics.',
      'The order of a numbered list is the order of first citation, so the converter keeps your paste order rather than sorting.',
    ],
    faqs: [
      { q: 'How are many authors handled?', a: 'Up to six authors are listed. Seven or more become the first author followed by et al., as the IEEE Reference Guide specifies.' },
      { q: 'How are months written?', a: 'As IEEE abbreviations: Jan., Feb., Mar., Apr., May, Jun., Jul., Aug., Sep., Oct., Nov., Dec.' },
      { q: 'Where does the DOI go?', a: 'At the end, as doi: 10.xxxx/yyyy, the form the IEEE Reference Guide uses for online journal articles and conference papers.' },
      { q: 'Why is the order not alphabetical?', a: 'Because an IEEE reference list is numbered by first citation in the text, not alphabetised. Paste the entries in citation order to get the right numbers.' },
    ],
    related: ['acm-citation-generator', 'bibtex-to-apa', 'bibtex-to-mla', 'bibtex-citation-generator'],
  },
  {
    slug: 'acm-citation-generator',
    group: 'citations',
    blurb: 'BibTeX or a DOI. ACM Reference Format.',
    name: 'ACM Citation Generator',
    keyword: 'ACM citation generator',
    title: 'ACM Citation Generator: ACM Reference Format from BibTeX or DOI (Free)',
    description: 'Free ACM citation generator. Paste a DOI, arXiv id or BibTeX and get ACM Reference Format entries: full names, the year after the authors, and the DOI link.',
    h1: 'ACM citation generator',
    lede: 'Paste a DOI, an arXiv id or BibTeX entries and get references in ACM Reference Format, the style of ACM conferences and journals, ready to paste.',
    howTo: [
      'Paste a DOI, arXiv id, ISBN, or one or more BibTeX entries.',
      'Press Generate. Each reference is written in ACM Reference Format.',
      'Copy with formatting into your document, or as plain text.',
    ],
    why: [
      'ACM Reference Format is unlike the other styles: full first names, the year right after the authors, the venue in italics, and the DOI as a link at the end. The ACM LaTeX class does it for you; anything outside LaTeX does not.',
      'The same generator feeds the other three styles on this site, so a reference list can be produced in ACM, IEEE, APA and MLA from one set of entries.',
    ],
    faqs: [
      { q: 'What does ACM Reference Format look like?', a: 'Ashish Vaswani, Noam Shazeer, and Niki Parmar. 2017. Attention is all you need. In Advances in Neural Information Processing Systems. Curran Associates, 5998–6008. https://doi.org/...' },
      { q: 'Do I need the ACM class file for this?', a: 'No. This is for documents written outside LaTeX, or for pasting a reference into a review, a proposal or a web page. In a LaTeX paper using acmart, the ACM-Reference-Format bibliography style produces the same output.' },
      { q: 'How are author names written?', a: 'In full, given name first, with "and" before the last author. Initials are only used when the entry itself only has initials.' },
      { q: 'Can I generate from a DOI without BibTeX?', a: 'Yes. Paste the DOI and the metadata is fetched from Crossref or DataCite, then formatted.' },
    ],
    related: ['bibtex-to-ieee', 'bibtex-to-apa', 'bibtex-citation-generator', 'doi-finder'],
  },
  // -------------------------------------------------------------------- latex
  {
    slug: 'latex-to-png',
    group: 'latex',
    blurb: 'Type an equation. A sharp PNG at any resolution.',
    name: 'LaTeX to PNG',
    keyword: 'LaTeX to PNG',
    title: 'LaTeX to PNG: Render an Equation to a PNG Image (Free, No Upload)',
    description: 'Convert LaTeX to PNG in your browser. Type an equation, see it rendered, and download a transparent or white PNG at 1x to 8x for slides, docs and posters.',
    h1: 'LaTeX to PNG',
    lede: 'Type LaTeX math, see it rendered as you type, and download it as a PNG at the resolution you need. Runs entirely in your browser.',
    howTo: [
      'Type or paste the LaTeX (math mode; use \\text{} for words).',
      'Pick the font size, the colour, a transparent or white background, and the scale (2x for retina screens, 4x or more for print).',
      'Download the PNG, or copy it to the clipboard and paste it straight into your slide or document.',
    ],
    why: [
      'Slides, Google Docs, Notion, a poster in PowerPoint, an issue on GitHub: none of them typeset LaTeX, and all of them take an image. Rendering an equation to PNG is the way math gets into every document that is not LaTeX.',
      'Rendering happens in your browser with MathJax, so the equation is never sent anywhere, and the PNG is sharp at any scale because it is drawn from vector output.',
    ],
    faqs: [
      { q: 'What resolution should I pick?', a: '1x matches a screen at 96 dpi. 2x for retina displays and slides, 4x for documents that will be printed, 8x for posters. The image scales without blurring because it is rasterised from vectors at the chosen size.' },
      { q: 'Can I get a transparent background?', a: 'Yes. Transparent is the default, so the equation sits on any slide colour. Choose white for documents that flatten transparency.' },
      { q: 'Which LaTeX is supported?', a: 'Everything MathJax\'s TeX input supports: AMS math, matrices, alignments, \\text, colours, and the common packages (amsmath, amssymb, bm, cancel, mathtools). Document-level commands and custom packages are not.' },
      { q: 'Can I copy the image instead of downloading it?', a: 'Yes. Copy PNG puts the image on the clipboard, so it pastes into PowerPoint, Keynote, Google Docs, Notion or a chat window without a file. It works in current Chrome, Edge, Safari and Firefox 127 or later; older browsers get a message and the download instead.' },
      { q: 'Why not SVG?', a: 'SVG is better where it is supported (web pages, Inkscape, some slide tools). The LaTeX to SVG page gives the same rendering as vector output.' },
    ],
    related: ['latex-to-svg', 'markdown-to-latex', 'latex-word-count', 'excel-to-latex'],
  },
  {
    slug: 'latex-to-svg',
    group: 'latex',
    blurb: 'Type an equation. A self-contained SVG, fonts embedded.',
    name: 'LaTeX to SVG',
    keyword: 'LaTeX to SVG',
    title: 'LaTeX to SVG: Render an Equation to a Vector SVG (Free, No Upload)',
    description: 'Convert LaTeX to SVG in your browser. Type an equation, preview it live, and download or copy a self-contained SVG with embedded glyphs that scales anywhere.',
    h1: 'LaTeX to SVG',
    lede: 'Type LaTeX math and get a self-contained SVG with the glyphs embedded as paths, so it renders identically anywhere, at any size, without fonts.',
    howTo: [
      'Type or paste the LaTeX (math mode; use \\text{} for words).',
      'Set the font size and colour.',
      'Download the .svg file, copy the SVG code to paste into a web page or a design tool, or copy it as a PNG image for slides and documents.',
    ],
    why: [
      'A PNG has one resolution; an SVG has none. For a web page, a figure that will be resized, or a design tool such as Figma or Inkscape, vector output is what you want, and it stays crisp when the poster is printed at A0.',
      'The SVG embeds the glyph outlines it uses, so it does not depend on any font being installed where it is opened.',
    ],
    faqs: [
      { q: 'Will the SVG look the same everywhere?', a: 'Yes. Glyphs are embedded as paths (MathJax\'s local font cache), so a browser, Inkscape, Illustrator or a PDF converter all draw the same shapes.' },
      { q: 'Can I change the colour later?', a: 'Yes. The SVG uses currentColor for its fills, so a CSS color rule, or a fill edit in a vector editor, recolours the whole equation.' },
      { q: 'How do I put it in a web page?', a: 'Paste the SVG code inline where the equation goes, or save the file and use it in an img tag. Inline SVG follows the surrounding text colour.' },
      { q: 'Can I copy the SVG to the clipboard as an image?', a: 'Browsers do not accept SVG on the clipboard as an image, so Copy SVG code copies the markup, which design tools such as Figma and Inkscape paste as vector graphics. For slides and documents, Copy as PNG puts a bitmap on the clipboard instead.' },
      { q: 'Which LaTeX is supported?', a: 'The TeX input MathJax understands: AMS math, matrices, alignments, \\text, colours, and the common packages. Not full documents.' },
    ],
    related: ['latex-to-png', 'markdown-to-latex', 'excel-to-latex', 'latex-word-count'],
  },
  {
    slug: 'markdown-to-latex',
    group: 'latex',
    blurb: 'Paste Markdown. LaTeX that compiles, special characters escaped.',
    name: 'Markdown to LaTeX',
    keyword: 'Markdown to LaTeX',
    title: 'Markdown to LaTeX Converter (Free, Runs in Your Browser)',
    description: 'Markdown to LaTeX converter: headings, lists, tables, code, links, images, footnotes and math become sections, itemize, tabular, verbatim and href. In your browser.',
    h1: 'Markdown to LaTeX',
    lede: 'Paste Markdown from a README, Obsidian, Notion or a chat answer and get LaTeX that compiles: headings, emphasis, lists, tables, code blocks, links, images, footnotes and math, with special characters escaped.',
    howTo: [
      'Paste the Markdown.',
      'Choose whether headings start at \\section (article) or \\chapter (report), and whether you want a fragment or a complete document with a preamble.',
      'Copy the LaTeX. The packages the output needs are listed above it.',
    ],
    why: [
      'Notes get written in Markdown and papers get written in LaTeX. The conversion is mechanical but tedious, and the tedious part is exactly where hand conversion fails: an unescaped underscore or percent sign that stops the build.',
      'The converter escapes every special character in prose, passes math and raw LaTeX environments through untouched, and tells you which packages to add.',
    ],
    faqs: [
      { q: 'What Markdown is supported?', a: 'ATX and setext headings, paragraphs, bold, italic, strikethrough, inline and fenced code, ordered and unordered lists with nesting, task lists, block quotes, links, images, tables with alignment, footnotes, horizontal rules, and math in dollar signs. HTML tags are treated as text.' },
      { q: 'How are tables converted?', a: 'Into a tabular with booktabs rules and the column alignment from the separator row. Untick booktabs to get \\hline rules and no extra package.' },
      { q: 'Does it need pandoc?', a: 'No. It is a small converter written for this page, and it runs in your browser. For complex documents pandoc remains the more complete tool.' },
      { q: 'What about math?', a: 'Inline $...$ and display $$...$$ are passed through unchanged, and a raw \\begin{align} block is kept as is. amsmath is added to the package list when either appears.' },
      { q: 'Which packages does the output need?', a: 'Only those the content uses: hyperref for links, graphicx for images, booktabs for tables, amsmath for math, listings if you chose it for code, ulem for strikethrough.' },
    ],
    related: ['excel-to-latex', 'latex-to-png', 'latex-word-count', 'latex-to-svg'],
  },
  {
    slug: 'excel-to-latex',
    group: 'latex',
    blurb: 'Paste cells or CSV. A booktabs table, numbers right-aligned.',
    name: 'Excel to LaTeX Table',
    keyword: 'Excel to LaTeX',
    title: 'Excel to LaTeX Table Converter: Paste Cells or CSV (Free)',
    description: 'Excel to LaTeX table converter: paste cells from Excel, Google Sheets or a CSV and get a tabular with booktabs rules, escaped characters and right-aligned numbers.',
    h1: 'Excel to LaTeX table',
    lede: 'Copy cells from Excel, Google Sheets or Numbers, or paste a CSV, and get a LaTeX table with booktabs rules, escaped special characters and numbers right-aligned.',
    howTo: [
      'Select the cells in your spreadsheet and copy them, then paste here. CSV and semicolon-separated text work too.',
      'Choose the options: header row, booktabs, alignment, caption and label, table float.',
      'Copy the LaTeX into your document. Add \\usepackage{booktabs} if you kept booktabs on.',
    ],
    why: [
      'Results live in a spreadsheet and the paper lives in LaTeX. Typing a results table into tabular by hand means retyping every number, and the ampersands, percent signs and underscores that break the build.',
      'This converter reads the tab-separated text spreadsheets put on the clipboard, escapes what LaTeX would misread, and right-aligns columns that are all numbers, which is what a results table should do.',
    ],
    faqs: [
      { q: 'Can I paste straight from Excel?', a: 'Yes. Select the cells, copy, and paste into the box. Excel, Google Sheets, Numbers and LibreOffice all copy as tab-separated text.' },
      { q: 'What is booktabs?', a: 'A LaTeX package that gives tables the thin top and bottom rules and the mid rule under the header, with no vertical lines. It is the look of almost every table in a published paper. Add \\usepackage{booktabs} to your preamble.' },
      { q: 'How is column alignment chosen?', a: 'A column whose cells are all numbers (including 92.1, 1,000, 5% or 2e3) is right-aligned; everything else is left-aligned. Override with the alignment option.' },
      { q: 'Will $\\alpha$ in a cell be escaped?', a: 'No. Text between dollar signs is treated as math and left alone; everything else is escaped.' },
      { q: 'Where do the caption and label go?', a: 'Inside a table float above the tabular, in the order \\caption then \\label, so \\ref{tab:...} picks up the table number.' },
    ],
    related: ['markdown-to-latex', 'latex-to-png', 'latex-word-count', 'latex-to-svg'],
  },
  {
    slug: 'latex-word-count',
    group: 'latex',
    blurb: 'Paste .tex source. Word counts the way Overleaf reports them.',
    name: 'LaTeX Word Count',
    keyword: 'LaTeX word count',
    title: 'LaTeX Word Count: Count Words in a .tex File (Overleaf Compatible)',
    description: 'LaTeX word count the way TeXcount and Overleaf report it: words in text, headers, captions and footnotes separately, with math and floats counted as items.',
    h1: 'LaTeX word count',
    lede: 'Paste your .tex source, or open the file, and get the word count the way TeXcount and Overleaf report it: words in text, headers, captions and footnotes, with a per-section breakdown.',
    howTo: [
      'Paste the LaTeX source, or pick the .tex file. Paste the contents of any \\input files too if you want them counted.',
      'Choose whether the appendix counts.',
      'Read the totals and the per-section table. The main number is the running text; headers, captions and footnotes are listed beside it.',
    ],
    why: [
      'Word limits are set on the text, not on the markup. Counting a LaTeX file in a word processor counts \\cite{...}, \\ref{...}, the preamble and every command; counting the PDF counts the bibliography and the page headers. Neither is the number a journal or a grant office means.',
      'This counter follows TeXcount\'s rules, which Overleaf\'s word count also uses, so the number here matches the one the submission system will compute.',
    ],
    faqs: [
      { q: 'Does this match Overleaf\'s word count?', a: 'Overleaf runs TeXcount on the main file, and this counter applies the same rules: comments, commands, citations and references are ignored, headers, captions and footnotes are counted separately, and math and floats are counted as items. Small differences remain where TeXcount\'s macro handling is smarter; for a limit check, the two agree.' },
      { q: 'Are the bibliography and the preamble counted?', a: 'No. Only the text between \\begin{document} and \\end{document} is counted, and thebibliography and \\printbibliography are excluded.' },
      { q: 'How are equations counted?', a: 'Inline math ($...$) and displayed equations are counted as items, not as words, which is what TeXcount does. If your limit counts equations as words, add the item counts to the text count.' },
      { q: 'What about \\input and \\include?', a: 'They are not followed: a browser page cannot read files from your disk by name. Paste each file\'s contents into the box, one after another, to count the whole document.' },
      { q: 'Is my file uploaded?', a: 'No. Counting runs in your browser; nothing is sent anywhere.' },
    ],
    related: ['markdown-to-latex', 'excel-to-latex', 'latex-to-png', 'bibtex-citation-generator'],
  },
  // ---------------------------------------------------------------- deadlines
  {
    slug: 'aoe-time',
    group: 'deadlines',
    blurb: 'AoE time now, and any AoE deadline in your zone.',
    name: 'AoE Time Now',
    keyword: 'AoE time',
    title: 'AoE Time Now: Anywhere on Earth Time, Live Clock and Deadline Converter',
    description: 'The current AoE time (Anywhere on Earth, UTC-12), a live clock, and a converter from an AoE deadline like 11:59 PM AoE to your local time and major cities.',
    h1: 'AoE time now',
    lede: 'Anywhere on Earth (AoE) is UTC-12: a deadline written in AoE has not passed until it has passed everywhere. Here is the AoE time right now, and what an AoE deadline means in your time zone.',
    howTo: [
      'Read the live AoE, UTC and local clocks at the top. The AoE clock is the one a deadline is measured against.',
      'Enter a deadline date and time as written in the call (for most calls, 23:59 AoE) to see it in your local time and in major cities.',
      'Or enter a local time to see what it is in AoE, for writing your own call for papers.',
    ],
    why: [
      'Conference and workshop calls use AoE so that no author is disadvantaged by their time zone, but it also means the deadline is later than it looks: 23:59 AoE on a Friday is 12:59 on Saturday afternoon in London and 19:59 Saturday in Beijing. People miss deadlines by reading the date and not the zone.',
      'The converter does the arithmetic with the correct daylight saving rules for your zone, and the page shows the open workshop deadlines from this site\'s tracker in the same local time.',
    ],
    faqs: [
      { q: 'What is AoE time?', a: 'Anywhere on Earth, the time zone UTC-12, the last time zone on the planet. A deadline at 23:59 AoE has passed only when it is past midnight everywhere on Earth, so it is the most generous way to write a deadline and the convention at NeurIPS, ICML, ICLR, CVPR and most other conferences.' },
      { q: 'What time is 11:59 PM AoE in my time zone?', a: 'Enter the date above and it is shown in your local time. As a rule of thumb it is noon UTC the next day: 11:59 PM AoE on the 15th is 11:59 UTC on the 16th, 07:59 in New York, 12:59 in London, 19:59 in Beijing and 21:59 in Sydney (daylight saving shifts some of these by an hour).' },
      { q: 'Does AoE have daylight saving time?', a: 'No. AoE is a fixed offset of UTC-12 all year; only your local zone shifts, which is why the converter asks for the date.' },
      { q: 'Which conferences use AoE?', a: 'Almost all machine learning and computer science venues: NeurIPS, ICML, ICLR, CVPR, ECCV, ICRA, IROS, CoRL, COLM, ACL and their workshops. Always check the call itself; a few venues use Pacific time or UTC.' },
      { q: 'Where do the deadlines on this page come from?', a: 'From this site\'s tracker of workshop calls for papers, which is refreshed daily. Each links to the workshop\'s page with the full details.' },
    ],
    related: ['doi-finder', 'bibtex-citation-generator', 'latex-word-count'],
  },
];

export const toolBySlug = (slug) => TOOLS.find((t) => t.slug === slug) || null;

/** Tools grouped in the order of GROUPS, for the index page. */
export function toolsByGroup() {
  return Object.entries(GROUPS).map(([id, label]) => ({ id, label, tools: TOOLS.filter((t) => t.group === id) }));
}
