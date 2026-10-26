import { useEffect, useState } from 'react';
import { api } from '../api.js';

const usd = (n) => `$${Number(n ?? 0).toFixed(2)}`;
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
// Which decisions each status offers, as [decision, button label, needs a confirm].
const ACTIONS = {
  pending: [['approve', 'Approve', false], ['reject', 'Reject', true]],
  active: [['pause', 'Pause', true]],
  paused: [['resume', 'Resume', false]],
  rejected: [['approve', 'Approve after all', true]],
};

function AiSetup({ user, onSaved }) {
  const [source, setSource] = useState(user.aiSource);
  const [cap, setCap] = useState(user.aiCapUsd ?? 10);
  const [error, setError] = useState(null);
  const changed = source !== user.aiSource || (source === 'owner' && Number(cap) !== user.aiCapUsd);
  const save = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      await api.setUserAi(user.id, source, source === 'owner' ? Number(cap) : null);
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
      <button type="submit" disabled={!changed || (source === 'owner' && !(Number(cap) > 0))}>
        Save
      </button>
      {error && <span className="error">{error}</span>}
    </form>
  );
}

/** Admin > Users: requests for access, accounts, and how each user's AI is paid for. Admin only. */
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
              Joined {day(u.createdAt)} · {u.jobs} jobs · AI this month {usd(u.spentUsd)}
              {u.aiSource === 'owner' && !u.owner ? ` of ${usd(u.aiCapUsd)} on your key` : ''}
            </p>
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
    </div>
  );
}
