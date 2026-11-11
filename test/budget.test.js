// Claude spending caps and who pays for each call (agents/budget.ts, tools/claude.ts). Synthetic runs and calls only;
// Claude is faked, and keys are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openJobStore } from '../db/index.ts';
import { buildApp } from '../server/app.ts';
import { budgetLimit, budgetStatus, setBudgetLimit, spendByLabel, BudgetExceededError, DEFAULT_MONTHLY_BUDGET_USD } from '../agents/budget.ts';
import { runAsUser } from '../db/scope.ts';
import { addUser, OWNER_ID, setAiAccess, setClaudeKey } from '../db/users.ts';
import { createJobClaude, NoClaudeKeyError } from '../tools/claude.ts';
import { boxKey, seal } from '../tools/secret-box.ts';
import { fakeClaude, fakeConfig, fakeServices } from './fixtures/fakes.js';
/** @import { Db } from '../tools/types.ts' */
/** @import { Claude } from '@scottmroth5/agent-core' */

/** A local time; one caller gives the minutes too (0:30). */
const local = (/** @type {number} */ y, /** @type {number} */ mo, /** @type {number} */ d, h = 12, min = 0) => new Date(y, mo - 1, d, h, min);

/**
 * @param {Db} db
 * @param {Array<[string, number, Date]>} calls label, cost, when
 * @param {number | null} [uid]
 */
async function seed(db, calls, uid = null) {
  const runId = Number((await db.prepare("INSERT INTO runs (name, status, started_at, user_id) VALUES ('score', 'ok', ?, ?)").run(new Date().toISOString(), uid)).id);
  const insert = db.prepare('INSERT INTO run_calls (run_id, label, model, cost_usd, created_at) VALUES (?, ?, ?, ?, ?)');
  for (const [label, usd, at] of calls) await insert.run(runId, label, 'claude-sonnet-5-5', usd, at.toISOString());
}

test('status: only this calendar month counts, in local time; warn at 80%, over at the cap', async () => {
  const { db } = openJobStore(':memory:');
  await seed(db, [
    ['score', 30, local(2026, 9, 30, 23)], // last month, even though it is October 1 in UTC
    ['score', 20, local(2026, 10, 1, 0, 30)],
    ['meeting-prep', 15, local(2026, 10, 12)],
  ]);
  const s = await budgetStatus(db, { now: local(2026, 10, 16), env: {} });
  assert.deepEqual([s.spentUsd, s.limitUsd, s.remainingUsd, s.level, s.month, s.source], [35, DEFAULT_MONTHLY_BUDGET_USD, 15, 'ok', '2026-10', 'default']);
  await seed(db, [['cover-letter', 6, local(2026, 10, 14)]]);
  assert.equal((await budgetStatus(db, { now: local(2026, 10, 16), env: {} })).level, 'warn');
  await seed(db, [['score', 9, local(2026, 10, 15)]]);
  assert.equal((await budgetStatus(db, { now: local(2026, 10, 16), env: {} })).level, 'over');
  assert.equal((await budgetStatus(db, { now: local(2026, 11, 1, 0, 5), env: {} })).spentUsd, 0, 'a new month starts at zero');
  assert.deepEqual((await spendByLabel(db, { now: local(2026, 10, 16) })).map((r) => [r.label, r.costUsd]), [['score', 29], ['meeting-prep', 15], ['cover-letter', 6]]);
});

test('limit: the Admin setting beats .env, which beats the default; bad values are refused', async () => {
  const { db } = openJobStore(':memory:');
  assert.deepEqual(await budgetLimit(db, { MONTHLY_CLAUDE_BUDGET_USD: '75' }), { limitUsd: 75, source: 'env' });
  assert.deepEqual(await budgetLimit(db, { MONTHLY_CLAUDE_BUDGET_USD: 'lots' }), { limitUsd: DEFAULT_MONTHLY_BUDGET_USD, source: 'default' });
  await setBudgetLimit(db, 120.456);
  assert.deepEqual(await budgetLimit(db, { MONTHLY_CLAUDE_BUDGET_USD: '75' }), { limitUsd: 120.46, source: 'admin' });
  for (const bad of [0, -5, 'abc', 1e9]) await assert.rejects(async () => await setBudgetLimit(db, bad), /above zero/);
});

const SECRET = 'a test secret for sealing user keys, 32+ characters';
const fakeClient = (/** @type {string} */ name, /** @type {string[]} */ sent) => fakeClaude(async () => { sent.push(name); return { text: name }; });
const ask = (/** @type {Claude} */ claude) => claude.send({ model: 'm', maxTokens: 1, prompt: 'x' });

test('the owner: calls go through under the cap and are refused, without calling Claude, once it is reached', async () => {
  const { db } = openJobStore(':memory:');
  /** @type {string[]} */
  const sent = [];
  const claude = createJobClaude(db, { ownerClient: fakeClient('owner', sent), env: { MONTHLY_CLAUDE_BUDGET_USD: '10' } });
  assert.equal((await ask(claude)).text, 'owner');
  await seed(db, [['score', 10.01, new Date()]], OWNER_ID);
  await assert.rejects(ask(claude), (err) => {
    assert.ok(err instanceof BudgetExceededError);
    assert.match(err.message, /\$10\.01 of \$10\.00 spent in .*Raise it on Admin > Spending/);
    return true;
  });
  assert.deepEqual(sent, ['owner']);
});

