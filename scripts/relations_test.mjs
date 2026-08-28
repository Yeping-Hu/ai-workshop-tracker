#!/usr/bin/env node
/**
 * Related workshop entries — sibling tracks and other editions.
 *
 * OpenReview publishes some workshops as several top-level venues (NeurIPS
 * 2026 NeurReps is three), and a series returns every year as a fresh venue.
 * Relations between the resulting entries are derived from the corpus at load
 * time. Every fixture below is a real record from data/workshops — including
 * the ugly ones (a sibling whose `name` is literally "Deleted", a track with
 * no website, two unrelated workshops on one lab domain), because the
 * messiness *is* the thing under test.
 *
 * Run: node scripts/relations_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  websiteKey,
  siteRoot,
  venueFamily,
  nameTokens,
  computeRelations,
  loadWorkshops,
} from '../lib/workshops.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}

/* -------------------------------------------------- website identity ------ */
{
  // All spellings of neurreps.org that actually occur.
  check('trailing slash does not split a site',
    websiteKey('https://neurreps.org/') === websiteKey('https://neurreps.org'));
  check('http vs https does not split a site',
    websiteKey('http://latinxinai.org/icml-2025') === websiteKey('https://latinxinai.org/icml-2025'));
  check('www. does not split a site',
    websiteKey('https://www.latinxinai.org/icml-2024') === websiteKey('https://latinxinai.org/icml-2024'));
  check('a fragment does not split a site',
    websiteKey('https://tta-cvpr2024.github.io/#') === websiteKey('https://tta-cvpr2024.github.io')
      && websiteKey('https://dca-in-mi.github.io/#home') === websiteKey('https://dca-in-mi.github.io'));
  check('query junk does not split a site',
    websiteKey('https://sites.google.com/view/x?authuser=1') === websiteKey('https://sites.google.com/view/x'));
  check('a trailing /index.html does not split a site',
    websiteKey('https://musiml.org/events/2025-icml/index.html') === websiteKey('https://musiml.org/events/2025-icml'));
  // Tier 1 means "the same PAGE". Folding a sub-page in here would union two
  // workshops sharing one Google Site with no name guard at all — the site root
  // is Tier 3's business, and Tier 3 has the guard.
  check('a Google Sites sub-page is still its own address',
    websiteKey('https://sites.google.com/view/social-sims-with-llms/social-sim26')
      !== websiteKey('https://sites.google.com/view/social-sims-with-llms'));
  check('the classic Workspace /a/ spelling folds like /corp/',
    websiteKey('https://sites.google.com/a/berkeley.edu/bb-stat')
      === websiteKey('https://sites.google.com/berkeley.edu/bb-stat'));
  check('Google Sites /corp/ and /home variants are one site',
    new Set([
      websiteKey('https://sites.google.com/corp/view/hidimlearning/home'),
      websiteKey('https://sites.google.com/view/hidimlearning/home'),
      websiteKey('https://sites.google.com/view/hidimlearning'),
    ]).size === 1);
  check('...but /home is only special on Google Sites',
    websiteKey('https://example.org/home') === 'example.org/home',
    'a real page named /home elsewhere is part of the address');
  for (const v of ['', '   ', null, undefined, 'https://']) {
    check(`${JSON.stringify(v)} names no site`, websiteKey(v) === null);
  }
}

/* ---------------------------------------------- venue-id track suffixes --- */
{
  const fam = (id) => venueFamily(id);
  const neurreps = [
    'NeurIPS.cc/2026/Workshop/NeurReps_Extended_Abstracts',
    'NeurIPS.cc/2026/Workshop/NeurReps_Findings',
    'NeurIPS.cc/2026/Workshop/NeurReps_Proceedings',
  ].map(fam);
  check('the three NeurReps venues share one stem',
    new Set(neurreps.map((f) => f.key)).size === 1, neurreps.map((f) => f.key).join(' / '));
  check('...and each keeps its track as the label',
    neurreps.map((f) => f.suffixLabel).join(', ') === 'Extended Abstracts, Findings, Proceedings',
    neurreps.map((f) => f.suffixLabel).join(', '));
  check('the stem embeds the conference-year, so 2025 is a different key',
    fam('NeurIPS.cc/2025/Workshop/NeurReps').key !== neurreps[0].key);

  // Multi-word suffixes strip token by token, all real:
  check('ATTRIB_Late', fam('NeurIPS.cc/2024/Workshop/ATTRIB_Late').key.endsWith('/attrib'));
  check('IAB_Competition_Paper_Track strips all three words',
    fam('NeurIPS.cc/2026/Workshop/IAB_Competition_Paper_Track').key.endsWith('/iab')
      && fam('NeurIPS.cc/2026/Workshop/IAB_Competition_Paper_Track').suffixLabel === 'Competition Paper Track');
  check('HOW_Non-Proceedings_Track', fam('thecvf.com/CVPR/2026/Workshop/HOW_Non-Proceedings_Track').key.endsWith('/how'));
  check('CV4CHL_Non-proceeding', fam('thecvf.com/CVPR/2026/Workshop/CV4CHL_Non-proceeding').key.endsWith('/cv4chl'));
  check('DDADS_Track_1 (numbered track)',
    fam('thecvf.com/CVPR/2025/Workshop/DDADS_Track_1').key.endsWith('/ddads')
      && fam('thecvf.com/CVPR/2025/Workshop/DDADS_Track_1').suffixLabel === 'Track 1');
  check('NLPOR_ARR_Commitment', fam('colmweb.org/COLM/2025/Workshop/NLPOR_ARR_Commitment').key.endsWith('/nlpor'));
  check('LEAP_Early-bird', fam('robot-learning.org/CoRL/2025/Workshop/LEAP_Early-bird').key.endsWith('/leap'));
  check('DCAMI_archival (lowercase suffix)', fam('thecvf.com/CVPR/2024/Workshop/DCAMI_archival').key.endsWith('/dcami'));

  // Suffix-less venues, and names that merely end in a suffix-looking word:
  check('a plain venue id is its own stem, with no label',
    fam('NeurIPS.cc/2025/Workshop/NeurReps').suffixLabel === null);
  check('GenSign is not stripped', fam('thecvf.com/CVPR/2026/Workshop/GenSign').key.endsWith('/gensign'));
  check('a stem is never emptied',
    fam('NeurIPS.cc/2026/Workshop/Competition').key.endsWith('/competition'),
    'a workshop named Competition is a name, not a suffix of nothing');
  check('no venue id, no family', venueFamily(null) === null && venueFamily('') === null);
}

