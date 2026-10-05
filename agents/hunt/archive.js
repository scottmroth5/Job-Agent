// Moves finished or stale jobs out of the active stages (v1's archiveOldJobs rules), by status group
// (agents/lookups.js):
//   Closed                          archived right away, whatever their age
//   In conversation, Decision       never archived automatically
//   anything else                   archived once discovered more than 30 days ago
// Jobs move to the archive stage role; status is kept, so the reason stays visible.
// Cleanup after a rule change (npm run cleanup), separate from the pipeline's archive step:
//   archiveListings     removes skipped postings (list-of-jobs pages, excluded sites) and duplicates
//   demoteWithoutText   moves untouched active jobs with no description back to the default stage
import { skipReason } from '../../tools/listings.js';
import { parseResultTitle } from '../discovery/sources/serper.js';
import { identityKey, isRealCompany } from '../identity.js';
import { lookups, sqlList } from '../lookups.js';

export const ARCHIVE_AFTER_DAYS = 30;

/** Returns the active-stage postings to archive, each with a reason. */
export function findArchivable(db, { now = new Date(), days = ARCHIVE_AFTER_DAYS } = {}) {
  const lk = lookups(db);
  const closed = lk.closed();
  const keep = lk.neverAutoArchived();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  return db
    .prepare(`SELECT id, company, title, status, discovered_on FROM postings WHERE stage IN ${sqlList(lk.ids('stage', 'active'))} ORDER BY id`)
    .all()
    .map((p) => {
      if (closed.includes(p.status)) return { ...p, reason: `status ${p.status}` };
      if (keep.includes(p.status)) return null;
      if (p.discovered_on < cutoffIso) return { ...p, reason: `discovered ${p.discovered_on}, over ${days} days ago` };
      return null;
    })
    .filter(Boolean);
}

/**
 * Postings that are never kept (see tools/listings.js: list-of-jobs pages, excluded sites) and are not
 * yet archived, or archived but still to evaluate. Jobs in progress are left alone.
 */
export function findListings(db, config) {
  const lk = lookups(db);
  const inProgress = lk.inProgress();
  return db
    .prepare(`SELECT id, company, title, url, stage, status FROM postings
      WHERE stage NOT IN ${sqlList(lk.ids('stage', 'archived'))} OR status IN ${sqlList(lk.ids('status', 'evaluate'))} ORDER BY id`)
    .all()
    .map((p) => ({ ...p, reason: skipReason(p, config) }))
    .filter((p) => p.reason && !inProgress.includes(p.status));
}

// Which copy of a duplicated job to keep: the one the user acted on (furthest along first), then one still in
// play (not archived), then an active one (scored and promoted), then one with text, then the oldest.
const GROUP_RANK = { decision: 0, conversation: 1, waiting: 2, closed: 4, evaluate: 6 };

/**
 * Extra copies of one job (same company and title, including "See posting" rows whose Google title
 * names the company). Only unarchived copies still to evaluate are returned; the best copy is kept.
 */
export function findDuplicates(db) {
  const lk = lookups(db);
  const archived = lk.ids('stage', 'archived');
  const active = lk.ids('stage', 'active');
  const evaluate = lk.ids('status', 'evaluate');
  // A copy this cleanup already removed (its last status change is the agent's) never wins over one still in play.
  const keepRank = (p) => [
    p.agent_removed ? 9 : p.status === 'duplicate' ? 7 : GROUP_RANK[lk.groupOf('status', p.status)] ?? 6,
    archived.includes(p.stage) ? 1 : 0,
    active.includes(p.stage) ? 0 : 1,
    p.has_text ? 0 : 1,
    p.id,
  ];
  const byRank = (a, b) => {
    const x = keepRank(a);
    const y = keepRank(b);
    return x.reduce((d, v, i) => d || v - y[i], 0);
  };
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
      if (evaluate.includes(p.status) && !archived.includes(p.stage)) found.push({ ...p, reason: `duplicate of ${what}` });
    }
  }
  return found.sort((a, b) => a.id - b.id);
}

/**
 * Archives skipped postings and duplicates and marks them passed (or duplicate), with a note and status
 * history (changed_by 'agent', which the scoring eval ignores). They stay in the database so their links are
 * recognized and never added again.
 */
export function archiveListings(db, { config, now = new Date(), dryRun = false } = {}) {
  const lk = lookups(db);
  const evaluate = lk.ids('status', 'evaluate');
  const skipped = findListings(db, config);
  const seen = new Set(skipped.map((p) => p.id));
  const found = [...skipped, ...findDuplicates(db).filter((p) => !seen.has(p.id))];
  if (!dryRun && found.length) {
    const nowIso = now.toISOString();
    const update = db.prepare(`UPDATE postings SET stage = @stage, status = @status, updated_at = @now,
      notes = CASE WHEN TRIM(COALESCE(notes, '')) = '' THEN @note ELSE notes || char(10) || @note END WHERE id = @id`);
    const history = db.prepare("INSERT INTO status_history (posting_id, from_status, to_status, changed_by, changed_at) VALUES (?, ?, ?, 'agent', ?)");
    const stage = lk.role('stage', 'archive');
    db.transaction(() => {
      for (const p of found) {
        const status = !evaluate.includes(p.status) ? p.status : /^duplicate of/.test(p.reason) ? 'duplicate' : 'passed';
        update.run({ id: p.id, stage, status, now: nowIso, note: `Removed ${nowIso.slice(0, 10)}: ${p.reason}.` });
        if (status !== p.status) history.run(p.id, p.status, status, nowIso);
      }
    })();
  }
  return { archived: found, dryRun };
}

/**
 * Active jobs still to evaluate that have no description (v1 promoted many from the title alone). They go
 * back to the default stage, where the UI flags them, until a description is pasted and they are re-scored.
 */
export function demoteWithoutText(db, { now = new Date(), dryRun = false } = {}) {
  const lk = lookups(db);
  const active = sqlList(lk.ids('stage', 'active'));
  const found = db
    .prepare(`SELECT id, company, title, status FROM postings WHERE stage IN ${active} AND status IN ${sqlList(lk.ids('status', 'evaluate'))}
      AND TRIM(COALESCE(jd_text, '') || COALESCE(fetched_text, '')) = '' ORDER BY id`)
    .all();
  if (!dryRun && found.length) {
    const update = db.prepare(`UPDATE postings SET stage = ?, updated_at = ? WHERE id = ? AND stage IN ${active}`);
    db.transaction(() => {
      for (const p of found) update.run(lk.role('stage', 'default'), now.toISOString(), p.id);
    })();
  }
  return { demoted: found, dryRun };
}

/** Archives them (unless dryRun). Returns { archived: [...], remaining: number }. */
export function archivePostings(db, { now = new Date(), days = ARCHIVE_AFTER_DAYS, dryRun = false } = {}) {
  const lk = lookups(db);
  const active = sqlList(lk.ids('stage', 'active'));
  const moves = findArchivable(db, { now, days });
  if (!dryRun && moves.length) {
    const update = db.prepare(`UPDATE postings SET stage = ?, updated_at = ? WHERE id = ? AND stage IN ${active}`);
    const nowIso = now.toISOString();
    db.transaction(() => {
      for (const m of moves) update.run(lk.role('stage', 'archive'), nowIso, m.id);
    })();
  }
  const total = db.prepare(`SELECT COUNT(*) FROM postings WHERE stage IN ${active}`).pluck().get();
  return { archived: moves, remaining: total, dryRun };
}
