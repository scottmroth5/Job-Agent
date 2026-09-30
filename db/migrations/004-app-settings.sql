-- Small key/value settings the app remembers between runs (for example the cover letter Drive folder ID).
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL
);
