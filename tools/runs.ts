import { asEngine } from '../db/engine/index.ts';
import type { AnyDb } from '../db/engine/index.ts';

// A run still marked running after this long is assumed to have crashed.
const STALE_RUN_MS = 30 * 60 * 1000;

/**
 * Throws when another run with this name is in progress (overlapping runs can store
 * duplicates or score a posting twice). Uses agent-core's runs table.
 */
export async function assertNoRunningRun(db: AnyDb, name: string, now = Date.now()) {
  const running = (await asEngine(db)
    .prepare('SELECT started_at FROM runs WHERE name = ? AND status = ? AND started_at > ? ORDER BY id DESC LIMIT 1')
    .get(name, 'running', new Date(now - STALE_RUN_MS).toISOString())) as { started_at: string } | undefined;
  if (running) throw new Error(`Another ${name} run (started ${running.started_at}) is still running. Wait for it to finish.`);
}

let starts: Promise<unknown> = Promise.resolve();

/**
 * Runs the server's task starts one at a time. A start awaits its checks (assertNoRunningRun) before it starts its task,
 * so two starts at once could both pass them; inside this lock the second waits until the first has marked its task
 * as running (tasks.start, the in-memory task id), and its checks then see it. Scripts run in their own processes and
 * keep only the runs table check, as before.
 */
export function oneStartAtATime<T>(start: () => Promise<T> | T): Promise<T> {
  const result = starts.then(start);
  starts = result.catch(() => {});
  return result;
}
