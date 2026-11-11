// Work on SQLite database files rather than through queries: read-only opens, consistent copies, online backups, and
// integrity checks. Like the engine, this is the only place outside db/migrations that may use better-sqlite3
// (eslint no-restricted-imports); a PostgreSQL engine (Phase 4) brings its own way to do these.
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { createSqliteEngine } from './sqlite.ts';
import type { Db } from './types.ts';

/** A database file opened read-only through the engine (unscoped). mustExist: refuse a missing file. */
export function openReadOnly(path: string, { mustExist = true }: { mustExist?: boolean } = {}): { db: Db; close: () => void } {
  const raw = new Database(path, { readonly: true, fileMustExist: mustExist });
  return { db: createSqliteEngine(raw, { fallbackUid: null, strictTx: false }), close: () => raw.close() };
}

/** SQLite's integrity check of a database file: 'ok', or the first problem it reports. */
export function integrityOf(path: string): string {
  const raw = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return String(raw.pragma('integrity_check', { simple: true }));
  } finally {
    raw.close();
  }
}

/** The schema_migrations entries a database file has (empty for a new or migration-less file). Read-only. */
export function appliedIn(path: string): string[] {
  const raw = new Database(path, { readonly: true, fileMustExist: true });
  try {
    if (!raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'schema_migrations'").get()) return [];
    return raw.prepare("SELECT app || ':' || id FROM schema_migrations ORDER BY app, id").pluck().all() as string[];
  } finally {
    raw.close();
  }
}

/**
 * A consistent single-file copy of a database (VACUUM INTO), checked with SQLite's integrity check. Throws when the copy
 * is not sound, after deleting it.
 */
export function copyDatabase(path: string, to: string) {
  mkdirSync(dirname(to), { recursive: true });
  const src = new Database(path, { readonly: true, fileMustExist: true });
  try {
    src.prepare('VACUUM INTO ?').run(to);
  } finally {
    src.close();
  }
  if (integrityOf(to) !== 'ok') {
    rmSync(to, { force: true });
    throw new Error(`The copy of ${path} failed its integrity check; not migrating`);
  }
  return to;
}

/** An online backup of an open connection into a new file (SQLite's backup API; the connection stays in use). */
export async function backupConnection(raw: Database.Database, to: string): Promise<void> {
  await raw.backup(to);
}
