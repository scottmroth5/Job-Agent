import { asEngine } from './engine/index.ts';
import type { AnyDb } from './engine/index.ts';

// Key/value settings remembered between runs. app_settings is app-wide (alerts, the spending cap, the demo marker).

export async function getSetting(db: AnyDb, key: string): Promise<string | null> {
  return ((await asEngine(db).prepare('SELECT value FROM app_settings WHERE key = ?').pluck().get(key)) as string | undefined) ?? null;
}

export async function setSetting(db: AnyDb, key: string, value: string | null) {
  await asEngine(db)
    .prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, value, new Date().toISOString());
}

// A person's own settings (user_settings table): the inbox cursor, their Drive folders, their screen layouts. They are
// the current user's (db/scope.ts), like every user table.

export async function getUserSetting(db: AnyDb, key: string): Promise<string | null> {
  return ((await asEngine(db).prepare('SELECT value FROM user_settings WHERE user_id = @uid AND key = ?').pluck().get(key)) as string | undefined) ?? null;
}

export async function setUserSetting(db: AnyDb, key: string, value: string | null) {
  await asEngine(db)
    .prepare(`INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (@uid, ?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, value, new Date().toISOString());
}

export async function deleteUserSetting(db: AnyDb, key: string) {
  await asEngine(db).prepare('DELETE FROM user_settings WHERE user_id = @uid AND key = ?').run(key);
}

/**
 * In one transaction: reads an app-wide setting and, when take(current) is true, sets it to next. Returns whether it
 * did. For marks like "alerted today", so two callers at once can not both see the old value and both act.
 */
export async function claimSetting(db: AnyDb, key: string, next: string, take: (current: string | null) => boolean): Promise<boolean> {
  const q = asEngine(db);
  return q.tx(async () => {
    if (!take(await getSetting(q, key))) return false;
    await setSetting(q, key, next);
    return true;
  });
}
