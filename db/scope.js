// One user's view of the shared database (multi-user, phase 1). Every query on a user table says "user_id = @uid"
// (and every insert gives user_id the value @uid); the scoped database binds @uid to the user the current request or
// job runs as. The user comes from an AsyncLocalStorage context (runAsUser), so routes, agents, and tasks keep taking
// `db` and every promise a request starts runs as that request's user. A statement that names @uid when there is no
// user throws instead of reading everyone's rows; statements on app-wide tables (lookups, app_settings, runs) never
// name @uid and run anywhere. test/user-scope.test.js checks that every query on a user table names user_id.
import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage();

/** Runs fn (and everything it starts) as user uid; returns what fn returns. */
export function runAsUser(uid, fn) {
  if (!Number.isInteger(uid) || uid < 1) throw new TypeError(`runAsUser: "${uid}" is not a user id`);
  return context.run({ uid }, fn);
}

/** The user the current request or job runs as, or null outside runAsUser. */
export const currentUserId = () => context.getStore()?.uid ?? null;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v);

function scopeStatement(stmt, userId) {
  const needsUid = stmt.source.includes('@uid');
  // Named values travel in one plain object: add uid to it, or pass one holding only uid after the positional values.
  const bind = (args) => {
    if (!needsUid) return args;
    const uid = userId();
    const i = args.findIndex(isPlainObject);
    if (i < 0) return [...args, { uid }];
    const copy = [...args];
    copy[i] = { ...args[i], uid };
    return copy;
  };
  const scoped = {
    run: (...args) => stmt.run(...bind(args)),
    get: (...args) => stmt.get(...bind(args)),
    all: (...args) => stmt.all(...bind(args)),
    iterate: (...args) => stmt.iterate(...bind(args)),
    pluck: (on = true) => { stmt.pluck(on); return scoped; },
    raw: (on = true) => { stmt.raw(on); return scoped; },
    expand: (on = true) => { stmt.expand(on); return scoped; },
    safeIntegers: (on = true) => { stmt.safeIntegers(on); return scoped; },
    columns: () => stmt.columns(),
    get source() { return stmt.source; },
    get reader() { return stmt.reader; },
  };
  return scoped;
}

/**
 * The database as seen by the current user.
 * @param {import('better-sqlite3').Database} db  the shared database (a scoped one is unwrapped first)
 * @param {{ fallbackUid?: number|null }} [options]  who runs outside runAsUser: the owner for command-line scripts and
 *   tests; null (the server) makes a user-table query outside a request or job throw
 */
export function scopeDb(db, { fallbackUid = null } = {}) {
  const raw = db.unscoped ?? db;
  const userId = () => {
    const uid = currentUserId() ?? fallbackUid;
    if (!uid) throw new Error('This query needs a user, but it is running outside a request or job (runAsUser).');
    return uid;
  };
  return new Proxy(raw, {
    get(target, prop) {
      if (prop === 'prepare') return (sql) => scopeStatement(target.prepare(sql), userId);
      if (prop === 'unscoped') return target;
      if (prop === 'uid') return userId();
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
