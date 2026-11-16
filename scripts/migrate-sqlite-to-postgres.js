// Copies a Job-Agent SQLite database into PostgreSQL and proves the copy (v3 Phase 4). Repeatable: each run empties
// the target and copies everything again, in one transaction, so a failed run leaves the target as it was.
//
//   DATABASE_URL=postgres://... node --env-file=.env scripts/migrate-sqlite-to-postgres.js [--from <file>] [--schema <name>] [--replace]
//   ... --verify       compare only: row counts and content checksums, per table and per user
//
// - The source opens read-only and must have every migration this version knows (open it with the app first). Stop the
//   server and the scheduled tasks while it runs: the check afterwards reads the source again and reports any change.
// - The target is DATABASE_URL's database, in the public schema unless --schema. It is migrated first (the baseline and
//   later files). One that already holds data (any job, run, or user but the owner's seed row) needs --replace.
// - The copy, in one transaction that takes the app's transaction lock: TRUNCATE every table but schema_migrations,
//   insert each table in foreign key order, then set each identity sequence past its highest id.
// - The check hashes every row the same way on both sides (values in column order, blobs as hex) and compares the
//   hashes per table and, for tables with a user_id, per user. Order does not matter (the hashes are sorted).
// - Output is table names, user ids, and counts. Never a value: a PostgreSQL error is reported by its code, table, and
//   column, since its message can quote the value. The connection address is never printed.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { appliedIn, openReadOnly } from '../db/engine/files.ts';
import { loadMigrations, postgresUrl } from '../db/index.ts';
import { openPgStore } from '../db/postgres/store.ts';
import { dataPath } from '../tools/paths.ts';
/** @import { Db } from '../tools/types.ts' */
/** @import pg from 'pg' */

/** Tables a copy never touches: each side's own record of its migrations. */
const SKIP = new Set(['schema_migrations']);
/** Order the foreign keys do not show: the postings triggers check status, stage, and track against lookup_values. */
const EXTRA_DEPS = { postings: ['lookup_values'] };
/** Parameters per INSERT, under PostgreSQL's 65535. */
const MAX_PARAMS = 30000;

/** @typedef {{ table: string, rows: number, users: number, ok: boolean, badUsers: number[] }} TableCheck */

/** A failure the script reports in its own words (no values). */
class CopyError extends Error {}

const ident = (/** @type {string} */ name) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new CopyError(`unexpected table or column name ${JSON.stringify(name)}`);
  return `"${name}"`;
};

/** A PostgreSQL error without its message (which can quote a value). @param {unknown} err @param {string} table */
function safeError(err, table) {
  const e = /** @type {{ code?: string, column?: string, constraint?: string }} */ (err);
  if (!e?.code) return err;
  const where = [e.column && `column ${e.column}`, e.constraint && `constraint ${e.constraint}`].filter(Boolean).join(', ');
  return new CopyError(`PostgreSQL refused a row of ${table} (code ${e.code}${where ? `, ${where}` : ''})`);
}

