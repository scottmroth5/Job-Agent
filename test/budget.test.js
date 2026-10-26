// Claude spending caps and who pays for each call (agents/budget.js, tools/claude.js). Synthetic runs and calls only;
// Claude is faked, and keys are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openJobStore } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { budgetLimit, budgetStatus, setBudgetLimit, spendByLabel, BudgetExceededError, DEFAULT_MONTHLY_BUDGET_USD } from '../agents/budget.js';
import { runAsUser } from '../db/scope.js';
import { addUser, OWNER_ID, setAiAccess, setClaudeKey } from '../db/users.js';
import { createJobClaude, NoClaudeKeyError } from '../tools/claude.js';
import { boxKey, seal } from '../tools/secret-box.js';

const local = (y, mo, d, h = 12) => new Date(y, mo - 1, d, h);

function seed(db, calls, uid = null) {
  const runId = Number(db.prepare("INSERT INTO runs (name, status, started_at, user_id) VALUES ('score', 'ok', ?, ?)").run(new Date().toISOString(), uid).lastInsertRowid);
  const insert = db.prepare('INSERT INTO run_calls (run_id, label, model, cost_usd, created_at) VALUES (?, ?, ?, ?, ?)');
  for (const [label, usd, at] of calls) insert.run(runId, label, 'claude-sonnet-5-5', usd, at.toISOString());
}

test('status: only this calendar month counts, in local time; warn at 80%, over at the cap', () => {
  const { db } = openJobStore(':memory:');
  seed(db, [
    ['score', 30, local(2026, 9, 30, 23)], // last month, even though it is October 1 in UTC
    ['score', 20, local(2026, 10, 1, 0, 30)],
    ['meeting-prep', 15, local(2026, 10, 12)],
  ]);
  const s = budgetStatus(db, { now: local(2026, 10, 16), env: {} });
  assert.deepEqual([s.spentUsd, s.limitUsd, s.remainingUsd, s.level, s.month, s.source], [35, DEFAULT_MONTHLY_BUDGET_USD, 15, 'ok', '2026-10', 'default']);
  seed(db, [['cover-letter', 6, local(2026, 10, 14)]]);
  assert.equal(budgetStatus(db, { now: local(2026, 10, 16), env: {} }).level, 'warn');
  seed(db, [['score', 9, local(2026, 10, 15)]]);
  assert.equal(budgetStatus(db, { now: local(2026, 10, 16), env: {} }).level, 'over');
  assert.equal(budgetStatus(db, { now: local(2026, 11, 1, 0, 5), env: {} }).spentUsd, 0, 'a new month starts at zero');
  assert.deepEqual(spendByLabel(db, { now: local(2026, 10, 16) }).map((r) => [r.label, r.costUsd]), [['score', 29], ['meeting-prep', 15], ['cover-letter', 6]]);
});

test('limit: the Admin setting beats .env, which beats the default; bad values are refused', () => {
  const { db } = openJobStore(':memory:');
  assert.deepEqual(budgetLimit(db, { MONTHLY_CLAUDE_BUDGET_USD: '75' }), { limitUsd: 75, source: 'env' });
  assert.deepEqual(budgetLimit(db, { MONTHLY_CLAUDE_BUDGET_USD: 'lots' }), { limitUsd: DEFAULT_MONTHLY_BUDGET_USD, source: 'default' });
  setBudgetLimit(db, 120.456);
  assert.deepEqual(budgetLimit(db, { MONTHLY_CLAUDE_BUDGET_USD: '75' }), { limitUsd: 120.46, source: 'admin' });
  for (const bad of [0, -5, 'abc', 1e9]) assert.throws(() => setBudgetLimit(db, bad), /above zero/);
});

const SECRET = 'a test secret for sealing user keys, 32+ characters';
const fakeClient = (name, sent) => ({ send: async () => { sent.push(name); return { text: name }; } });
const ask = (claude) => claude.send({ model: 'm', maxTokens: 1, prompt: 'x' });

