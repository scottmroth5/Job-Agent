// The monthly backup restore test: proves the newest backup can be decrypted and read. Counts and table names only; no
// row is read. A SQLite backup is decrypted into a new folder in the OS temp folder (never next to data/job-agent.db) and
// checked with SQLite's integrity check (restoreBackup); a PostgreSQL backup (job-agent.dump, v3 Phase 5) is restored
// into a throwaway cluster (tools/backup/pg.ts, the backup container only). Either way the copy is deleted on every exit
// path, and its tables are compared with the live database by row count.
// It fails when the backup cannot be decrypted or read, fails the integrity check or the restore, is missing a table the
// live database has (unless the backup predates a migration that added it, by schema_migrations), or has a table empty
// that holds 10 or more rows live (a backup missing its data). A backup is from the night before and rows are also
// deleted on purpose (jobs archived and cleaned up, accounts deleted with all their rows), so other count differences are
// recorded, not failures. A backup also holds the settings file and attachments; it must decrypt and unpack whole for the
// check to pass.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openReadOnly } from '../../db/engine/files.ts';
import { decrypt, unpack } from './crypto.ts';
import { isBackupName, PG_DB_ENTRY, restoreBackup } from './run.ts';
import type { BackupDrive } from './drive.ts';
import type { Db } from '../../db/engine/types.ts';

export const EMPTY_TABLE_MIN_ROWS = 10;

const quoted = (t: string) => `"${t.replace(/"/g, '""')}"`;

/** Every table's row count, on either engine (PostgreSQL: the store's own schema). */
async function tableCounts(q: Db): Promise<Record<string, number>> {
  const sql = q.dialect === 'postgres'
    ? "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name"
    : "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name";
  const tables = (await q.prepare(sql).pluck().all()) as string[];
  const counts: Record<string, number> = {};
  for (const t of tables) counts[t] = Number(await q.prepare(`SELECT COUNT(*) FROM ${quoted(t)}`).pluck().get());
  return counts;
}

/** This app's newest migration id (agent-core's share the table under their own app name), or null. */
async function lastMigration(db: Db): Promise<string | null> {
  try {
    return ((await db.prepare("SELECT MAX(id) FROM schema_migrations WHERE app = 'job-agent'").pluck().get()) as string | null) ?? null;
  } catch {
    return null;
  }
}

type Facts = { counts: Record<string, number>; schema: string | null };

/** A SQLite backup's counts: decrypted into dir and integrity-checked by restoreBackup. */
async function sqliteFacts(file: Buffer, passphrase: string, dir: string): Promise<Facts> {
  const { database } = restoreBackup({ file, passphrase, outPath: join(dir, 'restored.db') });
  const restored = openReadOnly(database);
  try {
    return { counts: await tableCounts(restored.db), schema: await lastMigration(restored.db) };
  } finally {
    restored.close();
  }
}

/** A PostgreSQL backup's counts: the dump restored into a throwaway cluster. */
async function pgFacts(dump: Buffer, dir: string): Promise<Facts> {
  const { restoreInto, withScratchCluster } = await import('./pg.ts');
  const file = join(dir, PG_DB_ENTRY);
  writeFileSync(file, dump, { mode: 0o600 });
  return await withScratchCluster(async (scratch) => {
    await restoreInto(scratch, file);
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: scratch });
    await client.connect();
    try {
      const tables = (await client.query<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1")).rows.map((r) => r.t);
      const counts: Record<string, number> = {};
      for (const t of tables) counts[t] = Number((await client.query<{ n: string }>(`SELECT COUNT(*) AS n FROM ${quoted(t)}`)).rows[0]?.n);
      const schema = tables.includes('schema_migrations')
        ? ((await client.query<{ m: string | null }>("SELECT MAX(id) AS m FROM schema_migrations WHERE app = 'job-agent'")).rows[0]?.m ?? null)
        : null;
      return { counts, schema };
    } finally {
      await client.end();
    }
  });
}

/**
 * file is the encrypted backup; live is the live database (only counted). Throws when the backup cannot be decrypted, is
 * not a database, or fails its check.
 */
export async function restoreTest({ file, passphrase, live }: { file: Buffer; passphrase: string; live: Db }) {
  const dir = mkdtempSync(join(tmpdir(), 'ja-restore-test-'));
  try {
    const dump = unpack(decrypt(file, passphrase)).find((f) => f.name === PG_DB_ENTRY);
    const { counts: backupCounts, schema: backupSchema } = dump ? await pgFacts(dump.data, dir) : await sqliteFacts(file, passphrase, dir);
    const liveCounts = await tableCounts(live);
    // A backup taken before a migration lacks that migration's new tables; that is expected, not a fault.
    const olderSchema = backupSchema !== null && backupSchema < ((await lastMigration(live)) as string);
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
    return { ok: problems.length === 0, problems, tables: Object.keys(backupCounts).length, rowsBackup: sum(backupCounts), rowsLive: sum(liveCounts), differences, engine: dump ? 'postgres' : 'sqlite' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The newest backup in the Drive folder ({ id, name }), or null. */
export async function newestBackup(drive: BackupDrive, folderName: string) {
  const folder = await drive.ensureFolder(folderName);
  return (await drive.list(folder)).filter((f) => isBackupName(f.name)).sort((a, b) => b.name.localeCompare(a.name))[0] ?? null;
}
