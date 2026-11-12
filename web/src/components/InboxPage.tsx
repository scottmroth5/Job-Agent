import { useCallback, useEffect, useState } from 'react';
import { api, followTask } from '../api.ts';
import { dateTime } from '../format.ts';
import { useLookups } from '../lookups.tsx';
import TaskProgress from './TaskProgress.tsx';
import type { ApiBody, ApiResponse, Job, Task } from '../api.ts';

type Inbox = ApiResponse<'GET /api/inbox'>;
type Email = Inbox['needsReview'][number];
type Choice = ApiBody<'POST /api/inbox/emails/:id/review'>['choice'];
type Review = ApiResponse<'POST /api/inbox/emails/:id/review'>;

// How sure the model was of the job match (or that none applies). Emails at 0.85 or above link on their own, so
// anything here is below that; the number stays for anyone comparing.
const confidenceText = (c: number | null | undefined) => {
  const n = Number(c ?? 0);
  const level = n >= 0.7 ? 'Fairly sure' : n >= 0.4 ? 'Low confidence' : 'Very low confidence';
  return `${level} in the job match (${n.toFixed(2)})`;
};

export const TYPE_LABELS: Record<string, string | undefined> = {
  confirmation: 'Application received',
  rejection: 'Rejection',
  recruiter_outreach: 'Recruiter outreach',
  interview_request: 'Interview request',
  assessment: 'Assessment',
  offer: 'Offer',
  follow_up: 'Follow-up',
  other: 'Other',
};
const RULES: Record<string, string | undefined> = { thread: 'same thread', contact: 'known contact', domain: 'company domain', ats_subject: 'subject', model: 'Claude', user: 'you' };