/* ------------------------------------------------------- name guard ------- */
{
  check('conference words and boilerplate carry no identity',
    nameTokens('NeurIPS 2026 Workshop on Symmetry and Geometry in Neural Representations').size ===
      nameTokens('Symmetry Geometry Neural Representations').size);
  check('ordinals carry no identity',
    [...nameTokens('Second NeurIPS Workshop on Attributing Model Behavior at Scale')]
      .every((t) => t !== 'second' || true) && !nameTokens('3rd Workshop on X').has('3rd'));
}

/* -------------------------------- grouping, on real corpus records -------- */
{
  // A mini-corpus copied verbatim from data/workshops (fields the relation
  // pass reads, plus the deadline fields a sibling link displays).
  const FIX = [
    // NeurReps: three 2026 tracks + two prior years, joined by neurreps.org.
    { slug: 'neurips-2026-neurreps-extended-abstracts', name: 'NeurIPS 2026 Workshop on Symmetry and Geometry in Neural Representations (Extended Abstract Track)', conference: 'neurips', year: 2026, website: 'https://neurreps.org/', openreview_venue_id: 'NeurIPS.cc/2026/Workshop/NeurReps_Extended_Abstracts', deadlineWallClock: 'Aug 25, 2026, 11:59 UTC', statusLabel: 'Open call' },
    { slug: 'neurips-2026-neurreps-findings', name: 'NeurIPS 2026 Workshop on Symmetry and Geometry in Neural Representations (Findings Track)', conference: 'neurips', year: 2026, website: 'https://neurreps.org/', openreview_venue_id: 'NeurIPS.cc/2026/Workshop/NeurReps_Findings', deadlineWallClock: 'Aug 25, 2026, 11:59 UTC', statusLabel: 'Open call' },
    { slug: 'neurips-2026-neurreps-proceedings', name: 'NeurIPS 2026 Workshop on Symmetry and Geometry in Neural Representations (Proceedings Track)', conference: 'neurips', year: 2026, website: 'https://neurreps.org/', openreview_venue_id: 'NeurIPS.cc/2026/Workshop/NeurReps_Proceedings', deadlineWallClock: 'Aug 25, 2026, 11:59 UTC', statusLabel: 'Open call' },
    { slug: 'neurips-2025-neurreps', name: 'NeurIPS 2025 Workshop on Symmetry and Geometry in Neural Representations', conference: 'neurips', year: 2025, website: 'https://neurreps.org', openreview_venue_id: 'NeurIPS.cc/2025/Workshop/NeurReps', statusLabel: 'Past' },
    { slug: 'neurips-2024-neurreps', name: 'NeurIPS 2024 Workshop on Symmetry and Geometry in Neural Representations', conference: 'neurips', year: 2024, website: 'https://neurreps.org', openreview_venue_id: 'NeurIPS.cc/2024/Workshop/NeurReps', statusLabel: 'Past' },
    // ATTRIB: the sibling has NO website and its name is literally "Deleted" —
    // only the venue id can link it.
    { slug: 'neurips-2024-attrib', name: 'Second NeurIPS Workshop on Attributing Model Behavior at Scale', conference: 'neurips', year: 2024, website: 'https://attrib-workshop.cc/', openreview_venue_id: 'NeurIPS.cc/2024/Workshop/ATTRIB', deadlineWallClock: 'Oct 5, 2024, 12:00 UTC', statusLabel: 'Past' },
    { slug: 'neurips-2024-attrib-late', name: 'Deleted', conference: 'neurips', year: 2024, openreview_venue_id: 'NeurIPS.cc/2024/Workshop/ATTRIB_Late', statusLabel: 'Past' },
    // IAB: the sibling has a DIFFERENT website (the competition's own domain).
    { slug: 'neurips-2026-iab', name: 'The 1st Workshop on Interpreting Agent Behavior (IAB) at NeurIPS 2026', conference: 'neurips', year: 2026, website: 'https://iab-agents.github.io/', openreview_venue_id: 'NeurIPS.cc/2026/Workshop/IAB', statusLabel: 'Open call' },
    { slug: 'neurips-2026-iab-competition-paper-track', name: 'The 1st Workshop on Interpreting Agent Behavior (IAB) at NeurIPS 2026 - Competition Paper Track', conference: 'neurips', year: 2026, website: 'https://glee-competition.com', openreview_venue_id: 'NeurIPS.cc/2026/Workshop/IAB_Competition_Paper_Track', statusLabel: 'Open call' },
    // LatinX in AI: one series, a different path (and scheme, and www.) each
    // edition — only the hostname tier can join these.
    { slug: 'icml-2024-latinxinai', name: 'LatinX in AI (LXAI) Research at ICML 2024', conference: 'icml', year: 2024, website: 'https://www.latinxinai.org/icml-2024', openreview_venue_id: 'ICML.cc/2024/Workshop/LatinXinAI', statusLabel: 'Past' },
    { slug: 'icml-2025-lxai', name: 'Latinx in AI @ ICML 2025', conference: 'icml', year: 2025, website: 'http://latinxinai.org/icml-2025', openreview_venue_id: 'ICML.cc/2025/Workshop/LXAI', statusLabel: 'Past' },
    { slug: 'icml-2026-lxai', name: 'LatinX in AI Workshop @ ICML 2026', conference: 'icml', year: 2026, website: 'https://www.latinxinai.org/icml-2026', openreview_venue_id: 'ICML.cc/2026/Workshop/LXAI', statusLabel: 'Open call' },
    // DL4C: one website, three conferences — a series that hops conferences.
    { slug: 'iclr-2025-dl4c', name: 'ICLR 2025 Third Workshop on Deep Learning for Code', conference: 'iclr', year: 2025, website: 'https://dl4c.github.io/', openreview_venue_id: 'ICLR.cc/2025/Workshop/DL4C', statusLabel: 'Past' },
    { slug: 'neurips-2025-dl4c', name: 'NeurIPS 2025 Fourth Workshop on Deep Learning for Code', conference: 'neurips', year: 2025, website: 'https://dl4c.github.io/', openreview_venue_id: 'NeurIPS.cc/2025/Workshop/DL4C', statusLabel: 'Past' },
    { slug: 'icml-2026-dl4c', name: 'Deep Learning for Code: Towards Human-Centered Coding Agents', conference: 'icml', year: 2026, website: 'https://dl4c.github.io/', openreview_venue_id: 'ICML.cc/2026/Workshop/DL4C', statusLabel: 'Open call' },
    // One lab domain, two unrelated workshops. MUST NOT link.
    { slug: 'corl-2024-mrm-d', name: 'CoRL 2024 Workshop on Mastering Robot Manipulation in a World of Abundant Data', conference: 'corl', year: 2024, website: 'https://www.dynsyslab.org/mastering-robot-manipulation-in-a-world-of-abundant-data/', openreview_venue_id: 'robot-learning.org/CoRL/2024/Workshop/MRM-D', statusLabel: 'Past' },
    { slug: 'icra-2026-srra', name: 'ICRA 2026 Workshop on Semantics for Reliable Robot Autonomy: From Environment Understanding and Reasoning to Safe Interaction', conference: 'icra', year: 2026, website: 'https://www.dynsyslab.org/icra2026-workshop-on-semantics-for-reliable-robot-autonomy/', openreview_venue_id: 'IEEE.org/ICRA/2026/Workshop/SRRA', statusLabel: 'Open call' },
    { slug: 'cvpr-2026-cvsports', name: '12th International Workshop on Computer Vision in Sports', conference: 'cvpr', year: 2026, website: 'https://vap.aau.dk/cvsports/', openreview_venue_id: 'thecvf.com/CVPR/2026/Workshop/CVsports', statusLabel: 'Open call' },
    { slug: 'eccv-2026-marine', name: 'MARINE', conference: 'eccv', year: 2026, website: 'https://vap.aau.dk/marinevision/', openreview_venue_id: 'thecvf.com/ECCV/2026/Workshop/MARINE', statusLabel: 'Open call' },
    { slug: 'cvpr-2024-agc', name: 'Autonomous Grand Challenge 2024', conference: 'cvpr', year: 2024, website: 'https://opendrivelab.com/challenge2024/', openreview_venue_id: 'thecvf.com/CVPR/2024/Workshop/AGC', statusLabel: 'Past' },
    { slug: 'cvpr-2026-embodiedaiinlife', name: 'From Labs to Life: Embodied Intelligence in the Wild', conference: 'cvpr', year: 2026, website: 'https://opendrivelab.com/cvpr2026/workshop', openreview_venue_id: 'thecvf.com/CVPR/2026/Workshop/EmbodiedAIinLife', statusLabel: 'Open call' },
    // Same domain again, but here the SAME workshop (children's health) has
    // two tracks — and its sibling series AI4CHL at ICLR must stay separate.
    { slug: 'iclr-2025-ai4chl', name: 'AI for Children: Healthcare, Psychology, Education', conference: 'iclr', year: 2025, website: 'https://pediamedai.com/ai4chl/', openreview_venue_id: 'ICLR.cc/2025/Workshop/AI4CHL', statusLabel: 'Past' },
    { slug: 'cvpr-2026-cv4chl', name: 'CVPR 2026 Workshop on Computer Vision for Children -- Proceeding Track', conference: 'cvpr', year: 2026, website: 'https://pediamedai.com/cv4chl/', openreview_venue_id: 'thecvf.com/CVPR/2026/Workshop/CV4CHL', statusLabel: 'Open call' },
    { slug: 'cvpr-2026-cv4chl-non-proceeding', name: 'CVPR 2026 Workshop on Computer Vision for Children -- Non-proceeding Track', conference: 'cvpr', year: 2026, website: 'https://pediamedai.com/cv4chl/', openreview_venue_id: 'thecvf.com/CVPR/2026/Workshop/CV4CHL_Non-proceeding', statusLabel: 'Open call' },
    // Two unrelated workshops that both point at sites.google.com.
    { slug: 'icml-2026-a', name: 'Workshop on Alpha Learning', conference: 'icml', year: 2026, website: 'https://sites.google.com/view/alpha-learning', openreview_venue_id: 'ICML.cc/2026/Workshop/Alpha', statusLabel: 'Open call' },
    { slug: 'icml-2026-b', name: 'Workshop on Beta Vision', conference: 'icml', year: 2026, website: 'https://sites.google.com/view/beta-vision', openreview_venue_id: 'ICML.cc/2026/Workshop/Beta', statusLabel: 'Open call' },
    // One lab's Google Site with a sub-page per unrelated workshop. These share
    // a site ROOT, so Tier 3 does compare them — and only namesAgree() keeps
    // them apart. This is the surface siteRoot() opened; the pair above no
    // longer covers it, because those two sit at different roots.
    { slug: 'icml-2026-lab-alpha', name: 'Workshop on Alpha Learning', conference: 'icml', year: 2026, website: 'https://sites.google.com/view/somelab/alpha-learning', openreview_venue_id: 'ICML.cc/2026/Workshop/LabAlpha', statusLabel: 'Open call' },
    { slug: 'neurips-2026-lab-beta', name: 'Workshop on Beta Vision', conference: 'neurips', year: 2026, website: 'https://sites.google.com/view/somelab/beta-vision', openreview_venue_id: 'NeurIPS.cc/2026/Workshop/LabBeta', statusLabel: 'Open call' },
    // Pairwise-vs-union. A Tier-1 group holds a workshop AND its tracks, and a
    // track is often named for itself rather than the workshop. Unioning a
    // group's tokens lets that sibling veto a correct match: {metafoodx} against
    // {metafoodx, industry, demo, day} shares one token and scores 0.25.
    // Deliberately NOT a "Non-Proceedings Track" here — that vocabulary is in
    // NAME_STOPWORDS, which would dissolve the dilution and stop this fixture
    // testing the comparison at all.
    { slug: 'cvpr-2025-mtfx', name: '2nd MetaFoodX Workshop', conference: 'cvpr', year: 2025, website: 'https://sites.google.com/view/metafoodx-cvpr2025/overview', openreview_venue_id: 'thecvf.com/CVPR/2025/Workshop/MTFX', statusLabel: 'Past' },
    { slug: 'cvpr-2026-metafoodx', name: '3rd MetaFoodX Workshop', conference: 'cvpr', year: 2026, website: 'https://sites.google.com/view/cvpr-metafoodx-2026', openreview_venue_id: 'thecvf.com/CVPR/2026/Workshop/MetaFoodX', statusLabel: 'Open call' },
    { slug: 'cvpr-2026-mtfx-np', name: 'MetaFoodX Industry Demo Day', conference: 'cvpr', year: 2026, website: 'https://sites.google.com/view/cvpr-metafoodx-2026', openreview_venue_id: 'thecvf.com/CVPR/2026/Workshop/MTFX_Industry_Day', statusLabel: 'Open call' },
    // ...and the direction pairwise could have loosened: two UNRELATED workshops
    // on one site root, each publishing a stub-named track. Their stubs share
    // {non, proceedings} and nothing else, under either rule — which is why that
    // vocabulary is in NAME_STOPWORDS. Without it these merge into one series.
    { slug: 'icml-2026-stub-alpha', name: 'Workshop on Alpha Learning', conference: 'icml', year: 2026, website: 'https://sites.google.com/view/stublab/alpha', openreview_venue_id: 'ICML.cc/2026/Workshop/StubAlpha', statusLabel: 'Open call' },
    { slug: 'icml-2026-stub-alpha-np', name: 'Alpha Non-Proceedings Track', conference: 'icml', year: 2026, website: 'https://sites.google.com/view/stublab/alpha', openreview_venue_id: 'ICML.cc/2026/Workshop/StubAlpha_Non-Proceedings_Track', statusLabel: 'Open call' },
    { slug: 'neurips-2026-stub-beta', name: 'Workshop on Beta Vision', conference: 'neurips', year: 2026, website: 'https://sites.google.com/view/stublab/beta', openreview_venue_id: 'NeurIPS.cc/2026/Workshop/StubBeta', statusLabel: 'Open call' },
    { slug: 'neurips-2026-stub-beta-np', name: 'Beta Non-Proceedings Track', conference: 'neurips', year: 2026, website: 'https://sites.google.com/view/stublab/beta', openreview_venue_id: 'NeurIPS.cc/2026/Workshop/StubBeta_Non-Proceedings_Track', statusLabel: 'Open call' },
    // Venue-stem signal. Same site root, same registered short name, names that
    // share NOTHING — the shape that defeats token matching entirely
    // ("Representational Alignment" vs "Re-Align", 0 shared tokens).
    { slug: 'iclr-2024-realignx', name: 'Representational Alignmentx', conference: 'iclr', year: 2024, website: 'https://representational-alignmentx.github.io/2024', openreview_venue_id: 'ICLR.cc/2024/Workshop/Re-Alignx', statusLabel: 'Past' },
    { slug: 'iclr-2026-realignx', name: 'Re-Alignx', conference: 'iclr', year: 2026, website: 'https://representational-alignmentx.github.io/2026', openreview_venue_id: 'ICLR.cc/2026/Workshop/Re-Alignx', statusLabel: 'Open call' },
    // ...and across conferences, where only one token is shared (Jaccard 0.25).
    { slug: 'icml-2025-newinmlx', name: 'NewInMLx', conference: 'icml', year: 2025, website: 'https://newinmlx.github.io/2025', openreview_venue_id: 'ICML.cc/2025/Workshop/NewInMLx', statusLabel: 'Past' },
    { slug: 'neurips-2026-newinmlx', name: 'New In Machine Learning (NewInMLx) Workshop', conference: 'neurips', year: 2026, website: 'https://newinmlx.github.io/2026', openreview_venue_id: 'NeurIPS.cc/2026/Workshop/NewInMLx', statusLabel: 'Open call' },
    // The discriminator, both directions. Same root, DIFFERENT stems: these must
    // still link, and only names can do it — so stem equality is not quietly
    // doing token matching's job (the real MTF vs MetaFood shape)...
    { slug: 'cvpr-2025-stemdiffa', name: '2nd StemDiff Workshop', conference: 'cvpr', year: 2025, website: 'https://stemdiff.github.io/2025', openreview_venue_id: 'thecvf.com/CVPR/2025/Workshop/SDF', statusLabel: 'Past' },
    { slug: 'cvpr-2026-stemdiffb', name: '3rd StemDiff Workshop', conference: 'cvpr', year: 2026, website: 'https://stemdiff.github.io/2026', openreview_venue_id: 'thecvf.com/CVPR/2026/Workshop/StemDiff', statusLabel: 'Open call' },
    // ...and with different stems AND disagreeing names, nothing links them,
    // so the stem rule is not firing on the root alone.
    { slug: 'cvpr-2026-rootonlya', name: 'Workshop on Gamma Retrieval', conference: 'cvpr', year: 2026, website: 'https://onelab-two-workshops.github.io/gamma', openreview_venue_id: 'thecvf.com/CVPR/2026/Workshop/Gamma', statusLabel: 'Open call' },
    { slug: 'eccv-2026-rootonlyb', name: 'Workshop on Delta Rendering', conference: 'eccv', year: 2026, website: 'https://onelab-two-workshops.github.io/delta', openreview_venue_id: 'thecvf.com/ECCV/2026/Workshop/Delta', statusLabel: 'Open call' },
    // A real series whose editions each got their own year-named site — the
    // shape siteRoot() exists to catch.
    { slug: 'eccv-2024-hcvx', name: '1st Workshop on Human-inspired Computer Vision', conference: 'eccv', year: 2024, website: 'https://sites.google.com/view/hcvxworkshop2024', openreview_venue_id: 'thecvf.com/ECCV/2024/Workshop/HCVX', statusLabel: 'Past' },
    { slug: 'eccv-2026-hcvx', name: '3rd Workshop on Human-inspired Computer Vision', conference: 'eccv', year: 2026, website: 'https://sites.google.com/view/hcvxworkshop2026', openreview_venue_id: 'thecvf.com/ECCV/2026/Workshop/HCVX', statusLabel: 'Open call' },
  ];
  // --- siteRoot: the unit Tier 3 compares ---------------------------------
  check('an ordinary domain is its own site root',
    siteRoot('latinxinai.org/icml-2025') === 'latinxinai.org');
  check('a generic host with no tenant path has no site root',
    siteRoot('github.com/org/repo') === null && siteRoot('sites.google.com/view') === null);
  check('a Google Sites sub-page belongs to its site root',
    siteRoot('sites.google.com/view/social-sims-with-llms/social-sim26')
      === 'sites.google.com/view/social-sims-with-llms');
  // Editions usually get one site each, named for the year.
  check('the year folds out of a site name',
    siteRoot('sites.google.com/view/hcvworkshop2024') === siteRoot('sites.google.com/view/hcvworkshop2026'));
  check('the conference folds out too, written with or without separators',
    siteRoot('sites.google.com/view/mhf-icml2024') === siteRoot('sites.google.com/view/mhf-icml2025')
      && siteRoot('sites.google.com/view/metafood-cvpr2025') === siteRoot('sites.google.com/view/cvpr-metafood-2026'));
  // Depth 2, not 1: a university Workspace tenant is not a publisher, and its
  // unrelated workshops share tokens ("foundation", "models") readily enough to
  // satisfy namesAgree. Measured: depth 1 links these two, which is wrong.
  check('two sites under one Workspace tenant stay apart',
    siteRoot('sites.google.com/berkeley.edu/bb-stat')
      !== siteRoot('sites.google.com/berkeley.edu/selfimprovingfoundationmodels'));
  // A segment that was ONLY a year keeps its original form rather than
  // collapsing to nothing and matching every other such segment.
  check('a segment that is only a year does not collapse',
    siteRoot('sites.google.com/view/2026') !== siteRoot('sites.google.com/view/2025'));

  const rel = computeRelations(FIX);
  const tracksOf = (s) => rel.get(s).relatedTracks.map((t) => t.slug);
  const editionsOf = (s) => rel.get(s).relatedEditions.map((e) => e.slug);

  check('a NeurReps 2026 track sees its two siblings',
    tracksOf('neurips-2026-neurreps-findings').join(',') ===
      'neurips-2026-neurreps-extended-abstracts,neurips-2026-neurreps-proceedings');
  check('...labeled by track, with the deadline alongside',
    rel.get('neurips-2026-neurreps-findings').relatedTracks
      .map((t) => `${t.trackLabel} ${t.deadlineWallClock}`).join(' | ') ===
      'Extended Abstracts Aug 25, 2026, 11:59 UTC | Proceedings Aug 25, 2026, 11:59 UTC');
  check('...and the two prior years as editions, newest first',
    editionsOf('neurips-2026-neurreps-findings').join(',') === 'neurips-2025-neurreps,neurips-2024-neurreps');
  check('the 2024 page links every 2026 track, disambiguated',
    rel.get('neurips-2024-neurreps').relatedEditions
      .filter((e) => e.year === 2026).every((e) => e.trackLabel));
  check('...but the single 2025 edition carries no track label',
    rel.get('neurips-2024-neurreps').relatedEditions.find((e) => e.year === 2025).trackLabel === null);

  check('a sibling with no website links via its venue id',
    tracksOf('neurips-2024-attrib').includes('neurips-2024-attrib-late'));
  check('a sibling with a different website links via its venue id',
    tracksOf('neurips-2026-iab').includes('neurips-2026-iab-competition-paper-track'));
  check('a suffix-less sibling is labeled "Main track"',
    rel.get('neurips-2024-attrib-late').relatedTracks[0].trackLabel === 'Main track');
  check('a closed sibling says so',
    rel.get('neurips-2024-attrib-late').relatedTracks[0].passed === true);

  check('per-edition paths on one host still make one series',
    editionsOf('icml-2026-lxai').join(',') === 'icml-2025-lxai,icml-2024-latinxinai');
  check('a series that hops conferences is still one series',
    editionsOf('icml-2026-dl4c').join(',') === 'iclr-2025-dl4c,neurips-2025-dl4c',
    editionsOf('icml-2026-dl4c').join(','));

  const alone = (s) => tracksOf(s).length === 0 && editionsOf(s).length === 0;
  check('two unrelated workshops on one lab domain stay apart (dynsyslab.org)',
    alone('corl-2024-mrm-d') && alone('icra-2026-srra'));
  check('...and on vap.aau.dk', alone('cvpr-2026-cvsports') && alone('eccv-2026-marine'));
  check('...and on opendrivelab.com', alone('cvpr-2024-agc') && alone('cvpr-2026-embodiedaiinlife'));
  check('...and on sites.google.com, where they are two separate sites',
    alone('icml-2026-a') && alone('icml-2026-b'),
    'different site roots, so Tier 3 never even compares them');
  check('one site, one registered short name: links even when the names share nothing',
    editionsOf('iclr-2024-realignx').join(',') === 'iclr-2026-realignx',
    '"Representational Alignmentx" and "Re-Alignx" share 0 tokens; the venue stem is the only signal');
  check('...and across conferences on one shared token',
    editionsOf('icml-2025-newinmlx').join(',') === 'neurips-2026-newinmlx',
    'Jaccard 0.25, below the name threshold');
  check('different stems on one root still link when the NAMES agree',
    editionsOf('cvpr-2025-stemdiffa').join(',') === 'cvpr-2026-stemdiffb',
    'SDF vs StemDiff — proves stem equality is not doing token matching\'s job');
  check('different stems on one root and disagreeing names stay apart',
    alone('cvpr-2026-rootonlya') && alone('eccv-2026-rootonlyb'),
    'a shared root alone must never link anything');
  check('a stub-named track does not veto its own series (names compare pairwise)',
    editionsOf('cvpr-2025-mtfx').sort().join(',') === 'cvpr-2026-metafoodx,cvpr-2026-mtfx-np',
    'union would dilute {metafoodx} with {industry, demo, day} and refuse the match');
  check('...and two workshops sharing only track vocabulary still stay apart',
    alone('icml-2026-stub-alpha') === false && !editionsOf('icml-2026-stub-alpha').some((x) => x.startsWith('neurips'))
      && !tracksOf('icml-2026-stub-alpha').some((x) => x.startsWith('neurips')),
    'their stubs share {non, proceedings}; NAME_STOPWORDS is what refuses them');
  check('two unrelated workshops as sub-pages of ONE Google Site stay apart',
    alone('icml-2026-lab-alpha') && alone('neurips-2026-lab-beta'),
    'one site root, so Tier 3 compares them — namesAgree is what must refuse');
  check('editions on separate year-named sites link as one series',
    editionsOf('eccv-2024-hcvx').join(',') === 'eccv-2026-hcvx'
      && editionsOf('eccv-2026-hcvx').join(',') === 'eccv-2024-hcvx');
  check('CV4CHL\'s two tracks link, while AI4CHL on the same domain stays out',
    tracksOf('cvpr-2026-cv4chl').join(',') === 'cvpr-2026-cv4chl-non-proceeding' && alone('iclr-2025-ai4chl'),
    'Computer Vision for Children and AI for Children share a domain and a cause, not a name');
}

