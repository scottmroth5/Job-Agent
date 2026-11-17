import type { Db } from '../db/engine/types.ts';

// A run still marked running after this long is assumed to have crashed.
const STALE_RUN_MS = 30 * 60 * 1000;

/**
 * Throws when another run with this name is in progress (overlapping runs can store
 * duplicates or score a posting twice). Uses agent-core's runs table.
 */
export async function assertNoRunningRun(db: Db, name: string, now = Date.now()) {
  const running = (await db
    .prepare('SELECT started_at FROM runs WHERE name = ? AND status = ? AND started_at > ? ORDER BY id DESC LIMIT 1')
    .get(name, 'running', new Date(now - STALE_RUN_MS).toISOString())) as { started_at: string } | undefined;
  if (running) throw new Error(`Another ${name} run (started ${running.started_at}) is still running. Wait for it to finish.`);
}
