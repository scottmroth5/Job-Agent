-- Admin > Jobs' starting values, after the load test (v3 Phase 6, PR 5; test/queue-load.test.js): the Claude pool keeps two
-- of its three workers for tasks people start, so two people's Claude tasks start at once while scheduled work runs.
-- Scheduled Claude work is the pipeline's score and letters steps, one at a time, so it still has its worker. Only a
-- pool still at 027's seed changes: a limit an admin set stays.
UPDATE pool_settings SET reserved_for_interactive = 2
WHERE pool = 'ai' AND concurrency = 3 AND per_user_concurrency = 2 AND reserved_for_interactive = 1 AND updated_by IS NULL;