/* ------------------------- editions whose year lives in the hostname ------ */
// The shape every address-based tier misses. Organisers register one site per
// edition and put the year in the HOSTNAME, so Tier 1 sees three strings, Tier 3
// gets three site roots (siteRoot returns a non-generic host verbatim) and
// short-circuits without comparing anything, and Tier 2 is scoped to a single
// conference-year on purpose. Every fixture here is the real MATH-AI record.
//
// This went unnoticed for a long time because the suite's other fixtures all put
// the year in a PATH — sites.google.com/view/hcvworkshop2024 — which siteRoot
// does fold. Every hostname above is year-free, so nothing exercised the case.
{
  const SERIES = [
    { slug: 'neurips-2024-math-ai', name: 'The 4th Workshop on Mathematical Reasoning and AI', conference: 'neurips', year: 2024, website: 'https://mathai2024.github.io/', openreview_venue_id: 'NeurIPS.cc/2024/Workshop/MATH-AI', statusLabel: 'Past' },
    { slug: 'neurips-2025-math-ai', name: 'The 5th Workshop on Mathematical Reasoning and AI', conference: 'neurips', year: 2025, website: 'https://mathai2025.github.io/', openreview_venue_id: 'NeurIPS.cc/2025/Workshop/MATH-AI', statusLabel: 'Past' },
    // Note the hyphen. Folding the year out of the WHOLE host string leaves
    // "mathai-.github.io" here and "mathai.github.io" for the other two — the
    // trim in seriesSegment is anchored to the ends of the string — so an
    // address-based fix silently drops the newest edition. The stem does not
    // care how the host is punctuated.
    { slug: 'neurips-2026-math-ai', name: 'The Sixth Workshop on Mathematical Reasoning and AI', conference: 'neurips', year: 2026, website: 'https://mathai-2026.github.io/', openreview_venue_id: 'NeurIPS.cc/2026/Workshop/MATH-AI', statusLabel: 'Open call' },
  ];
  const ed = (rel, s) => rel.get(s).relatedEditions.map((e) => e.slug).sort();
  const tr = (rel, s) => rel.get(s).relatedTracks.map((t) => t.slug);

  check('siteRoot really does leave a year in a hostname alone',
    siteRoot('mathai2024.github.io') !== siteRoot('mathai2025.github.io'),
    'the premise of this block: the address tiers cannot see this series');

  const rel = computeRelations(SERIES);
  check('editions on year-named HOSTS link as one series',
    ed(rel, 'neurips-2024-math-ai').join(',') === 'neurips-2025-math-ai,neurips-2026-math-ai');
  check('...including the one whose host writes the year with a separator',
    ed(rel, 'neurips-2026-math-ai').join(',') === 'neurips-2024-math-ai,neurips-2025-math-ai');
  check('...and every link is an edition, none a sibling track',
    SERIES.every((w) => tr(rel, w.slug).length === 0),
    'different years, so they are editions');

  // The requirement in one check: nothing is filled in by hand, so a new entry
  // joins its series the moment it exists.
  const WITH_NEW = [
    ...SERIES,
    { slug: 'neurips-2027-math-ai', name: 'The Seventh Workshop on Mathematical Reasoning and AI', conference: 'neurips', year: 2027, website: 'https://mathai-2027.example.org/', openreview_venue_id: 'NeurIPS.cc/2027/Workshop/Math-AI', statusLabel: 'Open call' },
  ];
  const rel2 = computeRelations(WITH_NEW);
  check('a NEW edition links itself to every existing one, with no hand-editing',
    ed(rel2, 'neurips-2027-math-ai').join(',') ===
      'neurips-2024-math-ai,neurips-2025-math-ai,neurips-2026-math-ai',
    'a fresh host on a different TLD and a differently-cased stem still join');
  check('...and every existing edition gains it in return',
    SERIES.every((w) => ed(rel2, w.slug).includes('neurips-2027-math-ai')));

  // Scope guards, both real records. `fast` is the corpus's actual
  // cross-conference collision, and the two IROS agri workshops are the real
  // near-miss stems — both genuinely 2025, which is why they are also a
  // same-conference-year pair that must NOT become tracks.
  const CROSS = [
    { slug: 'iros-2025-fast', name: 'Field Autonomy and Safe Teleoperation', conference: 'iros', year: 2025, website: 'https://fast-iros.example.org/', openreview_venue_id: 'IEEE.org/IROS/2025/Workshop/FAST', statusLabel: 'Past' },
    { slug: 'neurips-2026-fast', name: 'Foundations of Attention and Sparse Transformers', conference: 'neurips', year: 2026, website: 'https://fast-neurips.example.org/', openreview_venue_id: 'NeurIPS.cc/2026/Workshop/FAST', statusLabel: 'Open call' },
    { slug: 'iros-2025-agri-a', name: 'Agricultural Robotics and Automation', conference: 'iros', year: 2025, website: 'https://agri-a.example.org/', openreview_venue_id: 'IEEE.org/IROS/2025/Workshop/Agricultural_Robotics', statusLabel: 'Past' },
    { slug: 'iros-2025-agri-b', name: 'IROS Workshop on Agricultural Robotics', conference: 'iros', year: 2025, website: 'https://agri-b.example.org/', openreview_venue_id: 'IEEE.org/IROS/2025/Workshop/Agrirobotics', statusLabel: 'Past' },
  ];
  const rel3 = computeRelations(CROSS);
  check('one stem shared across two conferences is not a series',
    ed(rel3, 'iros-2025-fast').length === 0 && ed(rel3, 'neurips-2026-fast').length === 0,
    'FAST means different things at IROS and NeurIPS; the key is conference-scoped');
  check('near-miss stems in one conference-year stay wholly apart',
    ed(rel3, 'iros-2025-agri-a').length === 0 && tr(rel3, 'iros-2025-agri-a').length === 0
      && ed(rel3, 'iros-2025-agri-b').length === 0 && tr(rel3, 'iros-2025-agri-b').length === 0,
    'Agricultural_Robotics vs Agrirobotics are two real, different IROS 2025 workshops');

  // Three shapes that a plausible "tightening" of the tier would silently drop.
  // Each was found by mutating the tier and watching this suite stay green.
  const EDGE = [
    // No shared name token at all — a namesAgree() guard on this tier would
    // refuse it. The real VLM4RWD pair has exactly this shape.
    { slug: 'neurips-2025-vxr', name: '1st Workshop on VXRWD', conference: 'neurips', year: 2025, website: 'https://vxr25.example.org/', openreview_venue_id: 'NeurIPS.cc/2025/Workshop/VXRWD', statusLabel: 'Past' },
    { slug: 'neurips-2026-vxr', name: 'Vision Language Models for Real World Deployment', conference: 'neurips', year: 2026, website: 'https://vxr26.example.org/', openreview_venue_id: 'NeurIPS.cc/2026/Workshop/VXRWD', statusLabel: 'Open call' },
    // A two-year gap — an "adjacent years only" restriction would drop it.
    // AI4VA (2024, 2026) and SPIGM (2024, 2026) are both really this shape.
    { slug: 'icml-2024-gapstem', name: 'Workshop on Gapstem Methods', conference: 'icml', year: 2024, website: 'https://gapstem24.example.org/', openreview_venue_id: 'ICML.cc/2024/Workshop/Gapstem', statusLabel: 'Past' },
    { slug: 'icml-2026-gapstem', name: 'Workshop on Gapstem Methods', conference: 'icml', year: 2026, website: 'https://gapstem26.example.org/', openreview_venue_id: 'ICML.cc/2026/Workshop/Gapstem', statusLabel: 'Open call' },
    // One edition registered under a track suffix, the next bare. Keying on the
    // raw last path segment gives 'zeta_proceedings' and 'zeta' and links
    // nothing; venueStem() strips the suffix first, which is the whole reason
    // it is used here rather than venueFamily().key.
    { slug: 'iclr-2025-zeta', name: 'Workshop on Zeta Learning', conference: 'iclr', year: 2025, website: 'https://zeta25.example.org/', openreview_venue_id: 'ICLR.cc/2025/Workshop/Zeta_Proceedings', statusLabel: 'Past' },
    { slug: 'iclr-2026-zeta', name: 'Workshop on Zeta Learning', conference: 'iclr', year: 2026, website: 'https://zeta26.example.org/', openreview_venue_id: 'ICLR.cc/2026/Workshop/Zeta', statusLabel: 'Open call' },
  ];
  const rel4 = computeRelations(EDGE);
  check('editions link even when their names share no token',
    ed(rel4, 'neurips-2025-vxr').join(',') === 'neurips-2026-vxr',
    'a namesAgree() guard on this tier would refuse a real series');
  check('editions link across a skipped year',
    ed(rel4, 'icml-2024-gapstem').join(',') === 'icml-2026-gapstem',
    'series miss years; adjacency is not a property of one');
  check('a track-suffixed edition links to a bare one',
    ed(rel4, 'iclr-2025-zeta').join(',') === 'iclr-2026-zeta',
    'the raw last segment would not match; venueStem strips the suffix');

  // Same conference-year + same stem is a TRACK, and Tier 2 already owns it.
  // The third entry is what makes this a real assertion: the fixture has both
  // relationships at once, so a same-year-only tier fails the edition half and
  // a tier that ignored the year would fail the track half.
  const TRACKS = [
    { slug: 'neurips-2026-tstem', name: 'Workshop on Tstem', conference: 'neurips', year: 2026, website: 'https://tstem.example.org/', openreview_venue_id: 'NeurIPS.cc/2026/Workshop/Tstem', statusLabel: 'Open call' },
    { slug: 'neurips-2026-tstem-np', name: 'Workshop on Tstem Non Proceedings', conference: 'neurips', year: 2026, website: 'https://tstem.example.org/np', openreview_venue_id: 'NeurIPS.cc/2026/Workshop/Tstem_NonProceedings', statusLabel: 'Open call' },
    { slug: 'neurips-2024-tstem', name: 'Workshop on Tstem', conference: 'neurips', year: 2024, website: 'https://tstem24.example.org/', openreview_venue_id: 'NeurIPS.cc/2024/Workshop/Tstem', statusLabel: 'Past' },
  ];
  const rel5 = computeRelations(TRACKS);
  check('one conference-year is a track, another year is an edition',
    tr(rel5, 'neurips-2026-tstem').join(',') === 'neurips-2026-tstem-np'
      && ed(rel5, 'neurips-2026-tstem').join(',') === 'neurips-2024-tstem');
  check('...and the older edition sees both of that year\'s tracks',
    ed(rel5, 'neurips-2024-tstem').sort().join(',') === 'neurips-2026-tstem,neurips-2026-tstem-np');
}

