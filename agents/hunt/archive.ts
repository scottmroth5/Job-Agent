// Moves finished or stale jobs out of the active stages (v1's archiveOldJobs rules), by status group
// (agents/lookups.ts):
//   Closed                          archived right away, whatever their age
//   In conversation, Decision       never archived automatically
//   anything else                   archived once discovered more than 30 days ago
// Jobs move to the archive stage role; status is kept, so the reason stays visible.
// Cleanup after a rule change (npm run cleanup), separate from the pipeline's archive step:
//   archiveListings     removes skipped postings (list-of-jobs pages, excluded sites) and duplicates
//   demoteWithoutText   moves untouched active jobs with no description back to the default stage
import { skipReason } from '../../tools/listings.ts';
import { parseResultTitle } from '../discovery/sources/serper.ts';
import { identityKey, isRealCompany } from '../identity.ts';
import { lookups, sqlList } from '../lookups.ts';
import { addNote } from '../notes.ts';
import { asEngine } from '../../db/engine/index.ts';
import { localDay, localDaysAgo } from '../../tools/dates.ts';
import type { Database } from '../../tools/types.ts';
import type { PostingsRow } from '../../db/types.ts';

/** A job a cleanup removes, with the reason (written into its note). */
type Found = Pick<PostingsRow, 'id' | 'status'> & { reason: string };
/** A copy of a job findDuplicates ranks. */
type Copy = Pick<PostingsRow, 'id' | 'company' | 'title' | 'url' | 'stage' | 'status' | 'company_title_key'> & { has_text: number; agent_removed: number };
type Listing = Pick<PostingsRow, 'id' | 'company' | 'title' | 'url' | 'stage' | 'status'>;

export const ARCHIVE_AFTER_DAYS = 30;

/** Returns the active-stage postings to archive, each with a reason. */
export async function findArchivable(db: Database, { now = new Date(), days = ARCHIVE_AFTER_DAYS }: { now?: Date; days?: number } = {}) {
  const lk = await lookups(db);
  const closed = lk.closed();
  const keep = lk.neverAutoArchived();
  const cutoffIso = localDaysAgo(now, days);
  return (await asEngine(db)
    .prepare(`SELECT id, company, title, status, discovered_on FROM postings WHERE user_id = @uid AND stage IN ${sqlList(lk.ids('stage', 'active'))} ORDER BY id`)
    .all() as Array<Pick<PostingsRow, 'id' | 'company' | 'title' | 'status' | 'discovered_on'>>)
    .map((p) => {
      if (closed.includes(p.status)) return { ...p, reason: `status ${p.status}` };
      if (keep.includes(p.status)) return null;
      if (p.discovered_on < cutoffIso) return { ...p, reason: `discovered ${p.discovered_on}, over ${days} days ago` };
      return null;
    })
    .filter(Boolean) as Array<Pick<PostingsRow, 'id' | 'company' | 'title' | 'status' | 'discovered_on'> & { reason: string }>;
}

/**
 * Postings that are never kept (see tools/listings.ts: list-of-jobs pages, excluded sites) and are not
 * yet archived, or archived but still to evaluate. Jobs in progress are left alone.
 */
export async function findListings(db: Database, config: Parameters<typeof skipReason>[1]) {
  const lk = await lookups(db);
  const inProgress = lk.inProgress();
  return (await asEngine(db)
    .prepare(`SELECT id, company, title, url, stage, status FROM postings
      WHERE user_id = @uid AND (stage NOT IN ${sqlList(lk.ids('stage', 'archived'))} OR status IN ${sqlList(lk.ids('status', 'evaluate'))}) ORDER BY id`)
    .all() as Listing[])
    .map((p) => ({ ...p, reason: skipReason(p, config) }))
    .filter((p) => p.reason && !inProgress.includes(p.status)) as Array<Listing & { reason: string }>;
}

// Which copy of a duplicated job to keep: the one the user acted on (furthest along first), then one still in
// play (not archived), then an active one (scored and promoted), then one with text, then the oldest.
const GROUP_RANK: Record<string, number> = { decision: 0, conversation: 1, waiting: 2, closed: 4, evaluate: 6 };

/**
 * Extra copies of one job (same company and title, including "See posting" rows whose Google title
 * names the company). Only unarchived copies still to evaluate are returned; the best copy is kept.
 */
