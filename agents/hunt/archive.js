// Moves finished or stale jobs out of the active pipeline (v1's archiveOldJobs rules):
//   closed, passed, rejected   archived right away, whatever their age
//   anything else              archived once discovered more than 30 days ago,
//                              unless an active conversation (interviewing, offer)
// Stage becomes 'archived'; status is kept, so the reason stays visible.

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
