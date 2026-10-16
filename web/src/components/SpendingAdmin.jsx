import { useEffect, useState } from 'react';
import { api } from '../api.js';

const LABELS = {
  score: 'Scoring full-time jobs',
  'score-fractional': 'Scoring fractional jobs',
  'resume-tweaks': 'Resume tweaks',
  'cover-letter': 'Cover letters',
  'meeting-prep': 'Meeting prep',
  'inbox-classify': 'Reading job email',
  other: 'Other',
};
const usd = (n) => `$${n.toFixed(2)}`;

/** Admin > Spending: this month's Claude spend against the monthly cap, by feature, and the cap itself. */
export default function SpendingAdmin() {
  const [b, setB] = useState(null);
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  const show = (data) => {
    setB(data);
    setDraft(String(data.limitUsd));
  };
  useEffect(() => {
    api.budget().then(show, (err) => setError(err.message));
  }, []);

  const save = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      show(await api.setBudget(Number(draft)));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err.message);
    }
  };

  if (!b) return error ? <div className="error">{error}</div> : <p className="muted">Loading…</p>;
  const pct = Math.min(100, Math.round((b.spentUsd / b.limitUsd) * 100));
  return (
    <div className="spending">
      <h2>Claude spending, {b.monthLabel}</h2>
      <p>
        <b>{usd(b.spentUsd)}</b> of {usd(b.limitUsd)} this month ({pct}%), {usd(b.remainingUsd)} left.
      </p>
      <div className="meter" role="img" aria-label={`${pct}% of the monthly budget used`}>
        <div className={`fill ${b.level}`} style={{ width: `${pct}%` }} />
      </div>
      {b.level === 'over' && (
        <p className="warn-box">The budget is used up, so Claude calls are paused until next month or until you raise it. Scoring, letters, meeting prep, and inbox reading wait; everything else keeps working.</p>
      )}
      {b.level === 'warn' && <p className="warn-box">Over 80% of this month's budget is used.</p>}

      <form className="row budget-form" onSubmit={save}>
        <label>
          Monthly budget (US dollars)
          <input type="number" min="1" step="1" value={draft} onChange={(e) => setDraft(e.target.value)} />
        </label>
        <button className="primary" type="submit" disabled={!(Number(draft) > 0) || Number(draft) === b.limitUsd}>
          Save
        </button>
        {saved && <span className="muted small">Saved</span>}
      </form>
      <p className="muted small">
        When this month's spend reaches the budget, the app stops making Claude calls until the 1st or until you raise it. The call that crosses the line
        finishes, so the total can go slightly over. {b.source === 'default' ? `The default is $${b.defaultUsd}.` : ''}
      </p>
      {error && <div className="error">{error}</div>}

      <h3>This month by feature</h3>
      {b.byLabel.length ? (
        <table className="history">
          <thead>
            <tr>
              <th>Feature</th>
              <th>Calls</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {b.byLabel.map((r) => (
              <tr key={r.label}>
                <td>{LABELS[r.label] ?? r.label}</td>
                <td>{r.calls}</td>
                <td>{usd(r.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted small">No Claude calls yet this month.</p>
      )}
    </div>
  );
}
