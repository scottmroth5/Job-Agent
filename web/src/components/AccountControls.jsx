import { useState } from 'react';
import { api } from '../api.js';

/**
 * Settings > Your data and account: download everything that is yours, pause yourself (and resume, when you paused),
 * or delete your account with everything in it. Not for the owner, whose data is the app's own.
 */
export default function AccountControls({ account, onChange }) {
  const [confirm, setConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);
  const act = async (fn) => {
    setError(null);
    try {
      onChange(await fn());
    } catch (err) {
      setError(err.message);
    }
  };
  const remove = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      await api.deleteAccount(confirm.trim());
      await api.signOut().catch(() => {});
      window.location.href = '/auth/signed-out';
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <section className="home-card">
      <h2>Your data and account</h2>
      <p>
        <a className="button" href="/api/account/export" download>
          Download my data
        </a>{' '}
        <span className="muted small">Everything that is yours (jobs, notes, letters, settings) as one JSON file.</span>
      </p>
      {account.status === 'active' && (
        <p>
          <button type="button" onClick={() => window.confirm('Pause your account? You can look around but not change anything until you resume it.') && act(() => api.pauseAccount())}>
            Pause my account
          </button>{' '}
          <span className="muted small">For a break, or once you have found a job. Nothing is deleted.</span>
        </p>
      )}
      {account.status === 'paused' && account.pausedBySelf && (
        <p>
          <button type="button" className="primary" onClick={() => act(() => api.resumeAccount())}>
            Resume my account
          </button>
        </p>
      )}
      {!deleting ? (
        <p>
          <button type="button" className="danger" onClick={() => setDeleting(true)}>
            Delete my account…
          </button>
        </p>
      ) : (
        <form className="row key-form" onSubmit={remove}>
          <label>
            This deletes your account and everything in it, for good. Type {account.email} to confirm.
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" spellCheck="false" />
          </label>
          <button type="submit" className="danger" disabled={confirm.trim().toLowerCase() !== account.email}>
            Delete everything
          </button>
          <button type="button" onClick={() => setDeleting(false)}>
            Cancel
          </button>
        </form>
      )}
      {error && <div className="error">{error}</div>}
    </section>
  );
}
