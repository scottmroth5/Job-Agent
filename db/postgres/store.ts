// A Job-Agent store on PostgreSQL (v3 Phase 4): openJobStore (db/index.ts) opens one when DATABASE_URL is a
// postgres:// address. The store connects and migrates in the background; store.ready settles when that is done, and
// every statement waits for it, so callers stay synchronous (the server and scripts await ready at start to fail fast).
//
// Migrations: 000-baseline.sql once, recorded as every migration id it stands for (agent-core's 001-runs and this app's
// SQLite migrations through BASELINE_THROUGH), then each later file here, named like its SQLite twin. They run one at a
// time per schema (an advisory lock), each in its own transaction. Then row-level security on every user table
// (ensureRowSecurity) and, for a superuser connection, the ordinary role statements run as (statementRole).
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { repoPath } from '../../tools/paths.ts';
import { createPgEngine, TYPES } from '../engine/postgres.ts';
import type { Db } from '../engine/types.ts';
import { USER_TABLES } from '../user-tables.ts';

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

/** The role a store's connections take when it connected as a superuser, which skips row security. */
export const APP_ROLE = 'job_agent_rls';

/** The name of each user table's row security policy. */
export const POLICY = 'own_rows';

// A row is visible, and may be written, only when its user_id is app.uid's user; 'all' is store.admin. Anything else
// (unset, '', not a number) matches no row, so a statement without a user sees nothing.
const OWN_ROWS = `current_setting('app.uid', true) = 'all'
  OR user_id = CASE WHEN current_setting('app.uid', true) ~ '^[1-9][0-9]{0,17}$' THEN current_setting('app.uid', true)::bigint END`;

/**
 * Row-level security on every user table (db/user-tables.ts), a second guard behind each query's user_id = @uid:
 * ENABLE and FORCE (so the tables' owner obeys it too) and the own_rows policy. Only tables that lack any of it are
 * changed, so a user table added later is covered the next time a store opens.
 */
async function ensureRowSecurity(client: pg.PoolClient) {
  const { rows } = await client.query<{ name: string; ok: boolean }>(
    `SELECT c.relname AS name, (c.relrowsecurity AND c.relforcerowsecurity AND EXISTS (
        SELECT 1 FROM pg_policies p WHERE p.schemaname = current_schema() AND p.tablename = c.relname AND p.policyname = $2)) AS ok
      FROM pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' AND c.relname = ANY($1)`,
    [USER_TABLES, POLICY],
  );
  const missing = USER_TABLES.filter((t) => !rows.some((r) => r.name === t));
  if (missing.length) throw new Error(`user tables missing from the PostgreSQL schema: ${missing.join(', ')}`);
  const todo = rows.filter((r) => !r.ok).map((r) => quoteIdent(r.name));
  if (!todo.length) return;
  await client.query('BEGIN');
  try {
    for (const t of todo) {
      await client.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
      await client.query(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
      await client.query(`DROP POLICY IF EXISTS ${POLICY} ON ${t}`);
      await client.query(`CREATE POLICY ${POLICY} ON ${t} USING (${OWN_ROWS}) WITH CHECK (${OWN_ROWS})`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

/**
 * The role the store's statements run as. A superuser skips row security, so it hands them APP_ROLE (made once per
 * server, with no sign-in and no special rights) with what the app does to this schema's tables: read and write rows,
 * never change the schema. A role that is not a superuser but may bypass row security is refused. Any other role
 * obeys it already (FORCE covers the tables' owner): null.
 */
async function statementRole(client: pg.PoolClient, schema: string): Promise<string | null> {
  const me = (await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  )).rows[0];
  if (!me?.rolsuper) {
    if (me?.rolbypassrls) throw new Error('Connect to PostgreSQL as a role without BYPASSRLS: it would skip the row security that keeps users apart.');
    return null;
  }
  await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN CREATE ROLE ${APP_ROLE} NOLOGIN; END IF;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; -- another process made it first
    END $$`);
  const s = quoteIdent(schema);
  await client.query(`GRANT USAGE ON SCHEMA ${s} TO ${APP_ROLE}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${s} TO ${APP_ROLE}`);
  await client.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${s} TO ${APP_ROLE}`);
  return APP_ROLE;
}

async function migrate(pool: pg.Pool, schema: string, sqliteIds: string[]): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
    await client.query("SELECT pg_advisory_lock(hashtext(current_schema() || ':migrate'))");
    // Migrations change every user's rows; under row security that needs app.uid 'all' (the engine sets each
    // connection's own value before its first statement).
    await client.query("SELECT set_config('app.uid', 'all', false)");
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
      await ensureRowSecurity(client);
      return await statementRole(client, schema);
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
  const newPool = (max: number) => {
    const p = new pg.Pool({ connectionString: url, types: TYPES, options: `-c search_path=${schema}`, max, idleTimeoutMillis: 2000, allowExitOnIdle: true });
    // An idle client that loses its connection reports here; the next query gets a new one.
    p.on('error', (err) => console.warn(`[db] idle PostgreSQL connection closed: ${err.message}`));
    return p;
  };
  // Transactions and store.db's statements; store.admin's statements outside a transaction (see createPgEngine).
  const pool = newPool(4);
  const adminPool = newPool(2);
  let appRole: string | null = null;
  const ready = migrate(pool, schema, sqliteIds).then((r) => {
    appRole = r;
  });
  ready.catch(() => {}); // callers see the failure on store.ready or their first statement
  const role = () => appRole;
  let closing: Promise<void> | null = null;
  const shutdown = async () => {
    await ready.catch(() => {});
    // The connection's own role again (a connection may have taken APP_ROLE, which cannot drop the schema).
    if (throwaway) await pool.query(`RESET ROLE; DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`).catch(() => {});
    await Promise.all([pool.end(), adminPool.end()]);
  };
  return {
    db: createPgEngine(pool, { fallbackUid, ready, role }),
    admin: createPgEngine(pool, { fallbackUid: null, ready, role, allUsers: true, statements: adminPool }),
    ready,
    close: () => {
      closing ??= shutdown().catch((err: Error) => console.warn(`[db] closing PostgreSQL: ${err.message}`));
    },
    schema,
    pool,
  };
}
