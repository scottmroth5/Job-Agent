// Row-level security (v3 Phase 4, PR 3): on PostgreSQL every user table shows a statement only the rows of the user it
// runs as, a second guard behind each query's user_id = @uid. These tests leave the user_id filter out on purpose and
// check that the database still keeps users apart. The list check runs everywhere; the rest needs PostgreSQL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openJobStore } from '../db/index.ts';
import { runAsUser } from '../db/scope.ts';
import { addUser } from '../db/users.ts';
import { USER_TABLES } from '../db/user-tables.ts';
import { POLICY } from '../db/postgres/store.ts';
import { columnsOf, onPostgres, tablesOf } from './fixtures/engine.js';
/** @import { Db } from '../tools/types.ts' */

const pgOnly = onPostgres ? false : 'PostgreSQL only (npm run test:pg)';

// Tables with a user_id that are not user tables, and why.
const NOT_USER_TABLES = {
  runs: "app-wide: the budget caps add up spend across users, and the owner's key keeps a deleted user's costs",
};

test('every table with a user_id is a user table, or is listed here with its reason', async () => {
  const store = openJobStore(':memory:');
  try {
    const withUser = [];
    for (const t of await tablesOf(store.admin)) if ((await columnsOf(store.admin, t)).includes('user_id')) withUser.push(t);
    assert.deepEqual(withUser.filter((t) => !(t in NOT_USER_TABLES)).sort(), [...USER_TABLES].sort());
  } finally {
    store.close();
  }
});

/** @param {Db} db @param {number} uid @param {string} tag */
const addJob = async (db, uid, tag) =>
  await db.prepare(`INSERT INTO postings (user_id, url_key, company, title, company_title_key, discovered_on, created_at, updated_at)
    VALUES (?, ?, ?, 'CTO', ?, '2026-10-01', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`).run(uid, `k-${tag}`, `${tag} Co`, `k-${tag}`);

/** Two users with one job each, written through store.admin. */
async function twoUsers() {
  const store = openJobStore(':memory:', { fallbackUid: null });
  await store.ready;
  const other = await addUser(store.admin, { email: 'second@example.com' });
  await addJob(store.admin, 1, 'owner');
  await addJob(store.admin, other, 'second');
  return { store, other };
}

/** @param {Db} db */
const companies = async (db) => /** @type {string[]} */ (await db.prepare('SELECT company FROM postings ORDER BY company').pluck().all());

test('every user table has row security, forced for its owner too, with the own_rows policy', { skip: pgOnly }, async () => {
  const store = openJobStore(':memory:');
  try {
    const rows = /** @type {Array<{ name: string, ok: number }>} */ (await store.admin.prepare(
      `SELECT c.relname AS name, (c.relrowsecurity AND c.relforcerowsecurity AND EXISTS (SELECT 1 FROM pg_policies p
          WHERE p.schemaname = current_schema() AND p.tablename = c.relname AND p.policyname = ?)) AS ok
        FROM pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' ORDER BY c.relname`,
    ).all(POLICY));
    assert.deepEqual(rows.filter((r) => r.ok).map((r) => r.name), [...USER_TABLES].sort());
  } finally {
    store.close();
  }
});

test('statements run as a role that obeys row security', { skip: pgOnly }, async () => {
  const store = openJobStore(':memory:');
  try {
    for (const db of [store.db, store.admin]) {
      assert.equal(await db.prepare('SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user').pluck().get(), 0);
    }
  } finally {
    store.close();
  }
});

test('a query that leaves out user_id still sees only its own user; store.admin sees everyone; no user sees nothing', { skip: pgOnly }, async () => {
  const { store, other } = await twoUsers();
  try {
    assert.deepEqual(await runAsUser(other, () => companies(store.db)), ['second Co']);
    assert.deepEqual(await runAsUser(1, () => companies(store.db)), ['owner Co']);
    assert.deepEqual(await runAsUser(other, () => companies(store.admin)), ['owner Co', 'second Co']);
    assert.deepEqual(await companies(store.db), [], 'store.db outside a request or job, with no fallback user');
    // Updates and deletes without the filter reach only the user's own rows.
    const changed = await runAsUser(other, () => store.db.prepare("UPDATE postings SET title = 'changed'").run());
    assert.equal(changed.changes, 1);
    assert.equal(await runAsUser(other, () => store.db.prepare('DELETE FROM postings WHERE user_id = 1').run()).then((r) => r.changes), 0);
    assert.deepEqual(await store.admin.prepare("SELECT company FROM postings WHERE title = 'changed'").pluck().all(), ['second Co']);
  } finally {
    store.close();
  }
});

test("a user cannot write a row as someone else, nor copy another user's job", { skip: pgOnly }, async () => {
  const { store, other } = await twoUsers();
  try {
    await assert.rejects(runAsUser(other, () => addJob(store.db, 1, 'forged')), /row-level security/);
    const ownerJob = await store.admin.prepare("SELECT id FROM postings WHERE company = 'owner Co'").pluck().get();
    // The app's pattern, INSERT ... SELECT FROM postings WHERE id = ?, without its AND user_id = @uid: nothing to copy.
    const r = await runAsUser(other, () => store.db.prepare(`INSERT INTO posting_notes (user_id, id, posting_id, body, source, created_at, updated_at, seq)
      SELECT user_id, 'n1', id, 'x', 'user', 'x', 'x', 1 FROM postings WHERE id = ?`).run(ownerJob));
    assert.equal(r.changes, 0);
  } finally {
    store.close();
  }
});

test('inside one transaction each statement runs as its own handle, and a savepoint rollback leaves it right', { skip: pgOnly }, async () => {
  const { store, other } = await twoUsers();
  try {
    await runAsUser(other, () => store.db.tx(async () => {
      assert.deepEqual(await companies(store.db), ['second Co']);
      assert.deepEqual(await companies(store.admin), ['owner Co', 'second Co']);
      await assert.rejects(store.db.tx(async () => {
        assert.deepEqual(await companies(store.admin), ['owner Co', 'second Co']);
        throw new Error('roll back');
      }), /roll back/);
      assert.deepEqual(await companies(store.db), ['second Co'], 'after the savepoint rolled back');
      // Statements running at once on the transaction's one connection each keep their own setting.
      const views = await Promise.all([companies(store.admin), companies(store.db), companies(store.admin), companies(store.db)]);
      assert.deepEqual(views, [['owner Co', 'second Co'], ['second Co'], ['owner Co', 'second Co'], ['second Co']]);
    }));
    // The connection the transaction used goes back to the pool set for no one else's rows.
    assert.deepEqual(await runAsUser(1, () => companies(store.db)), ['owner Co']);
    assert.deepEqual(await companies(store.db), []);
  } finally {
    store.close();
  }
});
