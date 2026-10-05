// Moves finished or stale jobs out of the active pipeline (v1's archiveOldJobs rules):
//   closed, passed, rejected,  archived right away, whatever their age
//   duplicate
//   anything else              archived once discovered more than 30 days ago,
//                              unless an active conversation (interviewing, offer)
// Stage becomes 'archived'; status is kept, so the reason stays visible.
// Cleanup after a rule change (npm run cleanup), separate from the pipeline's archive step:
//   archiveListings     removes skipped postings (list-of-jobs pages, excluded sites) and duplicates
//   demoteWithoutText   moves untouched pipeline jobs with no description back to Discovered
import { skipReason } from '../../tools/listings.js';
import { parseResultTitle } from '../discovery/sources/serper.js';
import { identityKey, isRealCompany } from '../identity.js';

export const ARCHIVE_AFTER_DAYS = 30;
const ARCHIVE_NOW = ['closed', 'passed', 'rejected', 'duplicate'];
const KEEP = ['interviewing', 'offer'];

/** Returns the pipeline postings to archive, each with a reason. */
export function findArchivable(db, { now = new Date(), days = ARCHIVE_AFTER_DAYS } = {}) {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  return db
    .prepare("SELECT id, company, title, status, discovered_on FROM postings WHERE stage = 'pipeline' ORDER BY id")
    .all()
    .map((p) => {
      if (ARCHIVE_NOW.includes(p.status)) return { ...p, reason: `status ${p.status}` };
      if (KEEP.includes(p.status)) return null;
      if (p.discovered_on < cutoffIso) return { ...p, reason: `discovered ${p.discovered_on}, over ${days} days ago` };
      return null;
    })
    .filter(Boolean);
}

/**
 * Postings that are never kept (see tools/listings.js: list-of-jobs pages, excluded sites) and are not
 * yet archived, or archived but still new. Applied, interviewing, and offer jobs are left alone.
 */
export function findListings(db, config) {
  return db
    .prepare("SELECT id, company, title, url, stage, status FROM postings WHERE stage != 'archived' OR status = 'new' ORDER BY id")
    .all()
    .map((p) => ({ ...p, reason: skipReason(p, config) }))
    .filter((p) => p.reason && !['applied', 'interviewing', 'offer'].includes(p.status));
}

// Which copy of a duplicated job to keep: the one the user acted on, then one still in play (not archived),
// then the pipeline (scored and promoted), then one with text, then the oldest.
const STATUS_RANK = { offer: 0, interviewing: 1, applied: 2, rejected: 3, closed: 4, passed: 5, new: 6, duplicate: 7 };
// A copy this cleanup already removed (its last status change is the agent's) never wins over one still in play.
const keepRank = (p) => [p.agent_removed ? 9 : STATUS_RANK[p.status] ?? 6, p.stage === 'archived' ? 1 : 0, p.stage === 'pipeline' ? 0 : 1, p.has_text ? 0 : 1, p.id];
const byRank = (a, b) => {
  const x = keepRank(a);
  const y = keepRank(b);
  return x.reduce((d, v, i) => d || v - y[i], 0);
};

/**
 * Extra copies of one job (same company and title, including "See posting" rows whose Google title
 * names the company). Only new, unarchived copies are returned; the best copy is kept.
 */
export function findDuplicates(db) {
  const rows = db
    .prepare(`SELECT id, company, title, url, stage, status, company_title_key,
        TRIM(COALESCE(jd_text, '') || COALESCE(fetched_text, '')) != '' AS has_text,
        -- removed by cleanup: the agent changed an existing status (discovery's first status, from nothing, does not count)
        COALESCE((SELECT h.changed_by = 'agent' AND h.from_status IS NOT NULL FROM status_history h WHERE h.posting_id = p.id ORDER BY h.id DESC LIMIT 1), 0) AS agent_removed
      FROM postings p`)
    .all();
  const groups = new Map();
  for (const p of rows) {
    const key = identityKey(p);
    if (key) groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const found = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [keep, ...rest] = [...group].sort(byRank);
    const named = isRealCompany(keep.company) ? keep : parseResultTitle(keep.title);
    const what = `#${keep.id}, ${named.title} at ${named.company}, ${keep.stage}/${keep.status}`;
    for (const p of rest) {
      if (p.status === 'new' && p.stage !== 'archived') found.push({ ...p, reason: `duplicate of ${what}` });
    }
  }
  return found.sort((a, b) => a.id - b.id);
}

/**
 * Archives skipped postings and duplicates and marks new ones passed, with a note and status history
 * (changed_by 'agent', which the scoring eval ignores). They stay in the database so their links are
 * recognized and never added again.
 */
export function archiveListings(db, { config, now = new Date(), dryRun = false } = {}) {
  const skipped = findListings(db, config);
  const seen = new Set(skipped.map((p) => p.id));
  const found = [...skipped, ...findDuplicates(db).filter((p) => !seen.has(p.id))];
  if (!dryRun && found.length) {
    const nowIso = now.toISOString();
    const update = db.prepare(`UPDATE postings SET stage = 'archived', status = @status, updated_at = @now,
      notes = CASE WHEN TRIM(COALESCE(notes, '')) = '' THEN @note ELSE notes || char(10) || @note END WHERE id = @id`);
    const history = db.prepare("INSERT INTO status_history (posting_id, from_status, to_status, changed_by, changed_at) VALUES (?, ?, ?, 'agent', ?)");
    db.transaction(() => {
      for (const p of found) {
        const status = p.status !== 'new' ? p.status : /^duplicate of/.test(p.reason) ? 'duplicate' : 'passed';
        update.run({ id: p.id, status, now: nowIso, note: `Removed ${nowIso.slice(0, 10)}: ${p.reason}.` });
        if (status !== p.status) history.run(p.id, p.status, status, nowIso);
      }
    })();
  }
  return { archived: found, dryRun };
}

/**
 * Pipeline jobs still new that have no description (v1 promoted many from the title alone). They go
 * back to Discovered, where the UI flags them, until a description is pasted and they are re-scored.
 */
export function demoteWithoutText(db, { now = new Date(), dryRun = false } = {}) {
  const found = db
    .prepare(`SELECT id, company, title, status FROM postings WHERE stage = 'pipeline' AND status = 'new'
      AND TRIM(COALESCE(jd_text, '') || COALESCE(fetched_text, '')) = '' ORDER BY id`)
    .all();
  if (!dryRun && found.length) {
    const update = db.prepare("UPDATE postings SET stage = 'discovered', updated_at = ? WHERE id = ? AND stage = 'pipeline'");
    db.transaction(() => {
      for (const p of found) update.run(now.toISOString(), p.id);
    })();
  }
  return { demoted: found, dryRun };
}

/** Archives them (unless dryRun). Returns { archived: [...], kept: number }. */
export function archivePostings(db, { now = new Date(), days = ARCHIVE_AFTER_DAYS, dryRun = false } = {}) {
  const moves = findArchivable(db, { now, days });
  if (!dryRun && moves.length) {
    const update = db.prepare("UPDATE postings SET stage = 'archived', updated_at = ? WHERE id = ? AND stage = 'pipeline'");
    const nowIso = now.toISOString();
    db.transaction(() => {
      for (const m of moves) update.run(nowIso, m.id);
    })();
  }
  const total = db.prepare("SELECT COUNT(*) FROM postings WHERE stage = 'pipeline'").pluck().get();
  return { archived: moves, remaining: total, dryRun };
}
