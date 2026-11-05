// Long-running UI actions (run the pipeline, check the inbox, add a job, score, write materials) run in the
// background; the UI polls their progress and their output (the Activity tab). Kept in memory: a server
// restart forgets finished tasks, which is fine. Each task belongs to the user it runs as (db/scope.ts); the routes
// show a user only their own (get, log, and list with { uid }), while the server's own checks see every task.
import { currentUserId } from '../db/scope.ts';
import { OWNER_ID } from '../db/users.ts';
import type { Logger } from '../tools/types.ts';

const KEEP = 100;
const MAX_LINES = 5000;

export type Task = {
  id: string;
  uid: number;
  kind: string;
  meta: object;
  status: 'running' | 'done' | 'failed';
  steps: Array<{ at: string; message: string }>;
  log: Array<{ at: string; level: string; text: string }>;
  result: unknown;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

/** A task's function: step(message) records progress, logger records output lines. */
export type TaskFn = (step: (message: string, opts?: { log?: boolean }) => void, ctx: { logger: Logger }) => unknown;

export function createTaskRunner() {
  const tasks = new Map<string, Task>();
  const finished = new Map<string, Promise<unknown>>(); // id -> promise that settles when the task ends
  let next = 1;

  /**
   * Starts fn(step, { logger }) in the background and returns the task's id. step(message) records a progress
   * step; logger.info/warn/error(text) records an output line (pass it to createJobTracer to capture run logs).
   */
  function start(kind: string, meta: object, fn: TaskFn) {
    const id = String(next++);
    const task: Task = { id, uid: currentUserId() ?? OWNER_ID, kind, meta, status: 'running', steps: [], log: [], result: null, error: null, startedAt: new Date().toISOString(), finishedAt: null };
    tasks.set(id, task);
    const line = (level: string, text: unknown) => {
      for (const l of String(text).split(/\r?\n/)) {
        if (task.log.length < MAX_LINES) task.log.push({ at: new Date().toISOString(), level, text: l });
        else if (task.log.length === MAX_LINES) task.log.push({ at: new Date().toISOString(), level: 'warn', text: `(output truncated at ${MAX_LINES} lines)` });
      }
    };
    const logger = { info: (t: unknown) => line('info', t), warn: (t: unknown) => line('warn', t), error: (t: unknown) => line('error', t), log: (t: unknown) => line('info', t) };
    // { log: false } records the step without an output line, when the output already has the original line.
    const step = (message: string, { log = true } = {}) => {
      task.steps.push({ at: new Date().toISOString(), message });
      if (log) line('step', message);
    };
    const done = Promise.resolve()
      .then(() => fn(step, { logger }))
      .then((result) => Object.assign(task, { status: 'done', result: result ?? null }))
      .catch((err: Error) => {
        Object.assign(task, { status: 'failed', error: err.message });
        line('error', err.message);
      })
      .finally(() => {
        task.finishedAt = new Date().toISOString();
        while (tasks.size > KEEP) tasks.delete(tasks.keys().next().value as string);
        finished.delete(id);
      });
    finished.set(id, done);
    return id;
  }

  const brief = ({ log, uid, ...t }: Task) => ({ ...t, lines: log.length });
  // With a uid, only that user's task; without one (the server's own checks), any.
  const find = (id: string | number, uid?: number | null) => {
    const t = tasks.get(String(id));
    return t && (uid == null || t.uid === uid) ? t : null;
  };

  return {
    start,
    /** A task without its output (polled every second while it runs). */
    get: (id: string | number, { uid }: { uid?: number | null } = {}) => {
      const t = find(id, uid);
      return t ? brief(t) : null;
    },
    /** Output lines from index `from` on, so the UI fetches only what is new. */
    log: (id: string | number, from = 0, { uid }: { uid?: number | null } = {}) => {
      const t = find(id, uid);
      return t ? { lines: t.log.slice(from), next: t.log.length, status: t.status, error: t.error } : null;
    },
    /** Recent tasks, newest first. */
    list: ({ uid }: { uid?: number | null } = {}) => [...tasks.values()].reverse().filter((t) => uid == null || t.uid === uid).map(brief),
    /** Resolves with the task (done or failed) when it finishes (the scheduler, tests, and scripts). */
    async wait(id: string | number, timeoutMs = 10000) {
      const done = finished.get(String(id));
      if (done) {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`Task ${id} did not finish in time`)), timeoutMs);
        });
        try {
          await Promise.race([done, timeout]);
        } finally {
          clearTimeout(timer);
        }
      }
      return this.get(id);
    },
  };
}
