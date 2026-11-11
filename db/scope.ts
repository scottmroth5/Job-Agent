// One user's view of the shared database (multi-user, phase 1). Every query on a user table says "user_id = @uid"
// (and every insert gives user_id the value @uid); the engine (db/engine) binds @uid to the user the current request or
// job runs as. The user comes from an AsyncLocalStorage context (runAsUser), so routes, agents, and tasks keep taking
// `db` and every promise a request starts runs as that request's user. A statement that names @uid when there is no
// user throws instead of reading everyone's rows; statements on app-wide tables (lookups, app_settings, runs) never
// name @uid and run anywhere. test/user-scope.test.js checks that every query on a user table names user_id.
import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage<{ uid: number; timeZone: string | null }>();

/**
 * Runs fn (and everything it starts) as user uid; returns what fn returns. timeZone is that user's own zone (an IANA
 * name), which tools/dates.ts uses for their calendar days; without it, the app's zone.
 */
export function runAsUser<T>(uid: number, fn: () => T, { timeZone = null }: { timeZone?: string | null } = {}): T {
  if (!Number.isInteger(uid) || uid < 1) throw new TypeError(`runAsUser: "${uid}" is not a user id`);
  return context.run({ uid, timeZone }, fn);
}

/** The current user's own time zone, or null (the app's zone). */
export const currentTimeZone = () => context.getStore()?.timeZone ?? null;

/** The user the current request or job runs as, or null outside runAsUser. */
export const currentUserId = () => context.getStore()?.uid ?? null;

const isPlainObject = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v);

/**
 * A statement's bind values with @uid added when its SQL names @uid (userId is read now, so it throws outside a user).
 * Named values travel in one plain object: uid is added to it, or passed in one holding only uid after the positional
 * values. unknown[]: the bind values better-sqlite3 takes (numbers, strings, buffers, null, or one object of names).
 * Used by the async engine (db/engine/sqlite.ts) for every statement.
 */
export function bindUid(source: string, args: unknown[], userId: () => number): unknown[] {
  if (!source.includes('@uid')) return args;
  const uid = userId();
  const i = args.findIndex(isPlainObject);
  if (i < 0) return [...args, { uid }];
  const copy = [...args];
  copy[i] = { ...(args[i] as object), uid };
  return copy;
}

/** A reader of the user a query runs as: currentUserId(), else fallbackUid; it throws when there is neither. */
export function userIdOr(fallbackUid: number | null): () => number {
  return () => {
    const uid = currentUserId() ?? fallbackUid;
    if (!uid) throw new Error('This query needs a user, but it is running outside a request or job (runAsUser).');
    return uid;
  };
}

