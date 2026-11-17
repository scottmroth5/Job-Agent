// Backups on PostgreSQL (v3 Phase 5): pg_dump into the encrypted backup, the restore test in a scratch cluster, the
// pre-migration dump and its restore, reset-database, and the cut-over's load-from-backup. Each test gets a database of
// its own (pg_dump takes a whole database). Needs PostgreSQL (npm run test:pg) and its server programs (PG_BIN: CI and
// the backup image); synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { loadMigrations, openJobStore, postgresUrl } from '../db/index.ts';
import { openPgStore } from '../db/postgres/store.ts';
import { LOGIN_OPTIONS } from '../db/postgres/roles.ts';
import { addUser } from '../db/users.ts';
import { pgToolsSkip } from '../tools/backup/pg.ts';
import { runBackup } from '../tools/backup/run.ts';
import { restoreTest } from '../tools/backup/restore-check.ts';
import { loadFromBackup, preMigrate, resetDatabase, restorePreMigration } from '../tools/backup/pg-deploy.ts';
import { onPostgres } from './fixtures/engine.js';

const skip = !onPostgres ? 'PostgreSQL only (npm run test:pg)' : pgToolsSkip;
const PASSPHRASE = 'a test passphrase, long enough';
const KDF = { logN: 14, r: 8, p: 1 }; // test speed only (the lowest a backup may use); real backups use 2^17
const sqliteIds = () => loadMigrations().map((m) => m.id);

