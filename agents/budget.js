// The monthly Claude spending cap. Every Claude client in the app is wrapped by withBudget, which refuses a call once
// this calendar month's spend (in the app time zone) reaches the cap. Spend comes from run_calls, which agent-core
// records as each call finishes, so the call that crosses the cap completes and the next one is refused.
// The cap is set on Admin > Spending (app_settings), else MONTHLY_CLAUDE_BUDGET_USD in .env, else the default.
import { getSetting, setSetting } from '../db/settings.js';

export const DEFAULT_MONTHLY_BUDGET_USD = 50;
export const WARN_AT = 0.8;
const SETTING = 'claude.monthlyBudgetUsd';

export class BudgetExceededError extends Error {
  constructor(status) {
    super(
      `The monthly Claude budget is used up: $${status.spentUsd.toFixed(2)} of $${status.limitUsd.toFixed(2)} spent in ${status.monthLabel}. ` +
        'Raise it on Admin > Spending, or wait for next month.',
    );
    this.name = 'BudgetExceededError';
    this.statusCode = 402;
    this.status = status;
  }
}

/** Midnight on the first day of this month, local time. */
const monthStart = (now) => new Date(now.getFullYear(), now.getMonth(), 1);

const valid = (n) => Number.isFinite(n) && n > 0;

/** The cap in dollars and where it comes from. */
export function budgetLimit(db, env = process.env) {
  const saved = Number(getSetting(db, SETTING));
  if (valid(saved)) return { limitUsd: saved, source: 'admin' };
  const fromEnv = Number(env.MONTHLY_CLAUDE_BUDGET_USD);
  if (valid(fromEnv)) return { limitUsd: fromEnv, source: 'env' };
  return { limitUsd: DEFAULT_MONTHLY_BUDGET_USD, source: 'default' };
}

/** Saves a new cap (Admin > Spending). */
export function setBudgetLimit(db, limitUsd) {
  const n = Number(limitUsd);
  if (!valid(n) || n > 100000) throw Object.assign(new Error('The monthly budget must be a dollar amount above zero.'), { statusCode: 400 });
  setSetting(db, SETTING, String(Math.round(n * 100) / 100));
}

/** This month's spend against the cap. */
export function budgetStatus(db, { now = new Date(), env = process.env } = {}) {
  const start = monthStart(now);
  const spentUsd = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) FROM run_calls WHERE created_at >= ?').pluck().get(start.toISOString());
  const { limitUsd, source } = budgetLimit(db, env);
  const used = spentUsd / limitUsd;
  return {
    month: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`,
    monthLabel: start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    spentUsd,
    limitUsd,
    remainingUsd: Math.max(0, limitUsd - spentUsd),
    source,
    level: used >= 1 ? 'over' : used >= WARN_AT ? 'warn' : 'ok',
  };
}

/** This month's spend by what it was for (the call labels: score, cover-letter, meeting-prep, inbox, ...). */
export function spendByLabel(db, { now = new Date() } = {}) {
  return db
    .prepare(`SELECT COALESCE(label, 'other') AS label, COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS costUsd
      FROM run_calls WHERE created_at >= ? GROUP BY COALESCE(label, 'other') ORDER BY costUsd DESC`)
    .all(monthStart(now).toISOString());
}

/** A Claude client that refuses calls once the monthly cap is reached. */
export function withBudget(claude, db, { env = process.env, now = () => new Date() } = {}) {
  return {
    ...claude,
    async send(opts) {
      const status = budgetStatus(db, { now: now(), env });
      if (status.level === 'over') throw new BudgetExceededError(status);
      return claude.send(opts);
    },
  };
}
