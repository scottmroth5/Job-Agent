import { useCallback, useEffect, useState } from 'react';
import { api, followTask } from '../api.js';
import { STATUS_LABELS, dateTime } from '../format.js';
import TaskProgress from './TaskProgress.jsx';

export const TYPE_LABELS = {
  confirmation: 'Application received',
  rejection: 'Rejection',
  recruiter_outreach: 'Recruiter outreach',
  interview_request: 'Interview request',
  assessment: 'Assessment',
  offer: 'Offer',
  follow_up: 'Follow-up',
  other: 'Other',
};
const RULES = { thread: 'same thread', contact: 'known contact', domain: 'company domain', ats_subject: 'subject', model: 'Claude', user: 'you' };

function ReviewCard({ email, applications, onDone, onOpenJob }) {
  const [reassigning, setReassigning] = useState(false);
  const [postingId, setPostingId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const resolve = async (choice, id) => {
    setBusy(true);
    setError(null);
    try {
      onDone(await api.reviewEmail(email.id, choice, id), email);
    } catch (err) {
      setError(err.message);
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
        {email.reason ? `Why: ${email.reason}. ` : ''}Confidence {Number(email.confidence ?? 0).toFixed(2)}
      </div>
      <div className="small">
        Best guess:{' '}
        {email.guess ? (
          <button className="link" onClick={() => onOpenJob(email.guess.id)}>
            {email.guess.title} at {email.guess.company} ({STATUS_LABELS[email.guess.status] ?? email.guess.status})
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
                {a.company}: {a.title} ({STATUS_LABELS[a.status] ?? a.status})
              </option>
            ))}
          </select>
          <button className="primary" disabled={!postingId || busy} onClick={() => resolve('reassign', Number(postingId))}>Link</button>
          <button onClick={() => setReassigning(false)}>Cancel</button>
        </div>
      ) : (
        <div className="row inbox-actions">
          {email.guess && <button className="primary" disabled={busy} onClick={() => resolve('confirm')}>Confirm guess</button>}
          <button disabled={busy} onClick={() => setReassigning(true)}>Link to another job</button>
          <button disabled={busy} onClick={() => resolve('opportunity')}>New opportunity</button>
          <button disabled={busy} onClick={() => resolve('not_job')}>Not job related</button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

// Inbox: check Gmail, resolve emails the agent was unsure about, and keep track of reminders.
export default function InboxPage({ onOpenJob, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [task, setTask] = useState(null);
  const [messages, setMessages] = useState([]);

  const load = useCallback(async () => {
    try {
      setData(await api.inbox());
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  const follow = useCallback(
    async (taskId) => {
      const final = await followTask(taskId, setTask).catch((err) => ({ status: 'failed', error: err.message, steps: [] }));
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
        if (d.checkTaskId) follow(d.checkTaskId);
      })
      .catch((err) => setError(err.message));
  }, [follow]);

  const check = async () => {
    setError(null);
    setMessages([]);
    try {
      const { taskId } = await api.checkInbox();
      follow(taskId);
    } catch (err) {
      setError(err.message);
    }
  };

  const reviewed = async (r, email) => {
    const notes = [];
    if (r.statusChange) notes.push(`Status changed: ${STATUS_LABELS[r.statusChange.from]} to ${STATUS_LABELS[r.statusChange.to]}`);
    if (r.review) notes.push(`Status not changed: ${r.review}. Change it on the job if needed.`);
    notes.push(...r.notices);
    setMessages(notes.length ? notes.map((n) => `${email.subject || 'Email'}: ${n}`) : []);
    await load();
    onChanged?.();
  };

  const closeReminder = async (id, status) => {
    await api.closeReminder(id, status).catch((err) => setError(err.message));
    await load();
  };

  if (!data) return error ? <div className="error">{error}</div> : <p className="muted">Loading…</p>;
  const running = task?.status === 'running';

  return (
    <div className="inbox">
      <div className="inbox-top">
        <button className="primary" onClick={check} disabled={running || !data.signedIn}>{running ? 'Checking…' : 'Check inbox'}</button>
        <span className="muted small">
          {data.signedIn
            ? data.lastCheck
              ? `Last checked ${dateTime(data.lastCheck.finishedAt ?? data.lastCheck.startedAt)}${data.lastCheck.status === 'failed' ? ' (that check failed; run npm run inbox in a terminal to see why)' : data.lastCheck.status === 'partial' ? ' (some emails failed and will be retried)' : data.lastCheck.status === 'running' ? ' (still running)' : ''}`
              : 'Not checked yet; the first check reads the last 7 days.'
            : 'Gmail is not signed in. Run "npm run inbox:auth" in the Job-Agent folder, then restart the web page server.'}
        </span>
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
          data.needsReview.map((e) => <ReviewCard key={e.id} email={e} applications={data.openApplications} onDone={reviewed} onOpenJob={onOpenJob} />)
        )}
      </section>

      <section>
        <h3>Reminders ({data.reminders.length})</h3>
        {data.reminders.length === 0 ? (
          <p className="muted">No open reminders.</p>
        ) : (
          <table className="history">
            <tbody>
              {data.reminders.map((r) => (
                <tr key={r.id}>
                  <td>{r.kind === 'assessment' ? 'Assessment' : 'Interview'}</td>
                  <td>
                    <button className="link" onClick={() => onOpenJob(r.postingId)}>{r.title} at {r.company}</button>
                  </td>
                  <td className="muted">{r.note ?? ''}{r.dueAt ? ` (due ${dateTime(r.dueAt)})` : ''}</td>
                  <td className="nowrap">
                    <button onClick={() => closeReminder(r.id, 'done')}>Done</button> <button onClick={() => closeReminder(r.id, 'dismissed')}>Dismiss</button>
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
              {data.recent.map((e) => (
                <tr key={e.id}>
                  <td className="nowrap muted">{dateTime(e.sentAt)}</td>
                  <td><span className={`badge type-${e.type}`}>{TYPE_LABELS[e.type] ?? e.type}</span></td>
                  <td>
                    <button className="link" onClick={() => onOpenJob(e.postingId)}>{e.title} at {e.company}</button>
                    <div className="muted small">{e.subject}</div>
                  </td>
                  <td className="muted small">{STATUS_LABELS[e.status] ?? e.status} · matched by {RULES[e.matchRule] ?? 'review'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
