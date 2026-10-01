// Moves finished or stale jobs out of the active pipeline (v1's archiveOldJobs rules):
//   closed, passed, rejected   archived right away, whatever their age
//   anything else              archived once discovered more than 30 days ago,
//                              unless an active conversation (interviewing, offer)
// Stage becomes 'archived'; status is kept, so the reason stays visible.
// archiveListings separately removes skipped postings (list-of-jobs pages, excluded sites) wherever they sit,
// and demoteWithoutText moves untouched pipeline jobs with no description back to Discovered.
import { skipReason } from '../../tools/listings.js';

export const ARCHIVE_AFTER_DAYS = 30;
const ARCHIVE_NOW = ['closed', 'passed', 'rejected'];
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

/**
 * Archives skipped postings and marks new ones passed, with a note and status history.
 * They stay in the database so their links are recognized and never added again.
 */
export function archiveListings(db, { config, now = new Date(), dryRun = false } = {}) {
  const found = findListings(db, config);
  if (!dryRun && found.length) {
    const nowIso = now.toISOString();
    const update = db.prepare(`UPDATE postings SET stage = 'archived', status = @status, updated_at = @now,
      notes = CASE WHEN TRIM(COALESCE(notes, '')) = '' THEN @note ELSE notes || char(10) || @note END WHERE id = @id`);
    const history = db.prepare("INSERT INTO status_history (posting_id, from_status, to_status, changed_by, changed_at) VALUES (?, ?, ?, 'agent', ?)");
    db.transaction(() => {
      for (const p of found) {
        const status = p.status === 'new' ? 'passed' : p.status;
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
