-- v3 Phase 7 (PR 2): the app runs as separate processes (an API, a scheduler, and a worker per pool) sharing this database.
--   workers      one row per running worker process: its service, the pools it runs, its version, and a heartbeat it
--                renews every 15 seconds (tools/queue/workers.ts). Admin > Jobs lists the ones heard from lately. App-wide.
--   add          moves to the browser pool: it reads the posting page (the fetch half) and queues add-score, the Claude
--                half, as its child, so a browser worker never needs the Claude key. Its time limit covers the child.
--   add-score    scores a job just added and writes its materials when it is promoted or asked for.
--   notify       sends the owner an alert email (server/alerts.ts), so the scheduler holds no Google token.
CREATE TABLE workers (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  pools TEXT NOT NULL,
  version TEXT,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);

UPDATE task_types SET pool = 'browser', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 'add';
UPDATE task_types SET timeout_seconds = 2700 WHERE id = 'add' AND timeout_seconds = 900 AND updated_by IS NULL;
-- Waiting add tasks follow their type to the browser pool.
UPDATE task_runs SET pool = 'browser' WHERE type = 'add' AND status = 'queued';

INSERT INTO task_types (id, label, pool, priority, one_at_a_time, retry_limit, timeout_seconds, aging_minutes, updated_at) VALUES
  ('add-score', 'Add a job: score', 'ai', 50, 'none', 0, 1800, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('notify', 'Alert email', 'io', 60, 'none', 2, 120, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
