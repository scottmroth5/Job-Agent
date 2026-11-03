// The monthly backup restore test: proves the newest backup can be decrypted and read. The backup is decrypted into a new
// folder in the OS temp folder (never next to data/job-agent.db), checked with SQLite's integrity check (restoreBackup), and
// its tables compared with the live database by row count; the folder is deleted on every exit path. Counts and table
// names only; no row is read.
// It fails when the backup cannot be decrypted or read, fails the integrity check, is missing a table the live database
// has (unless the backup predates a migration that added it, by schema_migrations),
// or has a table empty that holds 10 or more rows live (a backup missing its data). A backup is from the night before
// and rows are also deleted on purpose (jobs archived and cleaned up, accounts deleted with all their
// rows), so other count differences are recorded, not failures. A backup also holds the settings file and attachments;
// it must decrypt and unpack whole for the check to pass.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { isBackupName, restoreBackup } from './run.ts';
import type { BackupDrive } from './drive.ts';

export const EMPTY_TABLE_MIN_ROWS = 10;

const tableCounts = (db: Database.Database): Record<string, number> => Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .pluck().all() as string[]).map((t) => [t, db.prepare(`SELECT COUNT(*) FROM "${t.replace(/"/g, '""')}"`).pluck().get() as number]));

/**
 * file is the encrypted backup; live is the live database (only counted). Throws when the backup cannot be decrypted, is
 * not a database, or fails the integrity check.
 */
export function restoreTest({ file, passphrase, live }: { file: Buffer; passphrase: string; live: Database.Database }) {
  const dir = mkdtempSync(join(tmpdir(), 'ja-restore-test-'));
  try {
    const { database } = restoreBackup({ file, passphrase, outPath: join(dir, 'restored.db') });
    const restored = new Database(database, { readonly: true });
    const lastMigration = (db: Database.Database): string | null => {
      // This app's migrations (agent-core's share the table under their own app name).
      try { return db.prepare("SELECT MAX(id) FROM schema_migrations WHERE app = 'job-agent'").pluck().get() as string | null ?? null; } catch { return null; }
    };
    let backupCounts: Record<string, number>;
    let backupSchema: string | null;
    try {
      backupCounts = tableCounts(restored);
      backupSchema = lastMigration(restored);
    } finally {
      restored.close();
    }
    const liveCounts = tableCounts(live);
    // A backup taken before a migration lacks that migration's new tables; that is expected, not a fault.
    const olderSchema = backupSchema !== null && backupSchema < (lastMigration(live) as string);
    const problems: string[] = [];
    const differences: Array<{ table: string; backup: number | null; live: number }> = [];
    for (const [table, n] of Object.entries(liveCounts)) {
      if (!(table in backupCounts)) {
        if (olderSchema) differences.push({ table, backup: null, live: n });
        else problems.push(`table ${table} is missing from the backup`);
        continue;
      }
      const b = backupCounts[table] as number;
      if (b === 0 && n >= EMPTY_TABLE_MIN_ROWS) problems.push(`table ${table} is empty in the backup but has ${n} rows`);
      if (b !== n) differences.push({ table, backup: b, live: n });
    }
    const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
    return { ok: problems.length === 0, problems, tables: Object.keys(backupCounts).length, rowsBackup: sum(backupCounts), rowsLive: sum(liveCounts), differences };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The newest backup in the Drive folder ({ id, name }), or null. */
export async function newestBackup(drive: BackupDrive, folderName: string) {
  const folder = await drive.ensureFolder(folderName);
  return (await drive.list(folder)).filter((f) => isBackupName(f.name)).sort((a, b) => b.name.localeCompare(a.name))[0] ?? null;
}
