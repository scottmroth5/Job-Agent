// Claude spending caps. Every Claude call goes through tools/claude.js, which checks the caps before it sends.
// Spend comes from run_calls (agent-core records each call as it finishes), joined to runs for the user, so the call
// that crosses a cap completes and the next one is refused. Months are calendar months in the app time zone.
//   The owner's key (ANTHROPIC_API_KEY) pays for the owner's runs and for users the owner put on it; all of that counts
//   toward the owner's cap: Admin > Spending (app_settings), else MONTHLY_CLAUDE_BUDGET_USD in .env, else the default.
//   A user on the owner's key also has their own monthly cap (users.ai_cap_usd, set on Admin > Users).
//   A user with their own key pays for it themselves; their spend is shown, with no cap here.
import { getSetting, setSetting } from '../db/settings.js';
import { OWNER_ID } from '../db/users.js';

export const DEFAULT_MONTHLY_BUDGET_USD = 50;
export const WARN_AT = 0.8;
const SETTING = 'claude.monthlyBudgetUsd';

export class BudgetExceededError extends Error {
  constructor(status, { whose = 'monthly Claude budget', fix = 'Raise it on Admin > Spending, or wait for next month.', scope = 'owner' } = {}) {
    super(`The ${whose} is used up: $${status.spentUsd.toFixed(2)} of $${status.limitUsd.toFixed(2)} spent in ${status.monthLabel}. ${fix}`);
    this.name = 'BudgetExceededError';
    this.statusCode = 402;
    this.status = status;
    this.scope = scope; // 'owner' (the owner's cap) or 'user' (a user's allowance on the owner's key)
  }
}

/** Midnight on the first day of this month, local time. */
const monthStart = (now) => new Date(now.getFullYear(), now.getMonth(), 1);

const valid = (n) => Number.isFinite(n) && n > 0;

// Which runs each kind of spend covers. Runs with no user are older than per-user runs, so they were the owner's.
const OWNER_KEY_RUNS = "(r.user_id IS NULL OR r.user_id = 1 OR r.user_id IN (SELECT id FROM users WHERE ai_source = 'owner'))";
const scopeSql = (uid) => (uid === OWNER_ID ? OWNER_KEY_RUNS : 'r.user_id = ?');
const scopeArgs = (uid) => (uid === OWNER_ID ? [] : [uid]);

/** Dollars spent this month: on the owner's key (uid = the owner) or by one user. */
export function spentUsd(db, uid, now = new Date()) {
  return db
    .prepare(`SELECT COALESCE(SUM(c.cost_usd), 0) FROM run_calls c JOIN runs r ON r.id = c.run_id WHERE c.created_at >= ? AND ${scopeSql(uid)}`)
    .pluck()
    .get(monthStart(now).toISOString(), ...scopeArgs(uid));
}

/** The owner's cap in dollars and where it comes from. */
export function budgetLimit(db, env = process.env) {
  const saved = Number(getSetting(db, SETTING));
  if (valid(saved)) return { limitUsd: saved, source: 'admin' };
  const fromEnv = Number(env.MONTHLY_CLAUDE_BUDGET_USD);
  if (valid(fromEnv)) return { limitUsd: fromEnv, source: 'env' };
  return { limitUsd: DEFAULT_MONTHLY_BUDGET_USD, source: 'default' };
}

/** Saves a new cap for the owner's key (Admin > Spending). */
export function setBudgetLimit(db, limitUsd) {
  const n = Number(limitUsd);
  if (!valid(n) || n > 100000) throw Object.assign(new Error('The monthly budget must be a dollar amount above zero.'), { statusCode: 400 });
  setSetting(db, SETTING, String(Math.round(n * 100) / 100));
}

const month = (now) => {
  const start = monthStart(now);
  return {
    month: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`,
    monthLabel: start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
  };
};
const level = (spent, limit) => (limit == null ? 'ok' : spent / limit >= 1 ? 'over' : spent / limit >= WARN_AT ? 'warn' : 'ok');

/**
 * This month's spend for a user against their cap. paidBy: 'owner' (the owner's key) or 'own' (their key, no cap:
 * limitUsd null). For the owner it is everything on the owner's key against the owner's cap.
 */
export function budgetStatus(db, { uid = OWNER_ID, now = new Date(), env = process.env } = {}) {
  const spent = spentUsd(db, uid, now);
  if (uid === OWNER_ID) {
    const { limitUsd, source } = budgetLimit(db, env);
    return { ...month(now), paidBy: 'owner', spentUsd: spent, limitUsd, remainingUsd: Math.max(0, limitUsd - spent), source, level: level(spent, limitUsd) };
  }
  const user = db.prepare('SELECT ai_source, ai_cap_usd FROM users WHERE id = ?').get(uid);
  const limitUsd = user?.ai_source === 'owner' ? user.ai_cap_usd : null;
  return {
    ...month(now),
    paidBy: user?.ai_source === 'owner' ? 'owner' : 'own',
    spentUsd: spent,
    limitUsd,
    remainingUsd: limitUsd == null ? null : Math.max(0, limitUsd - spent),
    source: limitUsd == null ? 'none' : 'admin',
    level: level(spent, limitUsd),
  };
}

/** Throws BudgetExceededError when this user may not make another Claude call this month. */
export function checkBudget(db, { uid = OWNER_ID, now = new Date(), env = process.env } = {}) {
  const status = budgetStatus(db, { uid, now, env });
  if (status.level === 'over') {
    throw uid === OWNER_ID
      ? new BudgetExceededError(status)
      : new BudgetExceededError(status, { whose: 'monthly Claude allowance the owner gave you', fix: 'Ask the owner to raise it, or wait for next month.', scope: 'user' });
  }
  if (status.paidBy === 'owner' && uid !== OWNER_ID) {
    const owner = budgetStatus(db, { uid: OWNER_ID, now, env });
    if (owner.level === 'over') throw new BudgetExceededError(owner, { whose: "owner's monthly Claude budget", fix: 'Ask the owner, or wait for next month.' });
  }
  return status;
}

/** This month's spend by what it was for (call labels: score, cover-letter, meeting-prep, inbox, ...), for a user. */
export function spendByLabel(db, { uid = OWNER_ID, now = new Date() } = {}) {
  return db
    .prepare(`SELECT COALESCE(c.label, 'other') AS label, COUNT(*) AS calls, COALESCE(SUM(c.cost_usd), 0) AS costUsd
      FROM run_calls c JOIN runs r ON r.id = c.run_id WHERE c.created_at >= ? AND ${scopeSql(uid)}
      GROUP BY COALESCE(c.label, 'other') ORDER BY costUsd DESC`)
    .all(monthStart(now).toISOString(), ...scopeArgs(uid));
}
