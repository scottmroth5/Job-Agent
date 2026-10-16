// The monthly Claude spending cap. Synthetic runs and calls only; Claude is faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openJobStore } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { budgetLimit, budgetStatus, setBudgetLimit, spendByLabel, withBudget, BudgetExceededError, DEFAULT_MONTHLY_BUDGET_USD } from '../agents/budget.js';

const local = (y, mo, d, h = 12) => new Date(y, mo - 1, d, h);

function seed(db, calls) {
  const runId = Number(db.prepare("INSERT INTO runs (name, status, started_at) VALUES ('score', 'ok', ?)").run(new Date().toISOString()).lastInsertRowid);
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

test('withBudget: calls go through under the cap and are refused, without calling Claude, once it is reached', async () => {
  const { db } = openJobStore(':memory:');
  let sent = 0;
  const claude = withBudget({ send: async () => { sent += 1; return { text: 'ok' }; } }, db, { env: { MONTHLY_CLAUDE_BUDGET_USD: '10' } });
  assert.equal((await claude.send({ model: 'm', maxTokens: 1, prompt: 'x' })).text, 'ok');
  seed(db, [['score', 10.01, new Date()]]);
  await assert.rejects(claude.send({ model: 'm', maxTokens: 1, prompt: 'x' }), (err) => {
    assert.ok(err instanceof BudgetExceededError);
    assert.match(err.message, /\$10\.01 of \$10\.00 spent in .*Raise it on Admin > Spending/);
    return true;
  });
  assert.equal(sent, 1);
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
