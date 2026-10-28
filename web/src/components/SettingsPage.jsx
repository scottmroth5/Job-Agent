import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useDemo } from '../demo.jsx';
import SearchSettings from './SearchSettings.jsx';
import FeedbackForm from './FeedbackForm.jsx';
import AccountControls from './AccountControls.jsx';
import ResumesSettings from './ResumesSettings.jsx';
import PromptsSettings from './PromptsSettings.jsx';
import SpendingAdmin from './SpendingAdmin.jsx';

const usd = (n) => `$${Number(n).toFixed(2)}`;

// Every zone the browser knows, for the picker.
const ZONES = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];

/** The zone this user's calendar days follow (applied dates, the funnel's weeks, document dates). */
function TimeZonePicker({ account, onSaved }) {
  const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [error, setError] = useState(null);
  const save = async (zone) => {
    setError(null);
    try {
      onSaved(await api.setTimeZone(zone || null));
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <div className="row key-form">
      <label>
        Time zone
        <select value={account.timeZone ?? ''} onChange={(e) => save(e.target.value)}>
          <option value="">The app's ({account.appTimeZone})</option>
          {ZONES.map((z) => (
            <option key={z} value={z}>
              {z.replaceAll('_', ' ')}
            </option>
          ))}
        </select>
      </label>
      {device && device !== (account.timeZone ?? account.appTimeZone) && (
        <button type="button" onClick={() => save(device)}>
          Use this device's ({device.replaceAll('_', ' ')})
        </button>
      )}
      {error && <span className="error">{error}</span>}
    </div>
  );
}

/** Settings: your account and how your AI is paid for, with your own Claude key (never shown again once saved). */
const tabFromHash = () => (/^#\/settings\/prompts/.test(window.location.hash) ? 'prompts' : 'account');

/** Settings: Account (who you are, AI, knowledge doc, search, resumes, your data) and Prompts (your own prompt edits). */
export default function SettingsPage() {
  const [tab, setTabState] = useState(tabFromHash);
  useEffect(() => {
    const onHash = () => setTabState(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const setTab = (t) => {
    setTabState(t);
    window.history.replaceState(null, '', t === 'prompts' ? '#/settings/prompts' : '#/settings');
  };
  const tabs = (
    <div className="segmented admin-sections" role="tablist" aria-label="Settings">
      {[['account', 'Account'], ['prompts', 'Prompts']].map(([k, l]) => (
        <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
          {l}
        </button>
      ))}
    </div>
  );
  if (tab === 'prompts') {
    return (
      <div className="settings wide">
        {tabs}
        <PromptsSettings />
      </div>
    );
  }
  return <AccountSettings tabs={tabs} />;
}

function AccountSettings({ tabs }) {
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
      {tabs}
      <section className="home-card">
        <h2>Your account</h2>
        <p>
          {account.name ? <b>{account.name}</b> : null} {account.email ?? (demo ? 'Demo' : 'This computer')}
          {account.status === 'paused' && <span className="badge warn"> paused</span>}
        </p>
        {account.status === 'paused' && (
          <p className="warn-box">
            Your account is paused: you can look around, but changes and AI are off until {account.pausedBySelf ? 'you resume it (below)' : 'the owner resumes it'}.
          </p>
        )}
        {!demo && !account.owner && <TimeZonePicker account={account} onSaved={setAccount} />}
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

      <SearchSettings />
      <ResumesSettings />
      {/* Your own spend; the owner's (everything on their key) and the monthly cap are on Admin > Spending. */}
      {!account.owner && (
        <section className="home-card">
          <SpendingAdmin embedded />
        </section>
      )}
      {!demo && !account.owner && <FeedbackForm />}
      {!demo && !account.owner && <AccountControls account={account} onChange={setAccount} />}

      <p className="muted small">
        <a href="/privacy" target="_blank" rel="noreferrer">Privacy policy</a> · <a href="/terms" target="_blank" rel="noreferrer">Terms</a>
      </p>
    </div>
  );
}
