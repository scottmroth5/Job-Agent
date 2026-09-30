// Key/value settings remembered between runs (app_settings table).

export function getSetting(db, key) {
  return db.prepare('SELECT value FROM app_settings WHERE key = ?').pluck().get(key) ?? null;
}

export function setSetting(db, key, value) {
  db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value, new Date().toISOString());
}
