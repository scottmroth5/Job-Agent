// A Job-Agent store on PostgreSQL (v3 Phase 4): openJobStore (db/index.ts) opens one when DATABASE_URL is a
// postgres:// address. The store connects and migrates in the background; store.ready settles when that is done, and
// every statement waits for it, so callers stay synchronous (the server and scripts await ready at start to fail fast).
//
// Migrations: 000-baseline.sql once, recorded as every migration id it stands for (agent-core's 001-runs and this app's
// SQLite migrations through BASELINE_THROUGH), then each later file here, named like its SQLite twin. They run one at a
// time per schema (an advisory lock), each in its own transaction.
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { repoPath } from '../../tools/paths.ts';
import { createPgEngine, TYPES } from '../engine/postgres.ts';
import type { Db } from '../engine/types.ts';

/** The last SQLite migration the baseline includes. */
export const BASELINE_THROUGH = '025-note-order';
const DIR = repoPath('db', 'postgres');
const BASELINE = '000-baseline';

export const isPostgresUrl = (url: string | undefined): url is string => /^postgres(ql)?:\/\//i.test(url ?? '');

/** The PostgreSQL files after the baseline, by migration id (file name without .sql). */
export function laterMigrations(dir = DIR): Array<{ id: string; sql: string }> {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && f !== `${BASELINE}.sql`)
    .sort()
    .map((f) => ({ id: f.replace(/\.sql$/, ''), sql: readFileSync(join(dir, f), 'utf8') }));
}

const now = () => new Date().toISOString();
const quoteIdent = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsafe schema name ${name}`);
  return `"${name}"`;
};

/**
 * The schema a store uses. ':memory:' gets a fresh throwaway schema, dropped on close. A file path is the database's
 * public schema (one install, one database), except under npm run test:pg (PG_SCHEMA_PER_PATH=1), where each path is
 * a schema of its own, named from the path alone: tests that open temp files, and the scripts they start, reach the
 * same data from any process.
 */
export function schemaFor(path: string): { schema: string; throwaway: boolean } {
  if (path === ':memory:') return { schema: `t_${randomBytes(8).toString('hex')}`, throwaway: true };
  if (process.env.PG_SCHEMA_PER_PATH !== '1') return { schema: 'public', throwaway: false };
  return { schema: `f_${createHash('sha256').update(resolve(path)).digest('hex').slice(0, 20)}`, throwaway: false };
}

async function migrate(pool: pg.Pool, schema: string, sqliteIds: string[]) {
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
    await client.query("SELECT pg_advisory_lock(hashtext(current_schema() || ':migrate'))");
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        app text NOT NULL, id text NOT NULL, applied_at text NOT NULL, PRIMARY KEY (app, id))`);
      const applied = new Set((await client.query<{ k: string }>("SELECT app || ':' || id AS k FROM schema_migrations")).rows.map((r) => r.k));
      const record = async (app: string, id: string) =>
        await client.query('INSERT INTO schema_migrations (app, id, applied_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [app, id, now()]);
      const apply = async (sql: string, ids: Array<[string, string]>) => {
        await client.query('BEGIN');
        try {
          await client.query(sql);
          for (const [app, id] of ids) await record(app, id);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      };
      if (!applied.has(`postgres:${BASELINE}`)) {
        const covered = sqliteIds.filter((id) => id <= BASELINE_THROUGH);
        await apply(readFileSync(join(DIR, `${BASELINE}.sql`), 'utf8'), [
          ['postgres', BASELINE],
          ['agent-core', '001-runs'],
          ...covered.map((id): [string, string] => ['job-agent', id]),
        ]);
      }
      for (const m of laterMigrations()) {
        if (!applied.has(`job-agent:${m.id}`)) await apply(m.sql, [['job-agent', m.id]]);
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext(current_schema() || ':migrate'))");
    }
  } finally {
    client.release();
  }
}

export interface PgStore {
  db: Db;
  admin: Db;
  ready: Promise<void>;
  close: () => void;
  /** The schema this store uses (tests and the copy script name it). */
  schema: string;
  pool: pg.Pool;
}

/** Opens a store on PostgreSQL. sqliteIds: every SQLite migration id (db/index.ts loadMigrations), for the baseline's record. */
export function openPgStore(
  url: string,
  { schema, throwaway = false, fallbackUid = null, sqliteIds }: { schema: string; throwaway?: boolean; fallbackUid?: number | null; sqliteIds: string[] },
): PgStore {
  quoteIdent(schema);
  const pool = new pg.Pool({
    connectionString: url,
    types: TYPES,
    options: `-c search_path=${schema}`,
    max: 4,
    idleTimeoutMillis: 2000,
    allowExitOnIdle: true,
  });
  // An idle client that loses its connection reports here; the next query gets a new one.
  pool.on('error', (err) => console.warn(`[db] idle PostgreSQL connection closed: ${err.message}`));
  const ready = migrate(pool, schema, sqliteIds);
  ready.catch(() => {}); // callers see the failure on store.ready or their first statement
  let closing: Promise<void> | null = null;
  const shutdown = async () => {
    await ready.catch(() => {});
    if (throwaway) await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`).catch(() => {});
    await pool.end();
  };
  return {
    db: createPgEngine(pool, { fallbackUid, ready }),
    admin: createPgEngine(pool, { fallbackUid: null, ready }),
    ready,
    close: () => {
      closing ??= shutdown().catch((err: Error) => console.warn(`[db] closing PostgreSQL: ${err.message}`));
    },
    schema,
    pool,
  };
}
