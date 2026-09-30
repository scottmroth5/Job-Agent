// Long-running UI actions (add a job, score, write materials) run in the background; the UI
// polls their progress. Kept in memory: a server restart forgets finished tasks, which is fine.

const KEEP = 100;

export function createTaskRunner() {
  const tasks = new Map();
  let next = 1;

  /** Starts fn(step) in the background and returns the task's id. */
  function start(kind, meta, fn) {
    const id = String(next++);
    const task = { id, kind, meta, status: 'running', steps: [], result: null, error: null, startedAt: new Date().toISOString(), finishedAt: null };
    tasks.set(id, task);
    const step = (message) => task.steps.push({ at: new Date().toISOString(), message });
    Promise.resolve()
      .then(() => fn(step))
      .then((result) => Object.assign(task, { status: 'done', result: result ?? null }))
      .catch((err) => Object.assign(task, { status: 'failed', error: err.message }))
      .finally(() => {
        task.finishedAt = new Date().toISOString();
        while (tasks.size > KEEP) tasks.delete(tasks.keys().next().value);
      });
    return id;
  }

  return {
    start,
    get: (id) => tasks.get(String(id)) ?? null,
    /** Resolves when a task finishes (tests and scripts). */
    async wait(id, timeoutMs = 10000) {
      const t0 = Date.now();
      while (tasks.get(String(id))?.status === 'running') {
        if (Date.now() - t0 > timeoutMs) throw new Error(`Task ${id} did not finish in time`);
        await new Promise((r) => setTimeout(r, 10));
      }
      return tasks.get(String(id));
    },
  };
}
