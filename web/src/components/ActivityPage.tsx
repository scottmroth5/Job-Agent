import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { dateTime } from '../format.ts';
import type { ApiResponse } from '../api.ts';

type TaskSummary = ApiResponse<'GET /api/tasks'>[number];
type LogLine = { at: string; level: string; text: string };
/** The log's latest answer, or a failure to reach it. */
type LogState = { status: string; error?: string | null; next?: number };

const KIND_LABELS: Record<string, string | undefined> = {
  pipeline: 'Run pipeline',
  inbox: 'Check inbox',
  add: 'Add job',
  score: 'Re-score',
  'write-materials': 'Write materials',
  regenerate: 'Regenerate letter and tweaks',
  refetch: 'Refetch posting',
};
const STATUS_TEXT: Record<string, string | undefined> = { running: 'running', done: 'finished', failed: 'failed' };

export const taskLabel = (t: { kind: string; meta?: { id?: number | string } | null }) => `${KIND_LABELS[t.kind] ?? t.kind}${t.meta?.id ? ` (job #${t.meta.id})` : ''}`;

const time = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '');

/** Live output of one task, fetched in pieces (only new lines) while it runs. */
function TaskOutput({ id, onFinished }: { id: string; onFinished?: () => void }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [state, setState] = useState<LogState | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    let next = 0;
    let stop = false;
    setLines([]);
    setState(null);
    stick.current = true;
    const poll = async () => {
      try {
        const r = await api.taskLog(id, next);
        if (stop) return;
        next = r.next;
        if (r.lines.length) setLines((l) => [...l, ...r.lines]);
        setState(r);
        if (r.status === 'running') setTimeout(poll, 1000);
        else onFinished?.();
      } catch (err) {
        if (!stop) setState({ status: 'failed', error: (err as Error).message });
      }
    };
    void poll();
    return () => {
      stop = true;
    };
  }, [id]);

  // Follow new output unless you scrolled up to read.
  useEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines]);

  return (
    <div
      className="console"
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      aria-live="polite"
    >
      {lines.map((l, i) => (
        <div key={i} className={`console-line ${l.level}`}>
          <span className="console-time">{time(l.at)}</span>
          {l.text}
        </div>
      ))}
      {state?.status === 'running' && <div className="console-line muted">⏳ running…</div>}
      {lines.length === 0 && state && state.status !== 'running' && <div className="console-line muted">No output.</div>}
    </div>
  );
}

// Activity: output of the actions started from this web page (pipeline, inbox checks, adds, re-scores...).
export default function ActivityPage({ selectedId }: { selectedId: string | null }) {
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useRef<(() => Promise<unknown>) | null>(null);

  useEffect(() => {
    let stop = false;
    const load = () =>
      api
        .tasks()
        .then((t) => !stop && setTasks(t))
        .catch((err) => !stop && setError((err as Error).message));
    void load();
    reload.current = load;
    const timer = setInterval(load, 3000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, []);

  if (!tasks) return error ? <div className="error">{error}</div> : <p className="muted">Loading…</p>;
  const current = tasks.find((t) => t.id === selectedId) ?? tasks[0];

  return (
    <div className="activity">
      <p className="muted small">
        Actions started from this web page since its server started. A run started in a terminal (npm run pipeline) shows its output in that terminal.
      </p>
      {tasks.length === 0 ? (
        <p className="muted">Nothing has run yet. Use Run pipeline, Check inbox, or a job's actions.</p>
      ) : (
        <div className="activity-grid">
          <nav className="activity-list" aria-label="Recent actions">
            {tasks.map((t) => (
              <a key={t.id} href={`#/activity/${t.id}`} className={t.id === current.id ? 'on' : ''}>
                <span className={`dot ${t.status}`} aria-hidden="true" />
                <span>
                  <b>{taskLabel(t)}</b>
                  <span className="muted small">
                    {' '}
                    {dateTime(t.startedAt)} · {STATUS_TEXT[t.status] ?? t.status}
                  </span>
                </span>
              </a>
            ))}
          </nav>
          <div className="activity-output">
            <div className="activity-head">
              <b>{taskLabel(current)}</b>
              <span className="muted small">
                {' '}
                started {dateTime(current.startedAt)}
                {current.finishedAt ? `, ${STATUS_TEXT[current.status]} at ${time(current.finishedAt)}` : ''}
              </span>
              {current.error && <div className="error">{current.error}</div>}
            </div>
            <TaskOutput key={current.id} id={current.id} onFinished={() => reload.current?.()} />
          </div>
        </div>
      )}
    </div>
  );
}