test('who pays: the owner and users on the owner\'s key use it; others their own key; no key, no AI', async () => {
  process.env.USER_KEY_SECRET = SECRET;
  const { db } = openJobStore(':memory:');
  /** @type {string[]} */
  const sent = [];
  /** @type {string[]} */
  const keys = [];
  const claude = createJobClaude(db, {
    ownerClient: fakeClient('owner', sent),
    forKey: (apiKey) => { keys.push(apiKey); return fakeClient(`own:${apiKey}`, sent); },
    env: {},
  });
  const own = await addUser(db, { email: 'own@example.com' });
  const given = await addUser(db, { email: 'given@example.com' });
  await setAiAccess(db, given, { source: 'owner', capUsd: 5 });

  await assert.rejects(runAsUser(own, () => ask(claude)), NoClaudeKeyError);
  await setClaudeKey(db, own, seal('sk-ant-made-up-key-1', own, boxKey(SECRET)));
  assert.equal((await runAsUser(own, () => ask(claude))).text, 'own:sk-ant-made-up-key-1');
  await runAsUser(own, () => ask(claude));
  assert.deepEqual(keys, ['sk-ant-made-up-key-1'], 'the opened key is kept for the next call, not opened each time');
  await setClaudeKey(db, own, seal('sk-ant-made-up-key-2', own, boxKey(SECRET)));
  assert.equal((await runAsUser(own, () => ask(claude))).text, 'own:sk-ant-made-up-key-2', 'a new key takes effect at once');

  assert.equal((await runAsUser(given, () => ask(claude))).text, 'owner');
  assert.equal((await ask(claude)).text, 'owner', 'scripts run as the owner');

  // A key sealed for one user does not open for another.
  await setClaudeKey(db, given, seal('sk-ant-made-up-key-3', own, boxKey(SECRET)));
  await setAiAccess(db, given, { source: 'own' });
  await assert.rejects(runAsUser(given, () => ask(claude)));

  await db.prepare("UPDATE users SET status = 'paused' WHERE id = ?").run(own);
  await assert.rejects(runAsUser(own, () => ask(claude)), /not active/);
});

test('caps: a user on the owner\'s key stops at their allowance (told once), and the owner\'s cap counts their spend', async () => {
  const { db } = openJobStore(':memory:');
  /** @type {string[]} */
  const sent = [];
  /** @type {number[]} */
  const reached = [];
  const claude = createJobClaude(db, { ownerClient: fakeClient('owner', sent), env: { MONTHLY_CLAUDE_BUDGET_USD: '20' }, onCapReached: (uid) => reached.push(uid) });
  const given = await addUser(db, { email: 'given@example.com' });
  const own = await addUser(db, { email: 'own@example.com' });
  await setAiAccess(db, given, { source: 'owner', capUsd: 5 });
  await seed(db, [['score', 6, new Date()]], given);
  await assert.rejects(runAsUser(given, () => ask(claude)), /allowance the owner gave you/);
  assert.deepEqual(reached, [given]);
  assert.equal((await budgetStatus(db, { uid: OWNER_ID, env: { MONTHLY_CLAUDE_BUDGET_USD: '20' } })).spentUsd, 6, "the owner's key paid for it");

  // Spend on a user's own key is theirs alone: it is shown to them, with no cap, and never counts against the owner.
  await seed(db, [['cover-letter', 30, new Date()]], own);
  const mine = await budgetStatus(db, { uid: own });
  assert.deepEqual([mine.paidBy, mine.spentUsd, mine.limitUsd, mine.level], ['own', 30, null, 'ok']);
  assert.equal((await budgetStatus(db, { uid: OWNER_ID, env: { MONTHLY_CLAUDE_BUDGET_USD: '20' } })).spentUsd, 6);
  assert.deepEqual((await spendByLabel(db, { uid: own })).map((r) => r.label), ['cover-letter']);

  // The owner's own cap also stops users on the owner's key.
  await setAiAccess(db, given, { source: 'owner', capUsd: 100 });
  await seed(db, [['score', 15, new Date()]], OWNER_ID);
  await assert.rejects(runAsUser(given, () => ask(claude)), /owner's monthly Claude budget/);
  assert.deepEqual(sent, []);
  for (const bad of [{ source: 'owner' }, { source: 'owner', capUsd: 0 }, { source: 'owner', capUsd: 1e6 }, { source: 'friend' }]) {
    await assert.rejects(setAiAccess(db, given, bad), /cap|key/);
  }
  await assert.rejects(setAiAccess(db, OWNER_ID, { source: 'own' }), /always uses your key/);
});

test('API: header summary and Admin > Spending show and change the cap', async () => {
  const store = openJobStore(':memory:');
  await seed(store.db, [['score', 4, new Date()]]);
  const app = await buildApp({ store, config: fakeConfig({ search: { homeLocations: [] }, fractional: {} }), services: fakeServices({ createBrowser: async () => null }) });
  const header = (await app.inject('/api/summary')).json().budget;
  assert.deepEqual([header.spentUsd, header.limitUsd, header.level], [4, DEFAULT_MONTHLY_BUDGET_USD, 'ok']);
  const set = await app.inject({ method: 'PUT', url: '/api/admin/budget', payload: { limitUsd: 5 } });
  assert.equal(set.statusCode, 200);
  assert.deepEqual([set.json().limitUsd, set.json().level, set.json().byLabel[0].label], [5, 'warn', 'score']);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/admin/budget', payload: { limitUsd: 0 } })).statusCode, 400);
  assert.equal((await app.inject('/api/spending')).json().limitUsd, 5);
  await app.close();
  store.close();
});
