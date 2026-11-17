-- The durable job queue (v3 Phase 6; tools/queue/queue.ts, decision 0008). Background work becomes rows: a task survives a
-- restart, and the queue picks the next one by pool, priority, per-user limits and one-at-a-time rules.
--   task_types       app-wide settings per kind of work (Admin > Jobs edits them), with task_type_history
--   pool_settings    app-wide limits per pool: browser (Chromium), ai (Claude), io (outside services)
--   task_runs        one row per task: the queue entry and the task's record (a user table, row security on PostgreSQL)
--   task_lines       the task's output lines, numbered (a user table)
-- Booleans are 0/1 integers, JSON is text, times are ISO UTC text, as everywhere else.
CREATE TABLE task_types (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  pool TEXT NOT NULL CHECK (pool IN ('browser', 'ai', 'io')),
  priority INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  one_at_a_time TEXT NOT NULL DEFAULT 'none' CHECK (one_at_a_time IN ('none', 'user', 'app')),
  retry_limit INTEGER NOT NULL DEFAULT 0,
  timeout_seconds INTEGER NOT NULL,
  aging_minutes INTEGER,
  updated_by INTEGER,
  updated_at TEXT NOT NULL
);

CREATE TABLE task_type_history (
  id INTEGER PRIMARY KEY,
  type_id TEXT NOT NULL REFERENCES task_types(id),
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  changed_by INTEGER,
  changed_at TEXT NOT NULL
);
CREATE INDEX task_type_history_type ON task_type_history(type_id, id);

CREATE TABLE pool_settings (
  pool TEXT PRIMARY KEY CHECK (pool IN ('browser', 'ai', 'io')),
  concurrency INTEGER NOT NULL,
  per_user_concurrency INTEGER NOT NULL,
  reserved_for_interactive INTEGER NOT NULL,
  updated_by INTEGER,
  updated_at TEXT NOT NULL
);

CREATE TABLE task_runs (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL REFERENCES task_types(id),
  pool TEXT NOT NULL,
  priority INTEGER NOT NULL,
  interactive INTEGER NOT NULL DEFAULT 0 CHECK (interactive IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'dead', 'skipped', 'cancelled')),
  requested_by TEXT NOT NULL CHECK (requested_by IN ('user', 'schedule')),
  payload TEXT,
  result TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  run_after TEXT NOT NULL,
  depends_on TEXT,
  parent_id TEXT,
  worker TEXT,
  heartbeat_at TEXT,
  run_id INTEGER,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX task_runs_queue ON task_runs(status, pool, run_after);
CREATE INDEX task_runs_user ON task_runs(user_id, created_at);
CREATE INDEX task_runs_parent ON task_runs(parent_id);

CREATE TABLE task_lines (
  task_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  level TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (task_id, seq)
);
CREATE INDEX task_lines_user ON task_lines(user_id);

-- Starting values (the owner's plan, November 17, 2026). Interactive work (a user's own request) runs in a band above
-- every scheduled priority; reserved workers take only that band, so a hand-started task begins within seconds.
INSERT INTO pool_settings (pool, concurrency, per_user_concurrency, reserved_for_interactive, updated_at) VALUES
  ('browser', 2, 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('ai', 3, 2, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('io', 2, 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO task_types (id, label, pool, priority, one_at_a_time, retry_limit, timeout_seconds, aging_minutes, updated_at) VALUES
  ('add', 'Add a job', 'ai', 50, 'none', 0, 900, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('score', 'Score', 'ai', 50, 'none', 0, 900, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('write-materials', 'Write materials', 'ai', 50, 'none', 0, 1800, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('regenerate', 'Regenerate', 'ai', 50, 'none', 0, 1800, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('refetch', 'Fetch the description', 'browser', 50, 'none', 1, 300, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('meeting-prep', 'Meeting prep', 'ai', 50, 'none', 0, 1800, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('find-contact', 'Find someone to contact', 'ai', 50, 'none', 0, 900, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('inbox', 'Inbox check', 'io', 40, 'user', 1, 3600, 30, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('pipeline', 'Pipeline', 'io', 30, 'app', 0, 14400, 30, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('pipeline-discover', 'Pipeline: discover', 'browser', 30, 'app', 0, 7200, 30, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('pipeline-score', 'Pipeline: score', 'ai', 30, 'app', 0, 7200, 30, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('pipeline-hunt', 'Pipeline: letters', 'ai', 30, 'app', 0, 7200, 30, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('pipeline-archive', 'Pipeline: archive', 'io', 30, 'app', 0, 1800, 30, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('pipeline-report', 'Pipeline: report', 'io', 30, 'app', 1, 900, 30, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('backup', 'Backup', 'io', 20, 'app', 1, 3600, 60, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('restore-test', 'Restore test', 'io', 20, 'app', 1, 3600, 60, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
