import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../api.ts';
import { dateTime } from '../format.ts';

// Admin > Jobs: the background task queue (tools/queue), app-wide. Each pool's load and limits, the task types (their
// priority, on or off, one at a time, retries, time limit, aging) with recent changes, dead letters to retry or
// discard, and totals by type. A dead letter shows its kind, account, and error only.

type Pool = { pool: string; concurrency: number; perUser: number; reserved: number; running: number; waiting: number; failedToday: number; oldestWaitSeconds: number | null };
type TaskType = { id: string; label: string; pool: string; priority: number; enabled: boolean; oneAtATime: 'none' | 'user' | 'app'; retryLimit: number; timeoutSeconds: number; agingMinutes: number | null };
type Change = { typeId: string; field: string; oldValue: string | null; newValue: string | null; changedAt: string; changedBy: string | null };
type Dead = { id: string; type: string; attempts: number; error: string | null; finishedAt: string | null; user: string | null };
type Total = { type: string; tasks: number; done: number; failed: number; meanSeconds: number | null; costUsd: number };
type Jobs = { pools: Pool[]; types: TaskType[]; history: Change[]; dead: Dead[]; totals: Total[]; days: number };

const POOL_LABELS: Record<string, string | undefined> = { browser: 'Browser', ai: 'Claude', io: 'Outside services' };
const ONCE_LABELS: Record<string, string> = { none: 'No', user: 'Per user', app: 'Across the app' };
const FIELD_LABELS: Record<string, string | undefined> = {
  priority: 'priority',
  enabled: 'on',
  one_at_a_time: 'one at a time',
  retry_limit: 'retries',
  timeout_seconds: 'time limit',
  aging_minutes: 'aging',
};

