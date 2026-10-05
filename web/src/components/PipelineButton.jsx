import { useCallback, useEffect, useState } from 'react';
import { api, followTask } from '../api.js';
import { dateTime } from '../format.js';

const STATUS = { ok: 'finished', partial: 'finished with warnings', failed: 'failed', aborted: 'stopped early' };

// Runs the whole pipeline (find, score, write materials, archive, email the report) and shows when it last ran.
export default function PipelineButton({ onFinished }) {
  const [state, setState] = useState(null);
  const [task, setTask] = useState(null);
  const [error, setError] = useState(null);

  const follow = useCallback(
    async (taskId) => {
      try {
        const final = await followTask(taskId, setTask);
        if (final.status === 'failed') setError(final.error);
      } catch (err) {
        setError(err.message);
      } finally {
        setTask(null);
        setState(await api.pipeline().catch(() => null));
        onFinished?.();
      }
    },
    [onFinished],
  );

  useEffect(() => {
    api
      .pipeline()
      .then((s) => {
        setState(s);
        if (s.taskId) follow(s.taskId); // a run started from this page before a reload
      })
      .catch(() => {});
  }, [follow]);

  // A run started from the command line: check back until it finishes.
  useEffect(() => {
    if (!state?.running || task) return undefined;
    const t = setInterval(() => api.pipeline().then(setState).catch(() => {}), 15000);
    return () => clearInterval(t);
  }, [state?.running, task]);

  const start = async () => {
    setError(null);
    try {
      const { taskId } = await api.runPipeline();
      follow(taskId);
    } catch (err) {
      setError(err.message);
    }
  };

  const busy = Boolean(task) || state?.running;
  const last = state?.lastFinished;
  const step = task?.steps?.at(-1)?.message;
  return (
    <div className="pipeline-run">
      <button className="primary" onClick={start} disabled={busy} title="Find, score, write materials, archive, and email the report">
        {busy ? 'Pipeline running…' : 'Run pipeline'}
      </button>
      <div className="muted small pipeline-status" aria-live="polite">
        {busy ? (step ?? (task ? 'Starting' : 'Started from the command line')) : last ? `Last run ${dateTime(last.finishedAt ?? last.startedAt)}, ${STATUS[last.status] ?? last.status}` : 'Not run yet'}
        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}
