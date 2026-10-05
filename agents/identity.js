// Telling whether two postings are the same job. Links differ between sites, so a job is identified by
// company and title (tools/urls.js companyTitleKey), with the company read from a Google page title when
// the stored company is a placeholder. postings.company_title_key holds storedKey(); keep it current with
// rekeyPostings after the key rules change (npm run cleanup does).
import { companyTitleKey } from '../tools/urls.js';
import { parseResultTitle } from './discovery/sources/serper.js';
import { lookups, sqlList } from './lookups.js';

const PLACEHOLDER_COMPANY = /^\(?(unknown|see posting|confidential|stealth|stealth startup|n\/?a|tbd|none|undisclosed|company)\)?$/i;

/** False for empty or placeholder company names, which cannot tell two jobs apart. */
export function isRealCompany(company) {
  const c = String(company ?? '').trim();
  return c.length > 0 && !PLACEHOLDER_COMPANY.test(c);
}

/**
 * The company+title that identifies a posting, reading it from a Google page title when the company is a
 * placeholder ("Job Application for X at Acme"). Null when the company cannot be told.
 */
export function identityKey(p) {
  if (isRealCompany(p.company)) return companyTitleKey(p.company, p.title);
  const parsed = parseResultTitle(p.title);
  return isRealCompany(parsed.company) ? companyTitleKey(parsed.company, parsed.title) : null;
}

/** The key to store in company_title_key: the identity key, else the raw company and title. */
export const storedKey = (p) => identityKey(p) ?? companyTitleKey(p.company, p.title);

/** Recomputes company_title_key for every posting (after the key rules change). Returns how many changed. */
export function rekeyPostings(db) {
  const rows = db.prepare('SELECT id, company, title, company_title_key FROM postings').all();
  const update = db.prepare('UPDATE postings SET company_title_key = ? WHERE id = ?');
  let changed = 0;
  db.transaction(() => {
    for (const p of rows) {
      const key = storedKey(p);
      if (key !== p.company_title_key) {
        update.run(key, p.id);
        changed += 1;
      }
    }
  })();
  return changed;
}

/**
 * SQL condition (on alias q) for a copy worth pointing out: still in play, or one the user acted on.
 * Copies already archived as duplicates or skipped (status new, or changed by the agent) are left out.
 */
export function liveCopySql(db) {
  const lk = lookups(db);
  return `q.status != 'duplicate' AND (q.stage NOT IN ${sqlList(lk.ids('stage', 'archived'))} OR (q.status NOT IN ${sqlList(lk.ids('status', 'evaluate'))}
  AND COALESCE((SELECT h.changed_by FROM status_history h WHERE h.posting_id = q.id ORDER BY h.id DESC LIMIT 1), '') != 'agent'))`;
}

/** Other postings that are the same job as this one (same identity key) and still matter, oldest first. */
export function findCopies(db, posting) {
  const key = identityKey(posting);
  if (!key) return [];
  return db
    .prepare(`SELECT id, company, title, stage, status, applied_on AS appliedOn, discovered_on AS discoveredOn FROM postings q
      WHERE company_title_key = ? AND id != ? AND ${liveCopySql(db)} ORDER BY id`)
    .all(key, posting.id);
}
