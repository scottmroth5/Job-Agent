import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useDemo } from '../demo.jsx';
import SearchSettings from './SearchSettings.jsx';

const usd = (n) => `$${Number(n).toFixed(2)}`;

/** Settings: your account and how your AI is paid for, with your own Claude key (never shown again once saved). */
export default function SettingsPage() {
  const demo = useDemo();
  const [account, setAccount] = useState(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  useEffect(() => {
    api.account().then(setAccount, (err) => setError(err.message));
  }, []);

  const run = async (action, done) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      setAccount(await action());
      setNote(done);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const save = (e) => {
    e.preventDefault();
    run(() => api.saveClaudeKey(key.trim()), 'Key saved. It is stored encrypted and will not be shown again.').then(() => setKey(''));
  };

  if (!account) return error ? <div className="error">{error}</div> : <p className="muted">Loading…</p>;
  const { ai } = account;
  const b = ai.budget;
  return (
    <div className="settings">
      <section className="home-card">
        <h2>Your account</h2>
        <p>
          {account.name ? <b>{account.name}</b> : null} {account.email ?? (demo ? 'Demo' : 'This computer')}
          {account.status === 'paused' && <span className="badge warn"> paused</span>}
        </p>
        {account.status === 'paused' && <p className="warn-box">Your account is paused: you can look around, but changes and AI are off until the owner resumes it.</p>}
      </section>

      <section className="home-card">
        <h2>AI</h2>
        {ai.paidBy === 'env' && <p>Your AI uses the Claude key in the server settings (ANTHROPIC_API_KEY), up to the budget on Admin &gt; Spending.</p>}
        {ai.paidBy === 'owner' && (
          <p>
            The owner pays for your AI, up to <b>{usd(b.limitUsd)}</b> a month. You have used {usd(b.spentUsd)} in {b.monthLabel}.
          </p>
        )}
        {ai.paidBy === 'own' && (
          <>
            <p>
              AI features (scoring, letters, and meeting prep) use your own Anthropic API key, and Anthropic bills you for them.
              {ai.keySet ? ' Your key is saved.' : ' Add a key to turn them on.'}
            </p>
            {b.spentUsd > 0 && <p className="muted small">Used this month ({b.monthLabel}): {usd(b.spentUsd)}.</p>}
            {!demo && (
              <form className="row key-form" onSubmit={save}>
                <label>
                  {ai.keySet ? 'Replace your key' : 'Your Claude API key'}
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck="false"
                    placeholder="sk-ant-…"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                  />
                </label>
                <button className="primary" type="submit" disabled={busy || !key.trim()}>
                  {busy ? 'Checking…' : 'Save key'}
                </button>
                {ai.keySet && (
                  <button type="button" disabled={busy} onClick={() => run(() => api.removeClaudeKey(), 'Key removed.')}>
                    Remove key
                  </button>
                )}
              </form>
            )}
            <p className="muted small">
              Get a key at console.anthropic.com (API keys). The app checks it with Anthropic, stores it encrypted, and uses it only for your own requests; nobody, including the owner, can see it.
            </p>
          </>
        )}
        {note && <p className="muted small">{note}</p>}
        {error && <div className="error">{error}</div>}
      </section>

      {!demo && <SearchSettings />}

      <p className="muted small">
        <a href="/privacy" target="_blank" rel="noreferrer">Privacy policy</a> · <a href="/terms" target="_blank" rel="noreferrer">Terms</a>
      </p>
    </div>
  );
}
