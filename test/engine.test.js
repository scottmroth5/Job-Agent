// The async data layer (db/engine, v3 Phase 3): statements, user scoping, transactions, savepoints, the mutex that keeps
// other statements out of an open transaction, and the guard that keeps network waits out of transactions.
// Synthetic tables in memory only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createSqliteEngine, insideTransaction } from '../db/engine/sqlite.ts';
import { runAsUser } from '../db/scope.ts';
import { openJobStore } from '../db/index.ts';
import { createJobClaude } from '../tools/claude.ts';
import { createHttp } from '../tools/http.ts';
import { fakeClaude } from './fixtures/fakes.js';
import { asEngine } from '../db/engine/index.ts';
import { addUser, decide, getUser, requestAccess } from '../db/users.ts';
import { createJobTracer } from '../tools/trace.ts';
import { oneStartAtATime } from '../tools/runs.ts';

function setup(/** @type {import('../db/engine/sqlite.ts').SqliteEngineOptions} */ options = {}) {
  const raw = new Database(':memory:');
  raw.exec(`CREATE TABLE things (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT);
            CREATE TABLE counter (n INTEGER); INSERT INTO counter VALUES (0);`);
  return { raw, db: createSqliteEngine(raw, options) };
}

/** A promise and the function that settles it, for holding a transaction open (strictTx off). */
function deferred() {
  /** @type {() => void} */
  let resolve = () => {};
  const promise = new Promise((r) => {
    resolve = () => r(undefined);
  });
  return { promise, resolve };
}

test('get, all, run, and pluck answer like better-sqlite3, as promises', async () => {
  const { db } = setup({ fallbackUid: 1 });
  const first = await db.prepare('INSERT INTO things (user_id, name) VALUES (@uid, ?)').run('a');
  assert.deepEqual(first, { changes: 1, id: 1 });
  await db.prepare('INSERT INTO things (user_id, name) VALUES (@uid, @name)').run({ name: 'b' });
  assert.deepEqual(await db.prepare('SELECT name FROM things WHERE user_id = @uid ORDER BY id').all(), [{ name: 'a' }, { name: 'b' }]);
  assert.equal(await db.prepare('SELECT name FROM things WHERE id = ?').pluck().get(2), 'b');
  assert.deepEqual(await db.prepare('SELECT name FROM things ORDER BY id').pluck().all(), ['a', 'b']);
  assert.equal(await db.prepare('SELECT name FROM things WHERE id = 99').get(), undefined);
  // pluck() gives a plucked statement; the one it came from still returns rows.
  const stmt = db.prepare('SELECT name FROM things WHERE id = 1');
  assert.equal(await stmt.pluck().get(), 'a');
  assert.deepEqual(await stmt.get(), { name: 'a' });
  const updated = await db.prepare('UPDATE things SET name = ? WHERE user_id = @uid').run('c');
  assert.equal(updated.changes, 2);
});

test('@uid binds the current user, or fallbackUid; with neither, the query rejects', async () => {
  const { db, raw } = setup();
  raw.exec("INSERT INTO things (user_id, name) VALUES (1, 'mine'), (2, 'theirs')");
  const mine = async () => await db.prepare('SELECT name FROM things WHERE user_id = @uid').pluck().all();
  assert.deepEqual(await runAsUser(2, mine), ['theirs']);
  await assert.rejects(mine(), /needs a user, but it is running outside a request or job/);
  // A query that does not name @uid runs anywhere.
  assert.equal(await db.prepare('SELECT COUNT(*) FROM things').pluck().get(), 2);
  const owner = createSqliteEngine(raw, { fallbackUid: 1 });
  assert.deepEqual(await owner.prepare('SELECT name FROM things WHERE user_id = @uid').pluck().all(), ['mine']);
});

test('a transaction commits when its body resolves and rolls back when it rejects', async () => {
  const { db, raw } = setup({ fallbackUid: 1 });
  const id = await db.tx(async () => {
    const r = await db.prepare("INSERT INTO things (user_id, name) VALUES (@uid, 'kept')").run();
    return r.id;
  });
  assert.equal(id, 1);
  await assert.rejects(
    db.tx(async () => {
      await db.prepare("INSERT INTO things (user_id, name) VALUES (@uid, 'gone')").run();
      throw new Error('stop');
    }),
    /stop/,
  );
  assert.deepEqual(raw.prepare('SELECT name FROM things').pluck().all(), ['kept']);
  assert.equal(raw.inTransaction, false);
});

test('a nested transaction is a savepoint: its rollback keeps the outer work', async () => {
  const { db, raw } = setup({ fallbackUid: 1 });
  await db.tx(async () => {
    await db.prepare("INSERT INTO things (user_id, name) VALUES (@uid, 'outer')").run();
    await assert.rejects(
      db.tx(async () => {
        await db.prepare("INSERT INTO things (user_id, name) VALUES (@uid, 'inner')").run();
        throw new Error('inner fails');
      }),
    );
    await db.tx(async () => {
      await db.prepare("INSERT INTO things (user_id, name) VALUES (@uid, 'inner kept')").run();
    });
  });
  assert.deepEqual(raw.prepare('SELECT name FROM things ORDER BY id').pluck().all(), ['outer', 'inner kept']);
});

