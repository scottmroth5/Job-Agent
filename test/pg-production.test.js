// Production on PostgreSQL (v3 Phase 5): certificate checking, deploy mode (the app's login never migrates and refuses
// to start while anything is pending), REQUIRE_POSTGRES, and scripts/migrate.js. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openJobStore, postgresUrl } from '../db/index.ts';
import { checkTls, openPgStore, schemaFor } from '../db/postgres/store.ts';
import { loadMigrations } from '../db/index.ts';
import { main as migrateMain } from '../scripts/migrate.js';
import { onPostgres } from './fixtures/engine.js';

const pgOnly = onPostgres ? false : 'PostgreSQL only (npm run test:pg)';
const prod = { NODE_ENV: 'production' };
const RDS = 'postgres://ja_app:secret@db.example.com:5432/job_agent';

test('in production a remote PostgreSQL address must check the server certificate', () => {
  assert.throws(() => checkTls(RDS, prod), /verify-full/);
  assert.throws(() => checkTls(`${RDS}?sslmode=require`, prod), /verify-full/);
  assert.throws(() => checkTls(`${RDS}?sslmode=verify-full`, prod), /sslrootcert/);
  assert.doesNotThrow(() => checkTls(`${RDS}?sslmode=verify-full&sslrootcert=/app/certs/rds-global-bundle.pem`, prod));
  for (const local of ['postgres://u:p@localhost/x', 'postgres://u:p@127.0.0.1:5433/x', 'postgres://u:p@[::1]/x']) {
    assert.doesNotThrow(() => checkTls(local, prod), 'this machine needs no certificate');
  }
  assert.doesNotThrow(() => checkTls('postgres://demo@demo-db:5432/demo', { ...prod, DATABASE_TLS: 'off' }), 'a private Docker network, said so');
  assert.doesNotThrow(() => checkTls('postgres://demo@demo-db:5432/demo', { ...prod, AUTH_MODE: 'demo' }), 'the demo, even with an older compose.yml');
  assert.throws(() => checkTls(RDS, { ...prod, AUTH_MODE: 'google' }), /verify-full/, 'the signed-in app is never waived');
  assert.doesNotThrow(() => checkTls(RDS, {}), 'outside production nothing is required');
  try {
    checkTls(RDS, prod);
  } catch (err) {
    assert.ok(!String(/** @type {Error} */ (err).message).includes('secret'), 'the message never repeats the address');
  }
});

test('REQUIRE_POSTGRES refuses to open a SQLite file', { skip: onPostgres ? 'needs no DATABASE_URL' : false }, () => {
  process.env.REQUIRE_POSTGRES = '1';
  try {
    assert.throws(() => openJobStore(':memory:'), /REQUIRE_POSTGRES/);
  } finally {
    delete process.env.REQUIRE_POSTGRES;
  }
});

test('deploy mode: pending migrations stop the start, then a superuser is refused', { skip: pgOnly }, async () => {
  const url = /** @type {string} */ (postgresUrl());
  const sqliteIds = loadMigrations().map((m) => m.id);
  const fresh = openPgStore(url, { schema: `t_${randomBytes(8).toString('hex')}`, sqliteIds, migrate: false });
  await assert.rejects(fresh.ready, /migrations are pending .*000-baseline/);
  fresh.close();
  // A migrated schema passes the migration and row security checks; the test login is a superuser, which the app's
  // own login must never be.
  const { schema } = schemaFor(':memory:');
  const migrated = openPgStore(url, { schema, throwaway: true, sqliteIds });
  await migrated.ready;
  assert.ok(migrated.applied.includes('000-baseline'));
  const deployed = openPgStore(url, { schema, sqliteIds, migrate: false });
  await assert.rejects(deployed.ready, /must not be a superuser/);
  deployed.close();
  migrated.close();
});

test('scripts/migrate.js applies what is pending, then finds nothing', { skip: pgOnly }, async () => {
  const lines = /** @type {string[]} */ ([]);
  const original = console.log;
  console.log = (/** @type {string} */ line) => lines.push(line);
  try {
    assert.equal(await migrateMain({ MIGRATE_DATABASE_URL: /** @type {string} */ (postgresUrl()) }), 0);
    assert.equal(await migrateMain({ DATABASE_URL: /** @type {string} */ (postgresUrl()) }), 0);
  } finally {
    console.log = original;
  }
  assert.equal(lines.at(-1), '[migrate] nothing pending');
  assert.equal(await migrateMain({}), 1, 'no address');
});

test('production shape: migrations as a non-superuser owner, the app as a login that owns nothing', { skip: pgOnly }, async () => {
  const { default: pg } = await import('pg');
  const { grantStatements, LOGIN_OPTIONS } = await import('../db/postgres/roles.ts');
  const { runAsUser } = await import('../db/scope.ts');
  const { addUser } = await import('../db/users.ts');
  const base = /** @type {string} */ (postgresUrl());
  const tag = randomBytes(4).toString('hex');
  const logins = { owner: `t_owner_${tag}`, app: `t_app_${tag}`, backup: `t_backup_${tag}` };
  const password = randomBytes(12).toString('hex');
  const as = (/** @type {string} */ user) => {
    const u = new URL(base);
    u.username = user;
    u.password = password;
    return u.toString();
  };
  const schema = `t_${randomBytes(8).toString('hex')}`;
  const sqliteIds = loadMigrations().map((m) => m.id);
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  try {
    for (const login of Object.values(logins)) await admin.query(`CREATE ROLE ${login} ${LOGIN_OPTIONS} PASSWORD '${password}'`);
    await admin.query(`CREATE SCHEMA ${schema} AUTHORIZATION ${logins.owner}`);

    const owner = openPgStore(as(logins.owner), { schema, sqliteIds });
    await owner.ready;
    const grants = new pg.Client({ connectionString: as(logins.owner) });
    await grants.connect();
    for (const sql of grantStatements(schema, logins)) await grants.query(sql);
    await grants.end();
    owner.close();

    const app = openPgStore(as(logins.app), { schema, sqliteIds, migrate: false, fallbackUid: null });
    await app.ready;
    const other = await addUser(app.admin, { email: 'second@example.com' });
    const add = async (/** @type {number} */ uid) => await app.admin.prepare(`INSERT INTO postings (user_id, url_key, company, title, company_title_key, discovered_on, created_at, updated_at)
      VALUES (?, ?, 'Example Co', 'CTO', ?, '2026-11-01', 'x', 'x') RETURNING id`).run(uid, `k${uid}`, `k${uid}`);
    assert.ok(Number((await add(1)).id) > 0, 'new ids come from the sequences the app may use');
    await add(other);
    assert.deepEqual(await runAsUser(other, () => app.db.prepare('SELECT user_id FROM postings').pluck().all()), [other], 'row security holds for a login that owns nothing');
    await assert.rejects(app.admin.prepare('CREATE TABLE nope (a int)').run(), /permission denied/, 'the app cannot change the schema');
    app.close();
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    for (const login of Object.values(logins)) {
      await admin.query(`DROP OWNED BY ${login}`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS ${login}`);
    }
    await admin.end();
  }
});
