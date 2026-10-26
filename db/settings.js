// Key/value settings remembered between runs. app_settings is app-wide (alerts, the spending cap, the demo marker).

export function getSetting(db, key) {
  return db.prepare('SELECT value FROM app_settings WHERE key = ?').pluck().get(key) ?? null;
}

export function setSetting(db, key, value) {
  db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value, new Date().toISOString());
}

// A person's own settings (user_settings table): the inbox cursor, their Drive folders, their screen layouts. They are
// the current user's (db/scope.js), like every user table.

export function getUserSetting(db, key) {
  return db.prepare('SELECT value FROM user_settings WHERE user_id = @uid AND key = ?').pluck().get(key) ?? null;
}

export function setUserSetting(db, key, value) {
  db.prepare(`INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (@uid, ?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value, new Date().toISOString());
}

export function deleteUserSetting(db, key) {
  db.prepare('DELETE FROM user_settings WHERE user_id = @uid AND key = ?').run(key);
}