test('the owner: calls go through under the cap and are refused, without calling Claude, once it is reached', async () => {
  const { db } = openJobStore(':memory:');
  const sent = [];
  const claude = createJobClaude(db, { ownerClient: fakeClient('owner', sent), env: { MONTHLY_CLAUDE_BUDGET_USD: '10' } });
  assert.equal((await ask(claude)).text, 'owner');
  seed(db, [['score', 10.01, new Date()]], OWNER_ID);
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
  const sent = [];
  const keys = [];
  const claude = createJobClaude(db, {
    ownerClient: fakeClient('owner', sent),
    forKey: (apiKey) => { keys.push(apiKey); return fakeClient(`own:${apiKey}`, sent); },
    env: {},
  });
  const own = addUser(db, { email: 'own@example.com' });
  const given = addUser(db, { email: 'given@example.com' });
  setAiAccess(db, given, { source: 'owner', capUsd: 5 });

  await assert.rejects(runAsUser(own, () => ask(claude)), NoClaudeKeyError);
  setClaudeKey(db, own, seal('sk-ant-made-up-key-1', own, boxKey(SECRET)));
  assert.equal((await runAsUser(own, () => ask(claude))).text, 'own:sk-ant-made-up-key-1');
  await runAsUser(own, () => ask(claude));
  assert.deepEqual(keys, ['sk-ant-made-up-key-1'], 'the opened key is kept for the next call, not opened each time');
  setClaudeKey(db, own, seal('sk-ant-made-up-key-2', own, boxKey(SECRET)));
  assert.equal((await runAsUser(own, () => ask(claude))).text, 'own:sk-ant-made-up-key-2', 'a new key takes effect at once');

  assert.equal((await runAsUser(given, () => ask(claude))).text, 'owner');
  assert.equal((await ask(claude)).text, 'owner', 'scripts run as the owner');

  // A key sealed for one user does not open for another.
  setClaudeKey(db, given, seal('sk-ant-made-up-key-3', own, boxKey(SECRET)));
  setAiAccess(db, given, { source: 'own' });
  await assert.rejects(runAsUser(given, () => ask(claude)));

  db.prepare("UPDATE users SET status = 'paused' WHERE id = ?").run(own);
  await assert.rejects(runAsUser(own, () => ask(claude)), /not active/);
});

test('caps: a user on the owner\'s key stops at their allowance (told once), and the owner\'s cap counts their spend', async () => {
  const { db } = openJobStore(':memory:');
  const sent = [];
  const reached = [];
  const claude = createJobClaude(db, { ownerClient: fakeClient('owner', sent), env: { MONTHLY_CLAUDE_BUDGET_USD: '20' }, onCapReached: (uid) => reached.push(uid) });
  const given = addUser(db, { email: 'given@example.com' });
  const own = addUser(db, { email: 'own@example.com' });
  setAiAccess(db, given, { source: 'owner', capUsd: 5 });
  seed(db, [['score', 6, new Date()]], given);
  await assert.rejects(runAsUser(given, () => ask(claude)), /allowance the owner gave you/);
  assert.deepEqual(reached, [given]);
  assert.equal(budgetStatus(db, { uid: OWNER_ID, env: { MONTHLY_CLAUDE_BUDGET_USD: '20' } }).spentUsd, 6, "the owner's key paid for it");

  // Spend on a user's own key is theirs alone: it is shown to them, with no cap, and never counts against the owner.
  seed(db, [['cover-letter', 30, new Date()]], own);
  const mine = budgetStatus(db, { uid: own });
  assert.deepEqual([mine.paidBy, mine.spentUsd, mine.limitUsd, mine.level], ['own', 30, null, 'ok']);
  assert.equal(budgetStatus(db, { uid: OWNER_ID, env: { MONTHLY_CLAUDE_BUDGET_USD: '20' } }).spentUsd, 6);
  assert.deepEqual(spendByLabel(db, { uid: own }).map((r) => r.label), ['cover-letter']);

  // The owner's own cap also stops users on the owner's key.
  setAiAccess(db, given, { source: 'owner', capUsd: 100 });
  seed(db, [['score', 15, new Date()]], OWNER_ID);
  await assert.rejects(runAsUser(given, () => ask(claude)), /owner's monthly Claude budget/);
  assert.deepEqual(sent, []);
  for (const bad of [{ source: 'owner' }, { source: 'owner', capUsd: 0 }, { source: 'owner', capUsd: 1e6 }, { source: 'friend' }]) {
    assert.throws(() => setAiAccess(db, given, bad), /cap|key/);
  }
  assert.throws(() => setAiAccess(db, OWNER_ID, { source: 'own' }), /always uses your key/);
});

test('API: header summary and Admin > Spending show and change the cap', async () => {
  const store = openJobStore(':memory:');
  seed(store.db, [['score', 4, new Date()]]);
  const app = await buildApp({ store, config: { search: { homeLocations: [] }, fractional: {} }, services: { createBrowser: async () => null } });
  const header = (await app.inject('/api/summary')).json().budget;
  assert.deepEqual([header.spentUsd, header.limitUsd, header.level], [4, DEFAULT_MONTHLY_BUDGET_USD, 'ok']);
  const set = await app.inject({ method: 'PUT', url: '/api/admin/budget', payload: { limitUsd: 5 } });
  assert.equal(set.statusCode, 200);
  assert.deepEqual([set.json().limitUsd, set.json().level, set.json().byLabel[0].label], [5, 'warn', 'score']);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/admin/budget', payload: { limitUsd: 0 } })).statusCode, 400);
  assert.equal((await app.inject('/api/admin/budget')).json().limitUsd, 5);
  await app.close();
  store.close();
});