function ReviewCard({ email, applications, onDone, onOpenJob }: {
  email: Email;
  applications: Array<{ id: Job['id']; company: string; title: string; status: string }>;
  onDone: (review: Review, email: Email) => Promise<void>;
  onOpenJob: (id: Job['id']) => void;
}) {
  const lk = useLookups();
  const [reassigning, setReassigning] = useState(false);
  const [postingId, setPostingId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolve = async (choice: Choice, id?: number) => {
    setBusy(true);
    setError(null);
    try {
      void onDone(await api.reviewEmail(email.id, choice, id), email); // shows the result and reloads the inbox, which catches its own errors
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="inbox-card">
      <div className="inbox-card-head">
        <span className={`badge type-${email.type}`}>{TYPE_LABELS[email.type] ?? email.type}</span>
        <span className="muted small">
          {dateTime(email.sentAt)} · {email.sender}
        </span>
      </div>
      <div className="inbox-subject">{email.subject || '(no subject)'}</div>
      {email.summary && <p>{email.summary}</p>}
      <div className="small muted">
        {email.reason ? `Why: ${email.reason}. ` : ''}{confidenceText(email.confidence)}
      </div>
      <div className="small">
        Best guess:{' '}
        {email.guess ? (
          <button className="link" onClick={() => onOpenJob(email.guess.id)}>
            {email.guess.title} at {email.guess.company} ({lk.label('status', email.guess.status)})
          </button>
        ) : (
          <span className="muted">none</span>
        )}
      </div>
      {reassigning ? (
        <div className="row inbox-actions">
          <select value={postingId} onChange={(e) => setPostingId(e.target.value)} aria-label="Job to link">
            <option value="">Choose a job…</option>
            {applications.map((a) => (
              <option key={a.id} value={a.id}>
                {a.company}: {a.title} ({lk.label('status', a.status)})
              </option>
            ))}
          </select>
          <button className="primary" disabled={!postingId || busy} onClick={() => resolve('reassign', Number(postingId))}>Link</button>
          <button onClick={() => setReassigning(false)}>Cancel</button>
        </div>
      ) : (
        <div className="row inbox-actions demo-hide">
          {email.guess && <button className="primary" disabled={busy} onClick={() => resolve('confirm')}>Confirm guess</button>}
          <button disabled={busy} onClick={() => setReassigning(true)}>Link to another job</button>
          <button disabled={busy} onClick={() => resolve('opportunity')}>New opportunity</button>
          <button disabled={busy} onClick={() => resolve('not_job')}>Not job related</button>
          <button disabled={busy} title="Not sure: take it off this list without linking it or changing anything" onClick={() => resolve('dismiss')}>
            Dismiss
          </button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

// Inbox: check Gmail, resolve emails the agent was unsure about, and keep track of reminders.
export default function InboxPage({ onOpenJob, onChanged }: { onOpenJob: (id: Job['id']) => void; onChanged?: () => void }) {
  const lk = useLookups();
  const [data, setData] = useState<Inbox | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  // Whether the inbox is checked on its own (Settings > Automatic runs); off shows Manual runs only.
  const [automatic, setAutomatic] = useState<boolean | null>(null);
  useEffect(() => {
    api.automation().then((a) => setAutomatic(a.on && Boolean(a.inbox && (a.inbox.schedule || (a.inbox.afterPipeline && a.pipeline)))), () => setAutomatic(null));
  }, []);

  const load = useCallback(async () => {
    try {
      setData(await api.inbox());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const follow = useCallback(
    async (taskId: string) => {
      const final = await followTask(taskId, setTask).catch((err: Error) => ({ status: 'failed', error: err.message, steps: [] as Task['steps'] }) as Task); // TaskProgress reads only these
      setTask(final);
      if (final.status === 'done') setMessages(final.result.notices ?? []);
      await load();
      onChanged?.();
    },
    [load, onChanged],
  );

  useEffect(() => {
    api
      .inbox()
      .then((d) => {
        setData(d);
        if (d.checkTaskId) void follow(d.checkTaskId);
      })
      .catch((err) => setError((err as Error).message));
  }, [follow]);

  const check = async () => {
    setError(null);
    setMessages([]);
    try {
      const { taskId } = await api.checkInbox();
      void follow(taskId);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const reviewed = async (r: Review, email: Email) => {
    const notes: string[] = [];
    if (r.statusChange) notes.push(`Status changed: ${lk.label('status', r.statusChange.from)} to ${lk.label('status', r.statusChange.to)}`);
    if (r.review) notes.push(`Status not changed: ${r.review}. Change it on the job if needed.`);
    notes.push(...r.notices);
    setMessages(notes.length ? notes.map((n) => `${email.subject || 'Email'}: ${n}`) : []);
    await load();
    onChanged?.();
  };

  const closeReminder = async (id: string, status: ApiBody<'PATCH /api/inbox/reminders/:id'>['status']) => {
    await api.closeReminder(id, status).catch((err) => setError((err as Error).message));
    await load();
  };

  if (!data) return error ? <div className="error">{error}</div> : <p className="muted">Loading…</p>;
  const running = task?.status === 'running';

  return (
    <div className="inbox">
      <div className="inbox-top demo-hide">
        <button className="primary" onClick={check} disabled={running || !data.signedIn}>{running ? 'Checking…' : 'Check inbox'}</button>
        <span className="muted small">
          {data.signedIn
            ? data.lastCheck
              ? `Last checked ${dateTime(data.lastCheck.finishedAt ?? data.lastCheck.startedAt)}${data.lastCheck.status === 'failed' ? ' (that check failed; run npm run inbox in a terminal to see why)' : data.lastCheck.status === 'partial' ? ' (some emails failed and will be retried)' : data.lastCheck.status === 'running' ? ' (still running)' : ''}`
              : 'Not checked yet; the first check reads the last 7 days.'
            : 'Gmail is not signed in. Run "npm run inbox:auth" in the Job-Agent folder, then restart the web page server.'}
        </span>
        {automatic === false && (
          <a href="#/settings" className="badge warn manual-badge" title="The inbox is not checked on its own. Change it under Settings > Automatic runs.">
            Manual runs only
          </a>
        )}
      </div>
      {task && <TaskProgress task={task} />}
      {error && <div className="error">{error}</div>}
      {messages.length > 0 && (
        <div className="warn-box">
          {messages.map((m, i) => (
            <div key={i}>{m}</div>
          ))}
        </div>
      )}

      <section>
        <h3>Needs review ({data.needsReview.length})</h3>
        {data.needsReview.length === 0 ? (
          <p className="muted">Nothing to review.</p>
        ) : (
          data.needsReview.map((e: Email) => <ReviewCard key={e.id} email={e} applications={data.openApplications} onDone={reviewed} onOpenJob={onOpenJob} />)
        )}
      </section>

      <section>
        <h3>Reminders ({data.reminders.length})</h3>
        {data.reminders.length === 0 ? (
          <p className="muted">No open reminders.</p>
        ) : (
          <table className="history">
            <tbody>
              {data.reminders.map((r: Inbox['reminders'][number]) => (
                <tr key={r.id}>
                  <td>{r.kind === 'assessment' ? 'Assessment' : 'Interview'}</td>
                  <td>
                    <button className="link" onClick={() => onOpenJob(r.postingId)}>{r.title} at {r.company}</button>
                  </td>
                  <td className="muted">{r.note ?? ''}{r.dueAt ? ` (due ${dateTime(r.dueAt)})` : ''}</td>
                  <td className="nowrap">
                    <span className="demo-hide"><button onClick={() => closeReminder(r.id, 'done')}>Done</button> <button onClick={() => closeReminder(r.id, 'dismissed')}>Dismiss</button></span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h3>Recent job email</h3>
        {data.recent.length === 0 ? (
          <p className="muted">No linked email yet.</p>
        ) : (
          <table className="history">
            <tbody>
              {data.recent.map((e: Inbox['recent'][number]) => (
                <tr key={e.id}>
                  <td className="nowrap muted">{dateTime(e.sentAt)}</td>
                  <td><span className={`badge type-${e.type}`}>{TYPE_LABELS[e.type] ?? e.type}</span></td>
                  <td>
                    <button className="link" onClick={() => onOpenJob(e.postingId)}>{e.title} at {e.company}</button>
                    <div className="muted small">{e.subject}</div>
                  </td>
                  <td className="muted small">Now {lk.label('status', e.status)} · matched by {RULES[e.matchRule] ?? 'review'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
