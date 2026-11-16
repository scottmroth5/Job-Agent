// scripts/migrate-sqlite-to-postgres.js (v3 Phase 4): the copy from SQLite into PostgreSQL, on synthetic data only (the
// demo seed plus a second user). The refusals that need no PostgreSQL run everywhere; the copy runs under npm run test:pg.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import pg from 'pg';
import { openJobStore, postgresUrl } from '../db/index.ts';
import { runAsUser } from '../db/scope.ts';
import { addUser } from '../db/users.ts';
import { addNote } from '../agents/notes.ts';
import { seedDemo } from '../scripts/demo-seed.js';
import { copySqliteToPostgres, main } from '../scripts/migrate-sqlite-to-postgres.js';
import { onPostgres } from './fixtures/engine.js';

const pgOnly = onPostgres ? false : 'PostgreSQL only (npm run test:pg)';
const NOW = new Date('2026-11-02T15:00:00Z');

/** Runs fn with the stores on SQLite, whatever this run's engine (the source is always a SQLite file). @param {() => Promise<void>} fn */
async function onSqlite(fn) {
  const url = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    await fn();
  } finally {
    if (url !== undefined) process.env.DATABASE_URL = url;
  }
}

/** A SQLite source: the demo seed (the owner's sample jobs, resumes with files, runs) plus a second user with a job and a note. */
async function source() {
  const dir = mkdtempSync(join(tmpdir(), 'ja-copy-'));
  const from = join(dir, 'job-agent.db');
  await onSqlite(async () => {
    await seedDemo({ dbPath: from, configPath: join(dir, 'config', 'job-search.json'), now: NOW });
    const store = openJobStore(from, { snapshot: false });
    try {
      const uid = await addUser(store.admin, { email: 'second@example.com', name: 'Second Person' });
      await runAsUser(uid, async () => {
        const id = (await store.db.prepare(`INSERT INTO postings (user_id, url_key, company, title, company_title_key, discovered_on, created_at, updated_at)
          VALUES (@uid, 'k-second', 'Second Co', 'VP Engineering', 'k-second', '2026-11-01', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z') RETURNING id`).run()).id;
        await addNote(store.db, Number(id),'a note with an emoji \u{1F600} and a quote \'', { source: 'user' });
      });
    } finally {
      store.close();
    }
  });
  return { dir, from };
}

/** A schema of its own for each test, dropped afterwards. */
function targetSchema() {
  return `copy_${Math.random().toString(16).slice(2, 10)}`;
}

/** @param {string} url @param {string} schema */
async function dropSchema(url, schema) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await client.end();
  }
}

const NOWHERE = 'postgres://nobody@127.0.0.1:1/none';

test('a missing source, or one missing migrations, is refused before anything connects', async () => {
  await assert.rejects(copySqliteToPostgres({ from: join(tmpdir(), 'no-such-job-agent.db'), url: NOWHERE }), /no SQLite database/);
  const dir = mkdtempSync(join(tmpdir(), 'ja-copy-'));
  try {
    const from = join(dir, 'empty.db');
    new Database(from).close();
    await assert.rejects(copySqliteToPostgres({ from, url: NOWHERE }), /missing migrations \(001-/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the script needs a postgres:// target', async () => {
  if (postgresUrl()) return; // under test:pg DATABASE_URL is set
  /** @type {string[]} */
  const lines = [];
  const original = console.error;
  console.error = (/** @type {string} */ line) => lines.push(line);
  try {
    assert.equal(await main([]), 1);
  } finally {
    console.error = original;
  }
  assert.match(lines.join('\n'), /set DATABASE_URL/);
});

test('copies every table, every row matches per table and per user, and it can run again', { skip: pgOnly }, async () => {
  const url = /** @type {string} */ (postgresUrl());
  const { dir, from } = await source();
  const schema = targetSchema();
  try {
    const first = await copySqliteToPostgres({ from, url, schema });
    assert.ok(first.copied && first.copied.postings > 1 && first.copied.resumes > 0 && first.copied.users === 2);
    assert.deepEqual(first.checks.filter((c) => !c.ok), []);
    assert.equal(first.checks.find((c) => c.table === 'postings')?.users, 2);

    // A second run without --replace is refused; with it, the copy starts over and still matches.
    await assert.rejects(copySqliteToPostgres({ from, url, schema }), /already holds data/);
    const again = await copySqliteToPostgres({ from, url, schema, replace: true });
    assert.deepEqual(again.copied, first.copied);
    assert.deepEqual(again.checks.filter((c) => !c.ok), []);

    // The identity sequences were moved past the copied ids, so the app's next job gets a new one.
    const client = new pg.Client({ connectionString: url, options: `-c search_path=${schema}` });
    await client.connect();
    try {
      const { rows } = await client.query("SELECT MAX(id) AS max, nextval(pg_get_serial_sequence('postings', 'id')) AS next FROM postings");
      assert.ok(Number(rows[0].next) > Number(rows[0].max));
    } finally {
      await client.end();
    }
  } finally {
    await dropSchema(url, schema);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a changed row is found, and named by table and user id only', { skip: pgOnly }, async () => {
  const url = /** @type {string} */ (postgresUrl());
  const { dir, from } = await source();
  const schema = targetSchema();
  try {
    await copySqliteToPostgres({ from, url, schema });
    const client = new pg.Client({ connectionString: url, options: `-c search_path=${schema}` });
    await client.connect();
    try {
      await client.query("SELECT set_config('app.uid', 'all', false)");
      await client.query("UPDATE postings SET title = 'Changed' WHERE company = 'Second Co'");
    } finally {
      await client.end();
    }
    const { copied, checks } = await copySqliteToPostgres({ from, url, schema, verifyOnly: true });
    assert.equal(copied, null);
    const bad = checks.filter((c) => !c.ok);
    assert.deepEqual(bad.map((c) => [c.table, c.badUsers]), [['postings', [2]]]);
  } finally {
    await dropSchema(url, schema);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('text PostgreSQL cannot hold is reported by column and count, and nothing is copied', { skip: pgOnly }, async () => {
  const url = /** @type {string} */ (postgresUrl());
  const { dir, from } = await source();
  const schema = targetSchema();
  try {
    await onSqlite(async () => {
      const store = openJobStore(from, { snapshot: false });
      try {
        await store.admin.prepare("UPDATE postings SET fetched_text = 'before' || char(0) || 'after' WHERE company = 'Second Co'").run();
      } finally {
        store.close();
      }
    });
    await assert.rejects(copySqliteToPostgres({ from, url, schema }), /NUL character, found in postings\.fetched_text \(1\)/);
  } finally {
    await dropSchema(url, schema);
    rmSync(dir, { recursive: true, force: true });
  }
});