/** A database of its own (C collation, as production), migrated, with three logins for the grants; dropped after. */
async function withDatabase(/** @type {(o: { url: string, logins: { owner: string, app: string, backup: string }, dir: string }) => Promise<void>} */ fn) {
  const base = /** @type {string} */ (postgresUrl());
  const tag = randomBytes(4).toString('hex');
  const name = `t_bk_${tag}`;
  const logins = { owner: `t_bo_${tag}`, app: `t_ba_${tag}`, backup: `t_bb_${tag}` };
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  const url = (() => {
    const u = new URL(base);
    u.pathname = `/${name}`;
    return u.toString();
  })();
  const dir = mkdtempSync(join(tmpdir(), 'ja-bk-test-'));
  try {
    await admin.query(`CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
    for (const l of Object.values(logins)) await admin.query(`CREATE ROLE ${l} ${LOGIN_OPTIONS}`);
    const store = openPgStore(url, { schema: 'public', sqliteIds: sqliteIds() });
    await store.ready;
    store.close();
    await fn({ url, logins, dir });
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    for (const l of Object.values(logins)) await admin.query(`DROP ROLE IF EXISTS ${l}`).catch(() => {});
    await admin.end();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** @param {string} url @param {string} sql @param {unknown[]} [params] */
async function query(url, sql, params = []) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query("SELECT set_config('app.uid', 'all', false)");
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}

test('a PostgreSQL backup: pg_dump checked in a scratch cluster, encrypted, then passes the restore test', { skip }, async () => {
  await withDatabase(async ({ url, dir }) => {
    const store = openPgStore(url, { schema: 'public', sqliteIds: sqliteIds() });
    try {
      await store.ready;
      await addUser(store.admin, { email: 'second@example.com' });
      const r = await runBackup({ pgUrl: url, passphrase: PASSPHRASE, toDir: dir, date: '2026-11-17', kdf: KDF });
      assert.equal(r.name, 'jobs-2026-11-17.jabk');
      const file = readFileSync(join(dir, r.name));
      const check = await restoreTest({ file, passphrase: PASSPHRASE, live: store.admin });
      assert.equal(check.engine, 'postgres');
      assert.deepEqual(check.problems, []);
      assert.ok(check.ok && check.tables > 20);
      assert.equal(check.rowsBackup, check.rowsLive);
    } finally {
      store.close();
    }
  });
});

test('pre-migrate: nothing pending keeps no dump; a pending migration is tried on a copy and its dump kept', { skip }, async () => {
  await withDatabase(async ({ url, dir }) => {
    const lines = /** @type {string[]} */ ([]);
    const none = await preMigrate({ backupUrl: url, dir, log: (l) => lines.push(l) });
    assert.deepEqual([none.code, none.file], [0, null]);
    assert.deepEqual(readdirSync(dir), []);
    // As if this image brought a migration the database has not applied.
    await query(url, "DELETE FROM schema_migrations WHERE app = 'job-agent' AND id = '026-long-url-keys'");
    const one = await preMigrate({ backupUrl: url, dir, log: (l) => lines.push(l) });
    assert.equal(one.code, 10);
    assert.deepEqual(one.pending, ['job-agent:026-long-url-keys']);
    assert.ok(one.file && existsSync(one.file));
    assert.equal((await query(url, "SELECT COUNT(*)::int AS n FROM schema_migrations WHERE id = '026-long-url-keys'"))[0].n, 0, 'the live database is untouched');
    assert.ok(lines.every((l) => !l.includes('postgres://')), 'no address in the output');
  });
});

test('restore-pre-migration puts the database back as the dump had it, grants included', { skip }, async () => {
  await withDatabase(async ({ url, dir, logins }) => {
    await query(url, "DELETE FROM schema_migrations WHERE app = 'job-agent' AND id = '026-long-url-keys'");
    const { file } = await preMigrate({ backupUrl: url, dir, log: () => {} });
    // A failed deploy: a migration ran and the data changed after the dump.
    await query(url, "INSERT INTO users (email, role, status, ai_source, created_at, updated_at) VALUES ('late@example.com', 'user', 'active', 'own', 'x', 'x')");
    await restorePreMigration({ migrateUrl: url, file: /** @type {string} */ (file), logins, log: () => {} });
    assert.equal((await query(url, "SELECT COUNT(*)::int AS n FROM users WHERE email = 'late@example.com'"))[0].n, 0);
    assert.equal((await query(url, "SELECT has_table_privilege($1, 'postings', 'INSERT') AS ok", [logins.app]))[0].ok, true, 'the app may write rows again');
    assert.equal((await query(url, "SELECT has_table_privilege($1, 'postings', 'INSERT') AS ok", [logins.backup]))[0].ok, false, 'the backup login only reads');
  });
});

test('reset-database needs the database typed, keeps a checked dump, and leaves an empty migrated database', { skip }, async () => {
  await withDatabase(async ({ url, dir, logins }) => {
    await query(url, "INSERT INTO users (email, role, status, ai_source, created_at, updated_at) VALUES ('x@example.com', 'user', 'active', 'own', 'x', 'x')");
    await assert.rejects(resetDatabase({ backupUrl: url, migrateUrl: url, dir, confirm: 'wrong', logins, log: () => {} }), /type --confirm/);
    const name = new URL(url).pathname.slice(1);
    assert.equal(await resetDatabase({ backupUrl: url, migrateUrl: url, dir, confirm: name, logins, log: () => {}, waitMs: 2000 }), 0);
    assert.equal(readdirSync(dir).filter((n) => n.endsWith('.dump')).length, 1);
    assert.equal((await query(url, 'SELECT COUNT(*)::int AS n FROM users'))[0].n, 1, 'only the owner seed row');
  });
});

test('load-from-backup: a SQLite backup into the empty database, every table checked, files into the data folder', { skip }, async () => {
  await withDatabase(async ({ url, dir, logins }) => {
    // A SQLite source with one job, backed up the SQLite way.
    const src = join(dir, 'source.db');
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    let file;
    try {
      const lite = openJobStore(src, { snapshot: false });
      await lite.db.prepare(`INSERT INTO postings (user_id, url_key, company, title, company_title_key, discovered_on, created_at, updated_at)
        VALUES (@uid, 'k1', 'Example Co', 'CTO', 'k1', '2026-11-01', 'x', 'x')`).run();
      const settings = join(dir, 'settings.json');
      (await import('node:fs')).writeFileSync(settings, '{"search":{}}');
      const r = await runBackup({ backup: lite.backup, passphrase: PASSPHRASE, toDir: dir, date: '2026-11-17', kdf: KDF, extras: [{ name: 'config/job-search.json', path: settings }] });
      lite.close();
      file = readFileSync(join(dir, r.name));
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
    const dataDir = join(dir, 'data');
    const lines = /** @type {string[]} */ ([]);
    assert.equal(await loadFromBackup({ file, passphrase: PASSPHRASE, migrateUrl: url, dataDir, logins, log: (l) => lines.push(l) }), 0);
    assert.equal((await query(url, "SELECT COUNT(*)::int AS n FROM postings WHERE company = 'Example Co'"))[0].n, 1);
    assert.ok(existsSync(join(dataDir, 'config', 'job-search.json')));
    assert.match(lines.join('\n'), /every table matches/);
    assert.equal((await query(url, "SELECT has_table_privilege($1, 'postings', 'SELECT') AS ok", [logins.app]))[0].ok, true);
  });
});
