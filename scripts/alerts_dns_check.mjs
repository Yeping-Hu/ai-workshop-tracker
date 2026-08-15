#!/usr/bin/env node
/**
 * Check the mail DNS for the alerts sending domain, before asking a provider
 * to verify it.
 *
 * Why this exists: the provider's dashboard says "not verified" and nothing
 * else, so a typo costs a round of guessing. Two mistakes account for almost
 * all of them, and both are silent:
 *
 *   1. **The doubled suffix.** Providers list record names relative to the
 *      sending domain (`send`, `resend._domainkey`), while Cloudflare's DNS
 *      editor appends the zone for you. Pasting the full name produces
 *      `send.mail.example.com.example.com`, which resolves to nothing. This
 *      script looks for that record explicitly and names it if found.
 *   2. **A proxied record.** Only CNAME/A records can be proxied, so this
 *      shows up as a DKIM lookup returning a Cloudflare address instead of a
 *      key. Reported as a warning rather than a pass.
 *
 * Nothing here is provider-specific beyond the record names, and nothing is
 * secret — it is all public DNS.
 *
 * Run:  node scripts/alerts_dns_check.mjs
 *       node scripts/alerts_dns_check.mjs --domain mail.example.com
 */
import { Resolver } from 'node:dns/promises';

const argDomain = process.argv.indexOf('--domain');
const SENDING = argDomain > -1 ? process.argv[argDomain + 1] : 'mail.aiworkshoptracker.com';
// The registrable zone, used to spot the doubled-suffix mistake.
const ZONE = SENDING.split('.').slice(-2).join('.');

// Public resolvers, so a stale local cache can't produce a false negative.
const resolver = new Resolver({ timeout: 4000, tries: 2 });
resolver.setServers(['1.1.1.1', '8.8.8.8']);

let failed = 0;
let warned = 0;
const line = (icon, label, detail = '') => console.log(`${icon} ${label}${detail ? `\n    ${detail}` : ''}`);
const pass = (l, d) => line('✓', l, d);
const fail = (l, d) => { failed++; line('✗', l, d); };
const warn = (l, d) => { warned++; line('!', l, d); };

const txt = async (name) => {
  try {
    return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(''));
  } catch {
    return [];
  }
};
const mx = async (name) => {
  try {
    return await resolver.resolveMx(name);
  } catch {
    return [];
  }
};
const anyRecord = async (name) => {
  const [t, m] = await Promise.all([txt(name), mx(name)]);
  if (t.length || m.length) return true;
  try {
    await resolver.resolveCname(name);
    return true;
  } catch {
    return false;
  }
};

console.log(`Checking mail DNS for ${SENDING}\n`);

/* ---- the doubled-suffix mistake, checked first because it explains the rest */
{
  const doubled = [`send.${SENDING}.${ZONE}`, `resend._domainkey.${SENDING}.${ZONE}`];
  const hits = [];
  for (const name of doubled) if (await anyRecord(name)) hits.push(name);
  if (hits.length) {
    fail(
      'A record exists with the zone appended twice',
      `${hits.join('\n    ')}\n    Cloudflare adds the zone for you — enter "send.${SENDING.split('.')[0]}", not the full name.`,
    );
  } else {
    pass('No doubled-suffix records');
  }
}

/* ---- SPF ---- */
{
  const records = await txt(`send.${SENDING}`);
  const spf = records.find((r) => r.toLowerCase().startsWith('v=spf1'));
  if (!spf) fail(`SPF at send.${SENDING}`, 'No v=spf1 TXT record found.');
  else if (!/include:/i.test(spf)) warn(`SPF at send.${SENDING}`, `Found, but no include: — ${spf}`);
  else pass(`SPF at send.${SENDING}`, spf);
}

/* ---- DKIM ---- */
{
  const name = `resend._domainkey.${SENDING}`;
  const records = await txt(name);
  const dkim = records.find((r) => /p=|v=DKIM1/i.test(r));
  if (dkim) {
    pass(`DKIM at ${name}`, `${dkim.slice(0, 60)}… (${dkim.length} chars)`);
  } else {
    let cname = null;
    try {
      cname = (await resolver.resolveCname(name))[0];
    } catch {}
    if (cname) pass(`DKIM at ${name}`, `CNAME → ${cname}`);
    else fail(`DKIM at ${name}`, 'No TXT key and no CNAME. This is the record most often mistyped.');
  }
}

/* ---- return-path MX ---- */
{
  const name = `send.${SENDING}`;
  const records = await mx(name);
  if (records.length) pass(`MX at ${name}`, records.map((r) => `${r.priority} ${r.exchange}`).join(', '));
  else fail(`MX at ${name}`, 'No MX record — bounce handling will not work.');
}

/* ---- DMARC ---- */
{
  const scoped = await txt(`_dmarc.${SENDING}`);
  const apex = await txt(`_dmarc.${ZONE}`);
  const found = scoped.find((r) => /^v=DMARC1/i.test(r)) || apex.find((r) => /^v=DMARC1/i.test(r));
  if (!found) {
    warn(
      `DMARC at _dmarc.${SENDING}`,
      `Not required to send, but Gmail and Yahoo expect one on bulk mail.\n    Suggested: v=DMARC1; p=none; rua=mailto:you@${ZONE}`,
    );
  } else {
    const where = scoped.length ? `_dmarc.${SENDING}` : `_dmarc.${ZONE} (inherited)`;
    pass(`DMARC at ${where}`, found);
    if (/p=reject|p=quarantine/i.test(found)) {
      warn('DMARC policy is strict', 'Start at p=none until the reports are clean, then tighten.');
    }
  }
}

console.log('');
if (failed) {
  console.log(`${failed} record(s) missing or wrong${warned ? `, ${warned} warning(s)` : ''}.`);
  console.log('DNS also takes a few minutes to propagate — if you just added these, wait and re-run.');
} else if (warned) {
  console.log(`Required records present, ${warned} warning(s) above.`);
} else {
  console.log('All mail DNS records look right. Hit Verify in the provider dashboard.');
}
process.exit(failed ? 1 : 0);
