// Decides whether an email is about the job search at all. Runs before anything is stored or sent to
// Claude; an email that fails is skipped and nothing about it is kept.

/** Lowercase domain of an address, or ''. */
export function domainOf(address) {
  const m = /@([^@\s>]+)\s*>?\s*$/.exec(String(address ?? ''));
  return m ? m[1].toLowerCase().replace(/\.$/, '') : '';
}

/** True when domain is one of list or a subdomain of one ("us.greenhouse.io" matches "greenhouse.io"). */
export function domainIn(domain, list = []) {
  const d = String(domain ?? '').toLowerCase();
  return Boolean(d) && list.some((x) => d === x.toLowerCase() || d.endsWith(`.${x.toLowerCase()}`));
}

/**
 * @param {{ senderEmail: string, senderDomain: string }} email
 * @param {{ threadStartedByMe: boolean (I sent a message in this thread), isContact: (email) => boolean, isCompanyDomain: (domain) => boolean, atsDomains: string[] }} ctx
 * @returns {{ pass: boolean, reason: string | null }}  reason: 'my_thread' | 'contact' | 'company_domain' | 'ats_domain'
 */
export function prefilter(email, ctx) {
  if (ctx.threadStartedByMe) return { pass: true, reason: 'my_thread' };
  if (ctx.isContact?.(email.senderEmail)) return { pass: true, reason: 'contact' };
  if (email.senderDomain && ctx.isCompanyDomain?.(email.senderDomain)) return { pass: true, reason: 'company_domain' };
  if (domainIn(email.senderDomain, ctx.atsDomains)) return { pass: true, reason: 'ats_domain' };
  return { pass: false, reason: null };
}
