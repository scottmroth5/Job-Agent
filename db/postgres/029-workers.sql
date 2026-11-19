-- v3 Phase 7 (PR 2): the workers table, add in the browser pool, and the add-score and notify task types. The same
-- change as db/migrations/029-workers.sql (its comments say why).
CREATE TABLE workers (
  id text PRIMARY KEY,
  service text NOT NULL,
  pools text NOT NULL,
  version text,
  started_at text NOT NULL,
  heartbeat_at text NOT NULL
);

UPDATE task_types SET pool = 'browser', updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') WHERE id = 'add';
UPDATE task_types SET timeout_seconds = 2700 WHERE id = 'add' AND timeout_seconds = 900 AND updated_by IS NULL;
UPDATE task_runs SET pool = 'browser' WHERE type = 'add' AND status = 'queued';

WITH n AS (SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at)
INSERT INTO task_types (id, label, pool, priority, one_at_a_time, retry_limit, timeout_seconds, aging_minutes, updated_at)
SELECT v.id, v.label, v.pool, v.priority, v.once, v.retry, v.timeout, v.aging, n.at FROM n, (VALUES
  ('add-score', 'Add a job: score', 'ai', 50, 'none', 0, 1800, NULL::integer),
  ('notify', 'Alert email', 'io', 60, 'none', 2, 120, NULL)) AS v(id, label, pool, priority, once, retry, timeout, aging);