test('the mutex: concurrent read-then-write transactions never interleave', async () => {
  const { db } = setup();
  const order = /** @type {string[]} */ ([]);
  const bump = (/** @type {string} */ name) =>
    db.tx(async () => {
      const n = /** @type {number} */ (await db.prepare('SELECT n FROM counter').pluck().get());
      order.push(`${name} read ${n}`);
      await Promise.resolve(); // yields to everything else waiting on the microtask queue
      await db.prepare('UPDATE counter SET n = ?').run(n + 1);
      order.push(`${name} wrote ${n + 1}`);
    });
  await Promise.all([bump('a'), bump('b'), bump('c')]);
  assert.equal(await db.prepare('SELECT n FROM counter').pluck().get(), 3, 'no update was lost');
  assert.deepEqual(order, ['a read 0', 'a wrote 1', 'b read 1', 'b wrote 2', 'c read 2', 'c wrote 3']);
});

test('a statement from outside waits while a transaction is open, and is not rolled back with it', async () => {
  const { db, raw } = setup({ fallbackUid: 1, strictTx: false });
  const hold = deferred();
  const inside = db.tx(async () => {
    await db.prepare("INSERT INTO things (user_id, name) VALUES (@uid, 'in tx')").run();
    await hold.promise; // held open by the test
    throw new Error('roll back');
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(raw.inTransaction, true);
  // Another request's write and read, started while the transaction is open.
  let outsideDone = false;
  const outside = (async () => {
    await db.prepare("INSERT INTO things (user_id, name) VALUES (@uid, 'outside')").run();
    outsideDone = true;
    return await db.prepare('SELECT name FROM things ORDER BY id').pluck().all();
  })();
  await new Promise((r) => setImmediate(r));
  assert.equal(outsideDone, false, 'the outside write waits for the transaction');
  hold.resolve();
  await assert.rejects(inside, /roll back/);
  assert.deepEqual(await outside, ['outside'], 'it ran after the rollback and survived it');
});

test('a transaction that waits on something besides the database fails under test and rolls back', async () => {
  const { db, raw } = setup({ fallbackUid: 1, strictTx: true });
  await assert.rejects(
    db.tx(async () => {
      await db.prepare("INSERT INTO things (user_id, name) VALUES (@uid, 'x')").run();
      await new Promise((r) => setTimeout(r, 1)); // stands in for a network call
    }),
    /waited on something besides the database/,
  );
  assert.equal(raw.prepare('SELECT COUNT(*) FROM things').pluck().get(), 0);
  // Waiting only on the database is fine.
  await db.tx(async () => {
    await db.prepare("INSERT INTO things (user_id, name) VALUES (@uid, 'y')").run();
    await db.prepare('SELECT COUNT(*) FROM things').pluck().get();
  });
  assert.equal(raw.prepare('SELECT COUNT(*) FROM things').pluck().get(), 1);
});

test('Claude and HTTP calls refuse to run inside a transaction, and run outside one', async () => {
  const { db } = setup({ fallbackUid: 1, strictTx: false });
  /** @type {string[]} */
  const sent = [];
  const claude = createJobClaude(/** @type {Database.Database} */ (/** @type {unknown} */ (null)), {
    ownerClient: fakeClaude(async () => {
      sent.push('claude');
      return { text: 'ok' };
    }),
  });
  const http = createHttp({
    fetchImpl: async () => {
      sent.push('http');
      return new Response('ok');
    },
  });
  await assert.rejects(db.tx(() => claude.send({ model: 'm', maxTokens: 1, prompt: 'x' })), /A Claude call can not run inside a database transaction/);
  await assert.rejects(db.tx(() => http.get('https://example.com/')), /An HTTP request can not run inside a database transaction/);
  assert.deepEqual(sent, [], 'neither reached the network');
  assert.equal(insideTransaction(), false);
  await db.tx(async () => assert.equal(insideTransaction(), true));
});

test('the guard is on under node --test by default', async () => {
  const { db } = setup({ fallbackUid: 1 });
  await assert.rejects(
    db.tx(async () => {
      await new Promise((r) => setImmediate(r));
    }),
    /waited on something besides the database/,
  );
});

test('openJobStore gives store.engine over the same connection, scoped like store.db', async () => {
  const store = openJobStore(':memory:');
  const sync = store.db.prepare('SELECT COUNT(*) FROM users').pluck().get();
  assert.equal(await store.engine.prepare('SELECT COUNT(*) FROM users').pluck().get(), sync);
  await store.engine.tx(async () => {
    await store.engine.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('engine-test', '1', 'x')").run();
  });
  assert.equal(store.db.prepare("SELECT value FROM app_settings WHERE key = 'engine-test'").pluck().get(), '1');
  store.close();

  const server = openJobStore(':memory:', { fallbackUid: null });
  await assert.rejects(server.engine.prepare('SELECT COUNT(*) FROM postings WHERE user_id = @uid').pluck().get(), /needs a user/);
  assert.equal(await runAsUser(1, async () => await server.engine.prepare('SELECT COUNT(*) FROM postings WHERE user_id = @uid').pluck().get()), 0);
  server.close();
});

test('asEngine: every view of one connection shares its transaction lock', async () => {
  const store = openJobStore(':memory:', { fallbackUid: 1 });
  const fromScoped = asEngine(store.db);
  const fromRaw = asEngine(store.raw);
  assert.equal(asEngine(store.db), fromScoped, 'one view per handle');
  assert.equal(asEngine(store.engine), store.engine, 'an engine is its own view');
  const hold = deferred();
  const order = /** @type {string[]} */ ([]);
  // The holder has the guard off, so the test can keep its transaction open across a macrotask.
  const holder = createSqliteEngine(store.raw, { fallbackUid: 1, strictTx: false });
  const inside = holder.tx(async () => {
    await holder.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('a', '1', 'x')").run();
    await hold.promise;
    order.push('tx done');
  });
  await new Promise((r) => setImmediate(r));
  const viaScoped = fromScoped.prepare('SELECT COUNT(*) FROM app_settings').pluck().get().then((n) => order.push(`scoped saw ${n}`));
  const viaRaw = fromRaw.prepare('SELECT COUNT(*) FROM app_settings').pluck().get().then((n) => order.push(`raw saw ${n}`));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, [], 'both wait for the open transaction');
  hold.resolve();
  await Promise.all([inside, viaScoped, viaRaw]);
  assert.deepEqual(order, ['tx done', 'scoped saw 1', 'raw saw 1']);
  store.close();
});

test('users: two decisions at once can not both pass the status check; two requests from one address make one row', async () => {
  const store = openJobStore(':memory:');
  const id = await addUser(store.db, { email: 'pending@example.com', status: 'pending' });
  const results = await Promise.allSettled([decide(store.db, id, 'reject', { by: 1 }), decide(store.db, id, 'reject', { by: 1 })]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.match(String(/** @type {PromiseRejectedResult} */ (results.find((r) => r.status === 'rejected')).reason), /A rejected account cannot be rejected\./);

  const [a, b] = await Promise.all([
    requestAccess(store.db, { email: 'new@example.com', name: 'New' }),
    requestAccess(store.db, { email: 'NEW@example.com', name: 'New' }),
  ]);
  assert.equal(a.id, b.id);
  assert.deepEqual([a.created, b.created].sort(), [false, true]);
  assert.equal(store.db.prepare("SELECT COUNT(*) FROM users WHERE email = 'new@example.com'").pluck().get(), 1);
  assert.equal((await getUser(store.db, a.id))?.status, 'pending');
  store.close();
});

test('trace writes go through the engine: a run started during an open transaction waits for it', async () => {
  const store = openJobStore(':memory:', { fallbackUid: 1 });
  const hold = deferred();
  const holder = createSqliteEngine(store.raw, { fallbackUid: 1, strictTx: false });
  const inside = holder.tx(async () => {
    await holder.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('a', '1', 'x')").run();
    await hold.promise;
  });
  await new Promise((r) => setImmediate(r));
  let started = false;
  const run = createJobTracer({ store }).startRun('trace-test').then((r) => ((started = true), r));
  await new Promise((r) => setImmediate(r));
  assert.equal(started, false, 'the runs row waits for the open transaction');
  hold.resolve();
  await inside;
  const r = await run;
  assert.deepEqual(store.raw.prepare('SELECT name, user_id FROM runs WHERE id = ?').get(r.id), { name: 'trace-test', user_id: 1 });
  await r.finish('ok');
  assert.equal(store.raw.prepare('SELECT status FROM runs WHERE id = ?').pluck().get(r.id), 'ok');
  store.close();
});

test('oneStartAtATime: starts run in order, one at a time, and a failed start does not block the next', async () => {
  const order = /** @type {string[]} */ ([]);
  const slow = oneStartAtATime(async () => {
    order.push('a begins');
    await new Promise((r) => setImmediate(r));
    order.push('a ends');
    return 'a';
  });
  const failing = oneStartAtATime(async () => {
    order.push('b');
    throw new Error('refused');
  });
  const after = oneStartAtATime(() => (order.push('c'), 'c'));
  assert.equal(await slow, 'a');
  await assert.rejects(failing, /refused/);
  assert.equal(await after, 'c');
  assert.deepEqual(order, ['a begins', 'a ends', 'b', 'c']);
});
