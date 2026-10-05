// Long-running UI actions (run the pipeline, check the inbox, add a job, score, write materials) run in the
// background; the UI polls their progress and their output (the Activity tab). Kept in memory: a server
// restart forgets finished tasks, which is fine.

const KEEP = 100;
const MAX_LINES = 5000;

export function createTaskRunner() {
  const tasks = new Map();
  let next = 1;

  /**
   * Starts fn(step, { logger }) in the background and returns the task's id. step(message) records a progress
   * step; logger.info/warn/error(text) records an output line (pass it to createTracer to capture run logs).
   */
  function start(kind, meta, fn) {
    const id = String(next++);
    const task = { id, kind, meta, status: 'running', steps: [], log: [], result: null, error: null, startedAt: new Date().toISOString(), finishedAt: null };
    tasks.set(id, task);
    const line = (level, text) => {
      for (const l of String(text).split(/\r?\n/)) {
        if (task.log.length < MAX_LINES) task.log.push({ at: new Date().toISOString(), level, text: l });
        else if (task.log.length === MAX_LINES) task.log.push({ at: new Date().toISOString(), level: 'warn', text: `(output truncated at ${MAX_LINES} lines)` });
      }
    };
    const logger = { info: (t) => line('info', t), warn: (t) => line('warn', t), error: (t) => line('error', t), log: (t) => line('info', t) };
    // { log: false } records the step without an output line, when the output already has the original line.
    const step = (message, { log = true } = {}) => {
      task.steps.push({ at: new Date().toISOString(), message });
      if (log) line('step', message);
    };
    Promise.resolve()
      .then(() => fn(step, { logger }))
      .then((result) => Object.assign(task, { status: 'done', result: result ?? null }))
      .catch((err) => {
        Object.assign(task, { status: 'failed', error: err.message });
        line('error', err.message);
      })
      .finally(() => {
        task.finishedAt = new Date().toISOString();
        while (tasks.size > KEEP) tasks.delete(tasks.keys().next().value);
      });
    return id;
  }

  const brief = ({ log, ...t }) => ({ ...t, lines: log.length });

  return {
    start,
    /** A task without its output (polled every second while it runs). */
    get: (id) => {
      const t = tasks.get(String(id));
      return t ? brief(t) : null;
    },
    /** Output lines from index `from` on, so the UI fetches only what is new. */
    log: (id, from = 0) => {
      const t = tasks.get(String(id));
      return t ? { lines: t.log.slice(from), next: t.log.length, status: t.status, error: t.error } : null;
    },
    /** Recent tasks, newest first. */
    list: () => [...tasks.values()].reverse().map(brief),
    /** Resolves when a task finishes (tests and scripts). */
    async wait(id, timeoutMs = 10000) {
      const t0 = Date.now();
      while (tasks.get(String(id))?.status === 'running') {
        if (Date.now() - t0 > timeoutMs) throw new Error(`Task ${id} did not finish in time`);
        await new Promise((r) => setTimeout(r, 10));
      }
      return this.get(id);
    },
  };
}