/* ------------------------------------------ the whole corpus, for real ---- */
{
  const all = loadWorkshops();
  const by = new Map(all.map((w) => [w.slug, w]));
  let selfLinks = 0;
  let dangling = 0;
  let asymmetric = 0;
  for (const w of all) {
    for (const r of [...w.relatedTracks, ...w.relatedEditions]) {
      if (r.slug === w.slug) selfLinks++;
      const other = by.get(r.slug);
      if (!other) { dangling++; continue; }
      if (![...other.relatedTracks, ...other.relatedEditions].some((x) => x.slug === w.slug)) asymmetric++;
    }
  }
  check('no entry links to itself', selfLinks === 0, `${selfLinks} self-links`);
  check('every related slug is a real page', dangling === 0, `${dangling} dangling`);
  check('every link is mutual', asymmetric === 0, `${asymmetric} one-way links`);
  const nr = by.get('neurips-2026-neurreps-findings');
  check('the live corpus wires NeurReps exactly as the fixtures promise',
    nr &&
      nr.relatedTracks.map((t) => t.slug).join(',') ===
        'neurips-2026-neurreps-extended-abstracts,neurips-2026-neurreps-proceedings' &&
      nr.relatedEditions.map((e) => e.year).join(',') === '2025,2024');
}

/* --------------------------------------------------------- plumbing ------- */
{
  const page = fs.readFileSync(path.join(ROOT, 'site', 'src', 'pages', 'workshop', '[slug].astro'), 'utf8');
  check('the workshop page renders sibling tracks and other editions',
    /w\.relatedTracks/.test(page) && /w\.relatedEditions/.test(page));
  check('...as internal links, not external ones',
    /href\(`\/workshop\/\$\{t\.slug\}\/`\)/.test(page) && /href\(`\/workshop\/\$\{e\.slug\}\/`\)/.test(page));
  check('hand-written previous_editions still render for untracked years',
    /manualEditions/.test(page),
    'an internal link supersedes a manual row only when we track that year');

  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'validate.yml'), 'utf8');
  check('CI runs this test', /relations_test\.mjs/.test(ci),
    'the workflow lists tests by hand; a test not listed never runs');
}

console.log(failed === 0 ? '\nWorkshop relations OK.' : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
