import { useEffect, useState } from 'react';
import { api } from '../api.js';

const usd = (n) => `$${Number(n ?? 0).toFixed(2)}`;
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const ago = (iso) => {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return mins <= 1 ? 'just now' : `${mins} minutes ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} hours ago`;
  return day(iso);
};
// Which decisions each status offers, as [decision, button label, needs a confirm].
const ACTIONS = {
  pending: [['approve', 'Approve', false], ['reject', 'Reject', true]],
  active: [['pause', 'Pause', true]],
  paused: [['resume', 'Resume', false]],
  rejected: [['approve', 'Approve after all', true]],
};

/** A user's setup at a glance: what is done, and what they still need for their pipeline. */
function Setup({ u }) {
  const items = [
    [u.setup.searchReady, 'search'],
    [u.setup.profileReady, 'About you'],
    [u.aiSource === 'owner' || u.hasKey, u.aiSource === 'owner' ? 'on your key' : 'own key'],
    [u.setup.scheduled, 'on the schedule'],
  ];
  return (
    <p className="setup-chips">
      {items.map(([done, label]) => (
        <span key={label} className={`chip ${done ? 'used' : ''}`}>
          {done ? '✓' : '·'} {label}
        </span>
      ))}
    </p>
  );
}

function AiSetup({ user, onSaved }) {
  const [source, setSource] = useState(user.aiSource);
  const [cap, setCap] = useState(user.aiCapUsd ?? 10);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const granting = source === 'owner' && user.aiSource !== 'owner';
  const changed = source !== user.aiSource || (source === 'owner' && Number(cap) !== user.aiCapUsd);
  const save = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      await api.setUserAi(user.id, source, source === 'owner' ? Number(cap) : null, granting ? confirm.trim() : undefined);
      setConfirm('');
      onSaved();
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <form className="row ai-setup" onSubmit={save}>
      <label>
        AI paid by
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="own">Their own key{user.hasKey ? ' (saved)' : ' (none yet)'}</option>
          <option value="owner">Your key, with a monthly cap</option>
        </select>
      </label>
      {source === 'owner' && (
        <label>
          Cap ($ a month)
          <input type="number" min="1" step="1" value={cap} onChange={(e) => setCap(e.target.value)} />
        </label>
      )}
      {granting && (
        <label>
          Type {user.email} to confirm
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" spellCheck="false" />
        </label>
      )}
      <button
        type="submit"
        disabled={!changed || (source === 'owner' && !(Number(cap) > 0)) || (granting && confirm.trim().toLowerCase() !== user.email)}
      >
        Save
      </button>
      {error && <span className="error">{error}</span>}
    </form>
  );
}

function Feedback() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const refresh = () => api.adminFeedback().then(setItems, (err) => setError(err.message));
  useEffect(() => {
    refresh();
  }, []);
  if (!items) return error ? <div className="error">{error}</div> : null;
  const open = items.filter((f) => f.status === 'open');
  return (
    <section className="feedback-admin">
      <h3>Feedback {open.length ? `(${open.length} open)` : ''}</h3>
      {!items.length && <p className="muted small">No feedback yet. Users send it from Settings; it is emailed to you too.</p>}
      <ul className="user-list">
        {items.map((f) => (
          <li key={f.id} className={`user-card ${f.status === 'done' ? 'status-rejected' : ''}`}>
            <div className="user-head">
              <span>
                <b>{f.name || f.email}</b> <span className="muted small">{ago(f.createdAt)}{f.page ? ` · ${f.page}` : ''}</span>
              </span>
              {f.status === 'open' ? (
                <button type="button" onClick={() => api.feedbackDone(f.id).then(refresh, (err) => setError(err.message))}>
                  Mark done
                </button>
              ) : (
                <span className="muted small">done</span>
              )}
            </div>
            <p className="request-note">{f.body}</p>
          </li>
        ))}
      </ul>
      {error && <div className="error">{error}</div>}
    </section>
  );
}

/** Admin > Users: requests for access, accounts and how far each has got, how each user's AI is paid for, and feedback. */
export default function UsersAdmin() {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  const refresh = () => api.users().then(setUsers, (err) => setError(err.message));
  useEffect(() => {
    refresh();
  }, []);

  const decide = async (user, decision, confirmFirst) => {
    if (confirmFirst && !window.confirm(`${decision[0].toUpperCase()}${decision.slice(1)} ${user.email}?`)) return;
    setError(null);
    try {
      await api.decideUser(user.id, decision);
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  if (!users) return error ? <div className="error">{error}</div> : <p className="muted">Loading…</p>;
  const waiting = users.filter((u) => u.status === 'pending').length;
  return (
    <div className="users-admin">
      <p className="muted small">
        People sign in with Google and ask for access; approving one emails them. {waiting ? `${waiting} waiting.` : 'No requests waiting.'}
      </p>
      {error && <div className="error">{error}</div>}
      <ul className="user-list">
        {users.map((u) => (
          <li key={u.id} className={`user-card status-${u.status}`}>
            <div className="user-head">
              <div>
                <b>{u.name || u.email || 'You'}</b>
                {u.name && u.email && <span className="muted"> {u.email}</span>}
                {u.owner && <span className="badge"> owner</span>}
              </div>
              <span className={`status status-${u.status}`}>{u.status}</span>
            </div>
            {u.requestNote && <p className="request-note">“{u.requestNote}”</p>}
            <p className="muted small">
              Joined {day(u.createdAt)} · last seen {ago(u.lastSeenAt)} · {u.jobs} jobs · AI this month {usd(u.spentUsd)}
              {u.aiSource === 'owner' && !u.owner ? ` of ${usd(u.aiCapUsd)} on your key` : ''}
              {u.lastRun ? ` · last pipeline ${ago(u.lastRun.startedAt)} (${u.lastRun.status})` : ''}
            </p>
            {u.setup && ['active', 'paused'].includes(u.status) && <Setup u={u} />}
            {!u.owner && (
              <div className="row">
                {(ACTIONS[u.status] ?? []).map(([decision, label, confirmFirst]) => (
                  <button key={decision} type="button" className={decision === 'approve' ? 'primary' : ''} onClick={() => decide(u, decision, confirmFirst)}>
                    {label}
                  </button>
                ))}
              </div>
            )}
            {!u.owner && ['active', 'paused'].includes(u.status) && <AiSetup user={u} onSaved={refresh} />}
          </li>
        ))}
      </ul>
      <Feedback />
    </div>
  );
}
