// Deterministic matching of an email to an application, tried in order; Claude is asked only when all fail.
//   1 thread       the Gmail thread is already tied to an application
//   2 contact      the sender is a contact linked to an application
//   3 domain       the sender's domain is the company domain of exactly one open application
//   4 ats_subject  company (and title) parsed from an ATS email identify exactly one open application
import { companyTitleKey } from '../../tools/urls.js';
import { identityKey } from '../identity.js';
import { domainIn } from './prefilter.js';
import { parseAtsEmail } from './atsParse.js';
import { lookups, sqlList } from '../lookups.js';

/**
 * Applications an email can be about: any in-progress status (in any stage, since applied jobs are
 * archived after 30 days), or jobs still to evaluate in an active stage.
 */
export function openSql(db) {
  const lk = lookups(db);
  return `(p.status IN ${sqlList(lk.inProgress())} OR (p.status IN ${sqlList(lk.ids('status', 'evaluate'))} AND p.stage IN ${sqlList(lk.ids('stage', 'active'))}))`;
}

export function listOpenApplications(db) {
  return db.prepare(`SELECT p.id, p.company, p.title, p.status, p.stage, p.company_domain FROM postings p WHERE ${openSql(db)} ORDER BY p.id`).all();
}

const companyPart = (key) => (key ? key.split('|')[0] : null);
const one = (list) => (list.length === 1 ? list[0] : null);

/**
 * @param {object} db
 * @param {{ threadId: string, senderEmail: string, senderDomain: string, subject?: string, body?: string }} email
 * @param {{ atsDomains: string[], open?: object[] }} opts  open: listOpenApplications(db), passed in to reuse per run
 * @returns {{ postingId: number, rule: string } | null}
 */
export function matchEmail(db, email, { atsDomains, open = listOpenApplications(db) }) {
  const thread = db.prepare('SELECT posting_id FROM email_threads WHERE thread_id = ?').pluck().get(email.threadId);
  if (thread) return { postingId: thread, rule: 'thread' };

  const contact = db.prepare('SELECT posting_id FROM contacts WHERE email = ? AND posting_id IS NOT NULL').pluck().get(String(email.senderEmail).toLowerCase());
  if (contact) return { postingId: contact, rule: 'contact' };

  const domain = String(email.senderDomain ?? '').toLowerCase();
  if (domain && !domainIn(domain, atsDomains)) {
    const hit = one(open.filter((a) => a.company_domain && domainIn(domain, [a.company_domain])));
    if (hit) return { postingId: hit.id, rule: 'domain' };
  }

  const parsed = parseAtsEmail(email);
  if (parsed?.company) {
    const keyed = open.map((a) => ({ a, key: identityKey(a) })).filter((x) => x.key);
    if (parsed.title) {
      const key = companyTitleKey(parsed.company, parsed.title);
      const hit = one(keyed.filter((x) => x.key === key));
      if (hit) return { postingId: hit.a.id, rule: 'ats_subject' };
    }
    const company = companyPart(companyTitleKey(parsed.company, ''));
    const hit = one(keyed.filter((x) => companyPart(x.key) === company));
    if (hit) return { postingId: hit.a.id, rule: 'ats_subject' };
  }
  return null;
}
