// The v3 baseline (docs/v3/PLAN.md, Phase 0): counts that size the move to PostgreSQL and show how complete the outcome
// data is. Opens the database read-only (no migrations, no pre-migration copy) and reads no text columns: table row counts,
// file and attachment sizes, Claude spend by month, accounts by status, and per-user outcome counts summed over users.
import Database from 'better-sqlite3';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runAsUser, scopeDb } from '../db/scope.ts';
import { applications } from '../server/funnel.ts';
import { waitingApplications } from '../agents/follow-ups.ts';

const LINKED = "('auto', 'confirmed', 'reassigned')";

/** Files and bytes under a folder (0 and 0 when it does not exist). */
function folderSize(dir: string): { files: number; bytes: number } {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true, recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { files: 0, bytes: 0 };
    throw err;
  }
  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    files += 1;
    bytes += statSync(join(entry.parentPath ?? entry.path, entry.name)).size;
  }
  return { files, bytes };
}

/**
 * The baseline for one database file.
 * @param {string} path  the SQLite file (opened read-only; it must exist)
 * @param {{ attachmentsDir?: string, now?: Date }} [options]
 */
export async function baselineReport(path: string, { attachmentsDir = null, now = new Date() }: { attachmentsDir?: string | null; now?: Date } = {}) {
  const raw = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .pluck()
      .all()
      .map((name) => name as string)
      .map((name) => ({ table: name, rows: raw.prepare(`SELECT COUNT(*) FROM "${name.replaceAll('"', '""')}"`).pluck().get() as number }));
    const pageSize = raw.pragma('page_size', { simple: true }) as number;
    const pageCount = raw.pragma('page_count', { simple: true }) as number;
    const spendByMonth = raw
      .prepare('SELECT substr(created_at, 1, 7) AS month, ROUND(SUM(cost_usd), 2) AS usd, COUNT(*) AS calls FROM run_calls WHERE cost_usd IS NOT NULL GROUP BY month ORDER BY month')
      .all() as Array<{ month: string; usd: number; calls: number }>;
    const usersByStatus = raw.prepare('SELECT status, COUNT(*) AS count FROM users GROUP BY status ORDER BY status').all() as Array<{ status: string; count: number }>;

    // Outcome data quality, each user's counts through the same code the Funnel and follow-ups use, summed.
    const db = scopeDb(raw);
    const outcomes = { applications: 0, noAppliedOn: 0, withLinkedEmail: 0, followUp: 0, stale: 0 };
    for (const uid of raw.prepare('SELECT id FROM users ORDER BY id').pluck().all() as number[]) {
      await runAsUser(uid, async () => {
        const apps = await applications(db, { now });
        const noDate = new Set(db.prepare('SELECT id FROM postings WHERE user_id = @uid AND applied_on IS NULL').pluck().all());
        const linked = new Set(db.prepare(`SELECT DISTINCT posting_id FROM emails WHERE user_id = @uid AND posting_id IS NOT NULL AND review_status IN ${LINKED}`).pluck().all());
        const waiting = await waitingApplications(db, { now });
        outcomes.applications += apps.length;
        outcomes.noAppliedOn += apps.filter((a) => noDate.has(a.id)).length;
        outcomes.withLinkedEmail += apps.filter((a) => linked.has(a.id)).length;
        outcomes.followUp += waiting.followUp.length;
        outcomes.stale += waiting.stale.length;
      });
    }

    return {
      at: now.toISOString(),
      database: { bytes: statSync(path).size, pageSize, pageCount },
      attachments: attachmentsDir ? folderSize(attachmentsDir) : { files: 0, bytes: 0 },
      tables,
      spendByMonth,
      usersByStatus,
      outcomes,
    };
  } finally {
    raw.close();
  }
}

export type Baseline = Awaited<ReturnType<typeof baselineReport>>;

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The report as plain text lines. */
export function renderBaseline(r: Baseline) {
  const lines = [`Baseline at ${r.at}`, '', `Database: ${mb(r.database.bytes)} (${r.database.pageCount} pages of ${r.database.pageSize} bytes)`];
  lines.push(`Attachments: ${r.attachments.files} files, ${mb(r.attachments.bytes)}`, '', 'Rows per table:');
  for (const t of r.tables) lines.push(`  ${t.table}: ${t.rows}`);
  lines.push('', 'Claude spend by month (UTC):');
  if (!r.spendByMonth.length) lines.push('  none');
  for (const m of r.spendByMonth) lines.push(`  ${m.month}: $${m.usd.toFixed(2)} (${m.calls} calls)`);
  lines.push('', 'Accounts by status:');
  for (const u of r.usersByStatus) lines.push(`  ${u.status}: ${u.count}`);
  const o = r.outcomes;
  lines.push(
    '',
    'Outcome data (all users):',
    `  applications: ${o.applications}`,
    `  with no applied date: ${o.noAppliedOn}`,
    `  with a linked email: ${o.withLinkedEmail}`,
    `  worth a follow-up: ${o.followUp}`,
    `  stale: ${o.stale}`,
  );
  return lines.join('\n');
}
