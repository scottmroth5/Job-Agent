// Deterministic matching of an email to an application, tried in order; Claude is asked only when all fail.
//   1 thread       the Gmail thread is already tied to an application
//   2 contact      the sender is a contact linked to an application
//   3 domain       the sender's domain is the company domain of exactly one open application
//   4 ats_subject  company (and title) parsed from an ATS email identify exactly one open application
import { companyTitleKey } from '../../tools/urls.ts';
import { identityKey } from '../identity.ts';
import { domainIn } from './prefilter.ts';
import { parseAtsEmail } from './atsParse.ts';
import { lookups, sqlList } from '../lookups.ts';
import type { Database } from '../../tools/types.ts';

/** An application an email can be about (listOpenApplications). */
export interface OpenApplication {
  id: number;
  company: string;
  title: string;
  status: string;
  stage: string;
  company_domain: string | null;
}

/**
 * Applications an email can be about: any in-progress status (in any stage, since applied jobs are
 * archived after 30 days), or jobs still to evaluate in an active stage.
 */
export async function openSql(db: Database) {
  const lk = await lookups(db);
  return `(p.status IN ${sqlList(lk.inProgress())} OR (p.status IN ${sqlList(lk.ids('status', 'evaluate'))} AND p.stage IN ${sqlList(lk.ids('stage', 'active'))}))`;
}

export async function listOpenApplications(db: Database): Promise<OpenApplication[]> {
  return db.prepare(`SELECT p.id, p.company, p.title, p.status, p.stage, p.company_domain FROM postings p WHERE p.user_id = @uid AND ${await openSql(db)} ORDER BY p.id`).all() as OpenApplication[];
}

const companyPart = (key: string | null) => (key ? (key.split('|')[0] as string) : null);
const one = <T>(list: T[]): T | null => (list.length === 1 ? (list[0] as T) : null);

/**
 * open is listOpenApplications(db), passed in to reuse per run.
 */
export async function matchEmail(
  db: Database,
  email: { threadId: string; senderEmail: string; senderDomain: string; subject?: string | null; body?: string | null },
  { atsDomains, open: openGiven }: { atsDomains: string[]; open?: OpenApplication[] },
): Promise<{ postingId: number; rule: string } | null> {
  const open = openGiven ?? (await listOpenApplications(db));
  const thread = db.prepare('SELECT posting_id FROM email_threads WHERE thread_id = ? AND user_id = @uid').pluck().get(email.threadId) as number | undefined;
  if (thread) return { postingId: thread, rule: 'thread' };

  const contact = db.prepare('SELECT posting_id FROM contacts WHERE email = ? AND user_id = @uid AND posting_id IS NOT NULL').pluck().get(String(email.senderEmail).toLowerCase()) as number | undefined;
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