export async function findDuplicates(db: Database) {
  const lk = await lookups(db);
  const archived = lk.ids('stage', 'archived');
  const active = lk.ids('stage', 'active');
  const evaluate = lk.ids('status', 'evaluate');
  const duplicate = lk.role('status', 'duplicate');
  // A copy this cleanup already removed (its last status change is the agent's) never wins over one still in play.
  const keepRank = (p: Copy) => [
    p.agent_removed ? 9 : p.status === duplicate ? 7 : GROUP_RANK[lk.groupOf('status', p.status) as string] ?? 6,
    archived.includes(p.stage) ? 1 : 0,
    active.includes(p.stage) ? 0 : 1,
    p.has_text ? 0 : 1,
    p.id,
  ];
  const byRank = (a: Copy, b: Copy) => {
    const x = keepRank(a);
    const y = keepRank(b);
    return x.reduce((d, v, i) => d || v - y[i], 0);
  };
  const rows = (await asEngine(db)
    .prepare(`SELECT id, company, title, url, stage, status, company_title_key,
        TRIM(COALESCE(jd_text, '') || COALESCE(fetched_text, '')) != '' AS has_text,
        -- removed by cleanup: the agent changed an existing status (discovery's first status, from nothing, does not count)
        COALESCE((SELECT h.changed_by = 'agent' AND h.from_status IS NOT NULL FROM status_history h WHERE h.posting_id = p.id AND h.user_id = p.user_id ORDER BY h.id DESC LIMIT 1), 0) AS agent_removed
      FROM postings p WHERE p.user_id = @uid`)
    .all() as Copy[]);
  const groups = new Map<string, Copy[]>();
  for (const p of rows) {
    const key = identityKey(p);
    if (key) groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const found: Array<Copy & { reason: string }> = [];
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
export async function archiveListings(db: Database, { config, now = new Date(), dryRun = false }: { config?: Parameters<typeof skipReason>[1]; now?: Date; dryRun?: boolean } = {}) {
  const skipped = await findListings(db, config);
  const seen = new Set(skipped.map((p) => p.id));
  const found = [...skipped, ...(await findDuplicates(db)).filter((p) => !seen.has(p.id))];
  if (!dryRun && found.length) await archiveFound(db, found, now);
  return { archived: found, dryRun };
}

/**
 * The saved jobs from one skipped site that cleanup would remove (not archived or still to evaluate, and not in
 * progress), or archives them: Skip this site's "remove the saved ones". Jobs you applied to are never touched.
 */
export async function archiveSiteJobs(db: Database, site: string, { now = new Date(), dryRun = false }: { now?: Date; dryRun?: boolean } = {}) {
  const found = (await findListings(db, { search: { excludedSites: [site] } })).filter((p) => p.reason.startsWith('excluded site'));
  if (!dryRun && found.length) await archiveFound(db, found, now);
  return { archived: found, dryRun };
}

// Archives each one and marks it with the passed (or duplicate) role's status, with a note and status history, changed_by 'agent'.
async function archiveFound(db: Database, found: Found[], now: Date) {
  // The jobs are found and archived in one transaction.
  return asEngine(db).tx(async () => {
    const lk = await lookups(db);
    const evaluate = lk.ids('status', 'evaluate');
    const nowIso = now.toISOString();
    const update = asEngine(db).prepare('UPDATE postings SET stage = @stage, status = @status, updated_at = @now WHERE id = @id AND user_id = @uid');
    const history = asEngine(db).prepare("INSERT INTO status_history (user_id, posting_id, from_status, to_status, changed_by, changed_at) VALUES (@uid, ?, ?, ?, 'agent', ?)");
    const stage = lk.role('stage', 'archive');
    // 023 sets both roles, and a role is moved, never removed.
    const [duplicate, passed] = [lk.role('status', 'duplicate') as string, lk.role('status', 'passed') as string];
    await asEngine(db).tx(async () => {
      for (const p of found) {
        const status = !evaluate.includes(p.status) ? p.status : /^duplicate of/.test(p.reason) ? duplicate : passed;
        await update.run({ id: p.id, stage, status, now: nowIso });
        await addNote(db, p.id, `Removed ${localDay(now)}: ${p.reason}.`, { source: 'agent', now });
        if (status !== p.status) await history.run(p.id, p.status, status, nowIso);
      }
    });
  });
}

/**
 * Active jobs still to evaluate that have no description (v1 promoted many from the title alone). They go
 * back to the default stage, where the UI flags them, until a description is pasted and they are re-scored.
 */
export async function demoteWithoutText(db: Database, { now = new Date(), dryRun = false }: { now?: Date; dryRun?: boolean } = {}) {
  // Read and moved in one transaction.
  return asEngine(db).tx(async () => {
    const lk = await lookups(db);
    const active = sqlList(lk.ids('stage', 'active'));
    const found = await asEngine(db)
      .prepare(`SELECT id, company, title, status FROM postings WHERE user_id = @uid AND stage IN ${active} AND status IN ${sqlList(lk.ids('status', 'evaluate'))}
        AND TRIM(COALESCE(jd_text, '') || COALESCE(fetched_text, '')) = '' ORDER BY id`)
      .all() as Array<Pick<PostingsRow, 'id' | 'company' | 'title' | 'status'>>;
    if (!dryRun && found.length) {
      const update = asEngine(db).prepare(`UPDATE postings SET stage = ?, updated_at = ? WHERE id = ? AND user_id = @uid AND stage IN ${active}`);
      await asEngine(db).tx(async () => {
        for (const p of found) await update.run(lk.role('stage', 'default'), now.toISOString(), p.id);
      });
    }
    return { demoted: found, dryRun };
  });
}

/** Archives them (unless dryRun). Returns { archived: [...], remaining: number }. */
export async function archivePostings(db: Database, { now = new Date(), days = ARCHIVE_AFTER_DAYS, dryRun = false }: { now?: Date; days?: number; dryRun?: boolean } = {}) {
  // Read and archived in one transaction.
  return asEngine(db).tx(async () => {
    const lk = await lookups(db);
    const active = sqlList(lk.ids('stage', 'active'));
    const moves = await findArchivable(db, { now, days });
    if (!dryRun && moves.length) {
      const update = asEngine(db).prepare(`UPDATE postings SET stage = ?, updated_at = ? WHERE id = ? AND user_id = @uid AND stage IN ${active}`);
      const nowIso = now.toISOString();
      await asEngine(db).tx(async () => {
        for (const m of moves) await update.run(lk.role('stage', 'archive'), nowIso, m.id);
      });
    }
    const total = await asEngine(db).prepare(`SELECT COUNT(*) FROM postings WHERE user_id = @uid AND stage IN ${active}`).pluck().get() as number;
    return { archived: moves, remaining: total, dryRun };
  });
}