const duration = (s: number | null) => {
  if (s == null) return '';
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 360) / 10} h`;
};
const num = (v: string) => (v.trim() === '' ? NaN : Number(v));

function PoolRow({ p, onSaved, onError }: { p: Pool; onSaved: () => void; onError: (m: string) => void }) {
  const [d, setD] = useState({ concurrency: String(p.concurrency), perUser: String(p.perUser), reserved: String(p.reserved) });
  const changed = d.concurrency !== String(p.concurrency) || d.perUser !== String(p.perUser) || d.reserved !== String(p.reserved);
  const name = POOL_LABELS[p.pool] ?? p.pool;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.setPool(p.pool, { concurrency: num(d.concurrency), perUser: num(d.perUser), reserved: num(d.reserved) });
      onSaved();
    } catch (err) {
      onError((err as Error).message);
    }
  };
  const field = (k: keyof typeof d, label: string) => (
    <input type="number" min="0" step="1" aria-label={`${name}: ${label}`} value={d[k]} onChange={(e) => setD({ ...d, [k]: e.target.value })} className="num-input" />
  );
  return (
    <tr>
      <th scope="row">{name}</th>
      <td>{p.running}</td>
      <td>{p.waiting}</td>
      <td>{duration(p.oldestWaitSeconds)}</td>
      <td>{p.failedToday}</td>
      <td>{field('concurrency', 'workers')}</td>
      <td>{field('perUser', 'per user')}</td>
      <td>{field('reserved', 'reserved for tasks people start')}</td>
      <td>
        <form onSubmit={save}>
          <button type="submit" disabled={!changed} aria-label={`Save ${name} limits`}>
            Save
          </button>
        </form>
      </td>
    </tr>
  );
}

function TypeRow({ t, onSaved, onError }: { t: TaskType; onSaved: () => void; onError: (m: string) => void }) {
  const initial = { priority: String(t.priority), enabled: t.enabled, oneAtATime: t.oneAtATime, retryLimit: String(t.retryLimit), timeoutSeconds: String(t.timeoutSeconds), agingMinutes: t.agingMinutes == null ? '' : String(t.agingMinutes) };
  const [d, setD] = useState(initial);
  const [apply, setApply] = useState(true);
  const changed = (Object.keys(initial) as Array<keyof typeof initial>).filter((k) => d[k] !== initial[k]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.setTaskType(t.id, {
        ...(changed.includes('priority') ? { priority: num(d.priority), applyToWaiting: apply } : {}),
        ...(changed.includes('enabled') ? { enabled: d.enabled } : {}),
        ...(changed.includes('oneAtATime') ? { oneAtATime: d.oneAtATime } : {}),
        ...(changed.includes('retryLimit') ? { retryLimit: num(d.retryLimit) } : {}),
        ...(changed.includes('timeoutSeconds') ? { timeoutSeconds: num(d.timeoutSeconds) } : {}),
        ...(changed.includes('agingMinutes') ? { agingMinutes: d.agingMinutes.trim() === '' ? null : num(d.agingMinutes) } : {}),
      });
      onSaved();
    } catch (err) {
      onError((err as Error).message);
    }
  };
  const text = (k: 'priority' | 'retryLimit' | 'timeoutSeconds' | 'agingMinutes', label: string) => (
    <input type="number" min="0" step="1" aria-label={`${t.label}: ${label}`} value={d[k]} onChange={(e) => setD({ ...d, [k]: e.target.value })} className="num-input" />
  );
  return (
    <tr>
      <th scope="row">{t.label}</th>
      <td>{POOL_LABELS[t.pool] ?? t.pool}</td>
      <td>
        {text('priority', 'priority')}
        {changed.includes('priority') && (
          <label className="small">
            <input type="checkbox" checked={apply} onChange={(e) => setApply(e.target.checked)} /> Apply to waiting tasks
          </label>
        )}
      </td>
      <td>
        <input type="checkbox" aria-label={`${t.label}: on`} checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.target.checked })} />
      </td>
      <td>
        <select aria-label={`${t.label}: one at a time`} value={d.oneAtATime} onChange={(e) => setD({ ...d, oneAtATime: e.target.value as TaskType['oneAtATime'] })}>
          {Object.entries(ONCE_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </td>
      <td>{text('retryLimit', 'retries')}</td>
      <td>{text('timeoutSeconds', 'time limit in seconds')}</td>
      <td>{text('agingMinutes', 'aging in minutes (empty for none)')}</td>
      <td>
        <form onSubmit={save}>
          <button type="submit" disabled={!changed.length} aria-label={`Save ${t.label}`}>
            Save
          </button>
        </form>
      </td>
    </tr>
  );
}

export default function JobsAdmin() {
  const [jobs, setJobs] = useState<Jobs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [version, setVersion] = useState(0); // remounts the rows after a save, so their drafts start from what is stored

  const load = async () => {
    try {
      setJobs((await api.adminJobs()) as Jobs);
      setVersion((v) => v + 1);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  useEffect(() => {
    void load(); // load reports its own errors
  }, []);
  const saved = (message: string) => {
    setError(null);
    setNote(message);
    setTimeout(() => setNote(null), 2500);
    void load();
  };
  const act = async (fn: () => Promise<unknown>, message: string) => {
    try {
      await fn();
      saved(message);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!jobs) return error ? <div className="error">{error}</div> : <p className="muted">Loading…</p>;
  const labelOf = (type: string) => jobs.types.find((t) => t.id === type)?.label ?? type;
  return (
    <div className="jobs-admin">
      <p className="muted small">
        Background tasks wait in a queue and run in three pools. A task someone starts goes ahead of scheduled work; reserved workers take only those. Waiting
        scheduled work moves up one priority level per aging period, so it is never stuck.{' '}
        <button type="button" className="link" onClick={() => void load()}>
          Refresh
        </button>
      </p>
      {error && <div className="error">{error}</div>}
      {note && (
        <p className="muted small" role="status">
          {note}
        </p>
      )}

      <h3>Pools</h3>
      <div className="usage-scroll">
        <table className="history">
          <thead>
            <tr>
              <th scope="col">Pool</th>
              <th scope="col">Running</th>
              <th scope="col">Waiting</th>
              <th scope="col">Oldest wait</th>
              <th scope="col">Failed today</th>
              <th scope="col">Workers</th>
              <th scope="col">Per user</th>
              <th scope="col">Reserved</th>
              <th scope="col">
                <span className="sr-only">Save</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {jobs.pools.map((p) => (
              <PoolRow key={`${p.pool}-${version}`} p={p} onSaved={() => saved('Pool limits saved.')} onError={setError} />
            ))}
          </tbody>
        </table>
      </div>

      <h3>Task types</h3>
      <div className="usage-scroll">
        <table className="history">
          <thead>
            <tr>
              <th scope="col">Type</th>
              <th scope="col">Pool</th>
              <th scope="col">Priority</th>
              <th scope="col">On</th>
              <th scope="col">One at a time</th>
              <th scope="col">Retries</th>
              <th scope="col">Time limit (s)</th>
              <th scope="col">Aging (min)</th>
              <th scope="col">
                <span className="sr-only">Save</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {jobs.types.map((t) => (
              <TypeRow key={`${t.id}-${version}`} t={t} onSaved={() => saved(`${t.label} saved.`)} onError={setError} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">Retries cost money for Claude tasks and could write a second letter, so those start at none. A type turned off refuses tasks people start and skips scheduled ones.</p>

      {jobs.history.length > 0 && (
        <>
          <h3>Recent changes</h3>
          <ul className="small">
            {jobs.history.slice(0, 15).map((h, i) => (
              <li key={i}>
                {dateTime(h.changedAt)}: {labelOf(h.typeId)} {FIELD_LABELS[h.field] ?? h.field} {h.oldValue ?? 'none'} to {h.newValue ?? 'none'}
                {h.changedBy ? `, by ${h.changedBy}` : ''}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Dead letters</h3>
      {jobs.dead.length ? (
        <div className="usage-scroll">
          <table className="history">
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Account</th>
                <th scope="col">Tries</th>
                <th scope="col">Error</th>
                <th scope="col">Gave up</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {jobs.dead.map((d) => (
                <tr key={d.id}>
                  <th scope="row">{labelOf(d.type)}</th>
                  <td>{d.user ?? ''}</td>
                  <td>{d.attempts}</td>
                  <td>{d.error ?? ''}</td>
                  <td>{dateTime(d.finishedAt)}</td>
                  <td className="row">
                    <button type="button" onClick={() => void act(() => api.retryTask(d.id), 'Queued to run again.')}>
                      Retry
                    </button>
                    <button type="button" onClick={() => void act(() => api.discardTask(d.id), 'Discarded.')}>
                      Discard
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted small">None: every task that ran out of retries has been dealt with.</p>
      )}

      <h3>Last {jobs.days} days by type</h3>
      {jobs.totals.length ? (
        <div className="usage-scroll">
          <table className="history">
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Tasks</th>
                <th scope="col">Done</th>
                <th scope="col">Failed</th>
                <th scope="col">Mean time</th>
                <th scope="col">Claude cost</th>
              </tr>
            </thead>
            <tbody>
              {jobs.totals.map((t) => (
                <tr key={t.type}>
                  <th scope="row">{labelOf(t.type)}</th>
                  <td>{t.tasks}</td>
                  <td>{t.done}</td>
                  <td>{t.failed}</td>
                  <td>{duration(t.meanSeconds)}</td>
                  <td>${t.costUsd.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted small">No tasks yet.</p>
      )}
      <p className="muted small">Claude cost counts the runs a task opened itself; the pipeline steps' and the inbox's runs are their own, and every call is on Spending.</p>
    </div>
  );
}