/** The source's tables and their columns (sorted, so both sides hash columns in the same order). @param {Db} db */
async function sourceTables(db) {
  const names = /** @type {string[]} */ (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").pluck().all());
  /** @type {Map<string, string[]>} */
  const tables = new Map();
  for (const t of names.filter((n) => !SKIP.has(n))) {
    tables.set(t, /** @type {string[]} */ (await db.prepare('SELECT name FROM pragma_table_info(?) ORDER BY name').pluck().all(t)).sort());
  }
  return tables;
}

/** @param {pg.PoolClient} client */
async function targetTables(client) {
  const { rows } = await client.query(`SELECT table_name AS t, column_name AS c FROM information_schema.columns
    WHERE table_schema = current_schema() ORDER BY table_name, column_name`);
  /** @type {Map<string, string[]>} */
  const tables = new Map();
  for (const { t, c } of rows) if (!SKIP.has(t)) tables.set(t, [...(tables.get(t) ?? []), c]);
  for (const cols of tables.values()) cols.sort(); // JavaScript's order, as for the source (collations differ)
  return tables;
}

/** Tables in an order where each comes after every table it refers to. @param {pg.PoolClient} client @param {string[]} tables */
async function insertOrder(client, tables) {
  const { rows } = await client.query(`SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
    FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = current_schema()::regnamespace`);
  /** @type {Map<string, Set<string>>} */
  const deps = new Map(tables.map((t) => [t, new Set()]));
  const bare = (/** @type {string} */ name) => name.replace(/^.*\./, '').replace(/"/g, '');
  for (const { child, parent } of rows) if (bare(child) !== bare(parent)) deps.get(bare(child))?.add(bare(parent));
  for (const [t, extra] of Object.entries(EXTRA_DEPS)) for (const p of extra) deps.get(t)?.add(p);
  /** @type {string[]} */
  const order = [];
  const left = new Set(tables);
  while (left.size) {
    const ready = [...left].filter((t) => [...(deps.get(t) ?? [])].every((p) => !left.has(p))).sort();
    if (!ready.length) throw new CopyError(`foreign keys loop among ${[...left].join(', ')}`);
    for (const t of ready) {
      order.push(t);
      left.delete(t);
    }
  }
  return order;
}

/** A row's hash: its values in column order, blobs as hex, so both engines' reads compare. @param {Record<string, unknown>} row @param {string[]} cols */
function rowHash(row, cols) {
  const values = cols.map((c) => {
    const v = row[c];
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { hex: Buffer.from(v).toString('hex') };
    return v === undefined ? null : v;
  });
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

/** Per table, and per user where the table has user_id: the sorted row hashes, hashed. @param {Array<Record<string, unknown>>} rows @param {string[]} cols */
function digest(rows, cols) {
  /** @type {Map<string, string[]>} */
  const byUser = new Map();
  const all = [];
  for (const row of rows) {
    const h = rowHash(row, cols);
    all.push(h);
    if (cols.includes('user_id')) {
      const k = String(row.user_id);
      byUser.set(k, [...(byUser.get(k) ?? []), h]);
    }
  }
  const sum = (/** @type {string[]} */ hs) => createHash('sha256').update(hs.sort().join('')).digest('hex');
  return { rows: rows.length, table: sum(all), users: new Map([...byUser].map(([u, hs]) => [u, { rows: hs.length, sum: sum(hs) }])) };
}

/** Text a PostgreSQL text column cannot hold (a NUL character): [table.column, count] for each. @param {Db} db @param {Map<string, string[]>} tables */
async function nulCounts(db, tables) {
  /** @type {Array<[string, number]>} */
  const found = [];
  for (const [t, cols] of tables) {
    for (const c of cols) {
      const n = /** @type {number} */ (await db.prepare(`SELECT COUNT(*) FROM ${ident(t)} WHERE typeof(${ident(c)}) = 'text' AND instr(${ident(c)}, char(0)) > 0`).pluck().get());
      if (n) found.push([`${t}.${c}`, n]);
    }
  }
  return found;
}

/** @param {pg.PoolClient} client */
async function targetHasData(client) {
  const { rows } = await client.query(`SELECT
      (SELECT COUNT(*) FROM postings) + (SELECT COUNT(*) FROM runs) + (SELECT COUNT(*) FROM users WHERE id <> 1)
      + (SELECT COUNT(*) FROM users WHERE id = 1 AND email IS NOT NULL) AS n`);
  return Number(rows[0].n) > 0;
}

/** Copies every table, inside the caller's transaction. @param {Db} source @param {pg.PoolClient} client @param {string[]} order @param {Map<string, string[]>} tables */
async function copyRows(source, client, order, tables) {
  await client.query(`TRUNCATE ${order.map(ident).join(', ')} RESTART IDENTITY CASCADE`);
  /** @type {Record<string, number>} */
  const copied = {};
  for (const t of order) {
    const cols = /** @type {string[]} */ (tables.get(t));
    const rows = /** @type {Array<Record<string, unknown>>} */ (await source.prepare(`SELECT * FROM ${ident(t)}`).all());
    const per = Math.max(1, Math.floor(MAX_PARAMS / cols.length));
    for (let i = 0; i < rows.length; i += per) {
      const batch = rows.slice(i, i + per);
      const values = batch.flatMap((r) => cols.map((c) => r[c] ?? null));
      const tuples = batch.map((_, r) => `(${cols.map((__, c) => `$${r * cols.length + c + 1}`).join(', ')})`).join(', ');
      try {
        await client.query(`INSERT INTO ${ident(t)} (${cols.map(ident).join(', ')}) VALUES ${tuples}`, values);
      } catch (err) {
        throw safeError(err, t);
      }
    }
    copied[t] = rows.length;
  }
  // Each identity sequence past its table's highest id, so the app's next insert gets a new one.
  const { rows: ids } = await client.query(`SELECT table_name AS t, column_name AS c FROM information_schema.columns
    WHERE table_schema = current_schema() AND is_identity = 'YES'`);
  for (const { t, c } of ids) {
    await client.query(`SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT MAX(${ident(c)}) FROM ${ident(t)}), 0) + 1, false)`, [t, c]);
  }
  return copied;
}

/** Compares both sides. @param {Db} source @param {pg.PoolClient} client @param {Map<string, string[]>} tables @returns {Promise<TableCheck[]>} */
async function compare(source, client, tables) {
  /** @type {TableCheck[]} */
  const checks = [];
  for (const [t, cols] of [...tables].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const a = digest(/** @type {Array<Record<string, unknown>>} */ (await source.prepare(`SELECT * FROM ${ident(t)}`).all()), cols);
    const b = digest((await client.query(`SELECT * FROM ${ident(t)}`)).rows, cols);
    const users = new Set([...a.users.keys(), ...b.users.keys()]);
    const badUsers = [...users].filter((u) => a.users.get(u)?.sum !== b.users.get(u)?.sum).map(Number).sort((x, y) => x - y);
    checks.push({ table: t, rows: a.rows, users: users.size, ok: a.rows === b.rows && a.table === b.table && !badUsers.length, badUsers });
  }
  return checks;
}

/**
 * The copy, or with verifyOnly the check alone. Returns what was copied and each table's check; throws CopyError for a
 * refusal (source not migrated, target not empty without replace, text PostgreSQL cannot hold).
 * @param {{ from: string, url: string, schema?: string, replace?: boolean, verifyOnly?: boolean }} options
 */
export async function copySqliteToPostgres({ from, url, schema = 'public', replace = false, verifyOnly = false }) {
  if (!existsSync(from)) throw new CopyError(`no SQLite database at ${from}`);
  const migrations = loadMigrations();
  const applied = new Set(appliedIn(from));
  const missing = migrations.filter((m) => !applied.has(`job-agent:${m.id}`)).map((m) => m.id);
  if (missing.length) throw new CopyError(`the source is missing migrations (${missing.join(', ')}); open it with this version of the app first`);

  const src = openReadOnly(from);
  const target = openPgStore(url, { schema, sqliteIds: migrations.map((m) => m.id) });
  try {
    await target.ready;
    const tables = await sourceTables(src.db);
    const client = await target.pool.connect();
    try {
      // The connection's own role (a pool connection may have taken the app's), and every user's rows.
      await client.query("RESET ROLE; SELECT set_config('app.uid', 'all', false)");
      const theirs = await targetTables(client);
      const diff = [...new Set([...tables.keys(), ...theirs.keys()])].filter((t) => String(tables.get(t)) !== String(theirs.get(t)));
      if (diff.length) throw new CopyError(`the two schemas differ in ${diff.sort().join(', ')}`);
      /** @type {Record<string, number> | null} */
      let copied = null;
      if (!verifyOnly) {
        const nul = await nulCounts(src.db, tables);
        if (nul.length) throw new CopyError(`PostgreSQL text cannot hold a NUL character, found in ${nul.map(([c, n]) => `${c} (${n})`).join(', ')}`);
        const order = await insertOrder(client, [...tables.keys()]);
        await client.query('BEGIN');
        try {
          await client.query('SELECT pg_advisory_xact_lock(hashtext(current_schema()))');
          if (!replace && (await targetHasData(client))) throw new CopyError('the target already holds data; pass --replace to empty it and copy again');
          copied = await copyRows(src.db, client, order, tables);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        }
      }
      return { copied, checks: await compare(src.db, client, tables) };
    } finally {
      client.release();
    }
  } finally {
    src.close();
    target.close();
  }
}

/** @param {string[]} args */
export async function main(args = process.argv.slice(2)) {
  const opt = (/** @type {string} */ name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const url = postgresUrl();
  if (!url) {
    console.error('migrate-sqlite-to-postgres: set DATABASE_URL to the target postgres:// address.');
    return 1;
  }
  try {
    const { copied, checks } = await copySqliteToPostgres({
      from: opt('from') ?? dataPath('job-agent.db'),
      url,
      schema: opt('schema') ?? 'public',
      replace: args.includes('--replace'),
      verifyOnly: args.includes('--verify'),
    });
    if (copied) console.log(`[copy] ${Object.keys(copied).length} tables, ${Object.values(copied).reduce((a, b) => a + b, 0)} rows`);
    for (const c of checks) {
      const users = c.users ? `, ${c.users} users` : '';
      console.log(`[check] ${c.table}: ${c.rows} rows${users}, ${c.ok ? 'match' : `DIFFER${c.badUsers.length ? ` (user ids ${c.badUsers.join(', ')})` : ''}`}`);
    }
    const bad = checks.filter((c) => !c.ok).length;
    console.log(bad ? `[check] ${bad} tables differ` : `[check] all ${checks.length} tables match`);
    return bad ? 2 : 0;
  } catch (err) {
    // Another error's message can quote a value or the address: its kind and code only.
    const e = /** @type {Error & { code?: string }} */ (err);
    console.error(`migrate-sqlite-to-postgres: ${err instanceof CopyError ? e.message : `failed (${e.name}${e.code ? ` ${e.code}` : ''})`}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main();
