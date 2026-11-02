import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Admin > Usage: the app's weekly totals across every account (GET /api/admin/usage). Counts only, kept in the app;
// nothing here goes to an analytics service. Weeks run Sunday to Saturday; the first row is this week so far.
const RANGES = [4, 12, 52];
const TOTALS = [
  ['accountsSeen', 'Accounts seen'],
  ['pipelineCompleted', 'Pipeline runs completed'],
  ['pipelineFailed', 'Pipeline runs failed'],
  ['jobsAdded', 'Jobs added'],
  ['lettersWritten', 'Cover letters written'],
  ['prepsWritten', 'Meeting preps written'],
  ['claudeSpendUsd', 'Claude spend'],
  ['feedbackReceived', 'Feedback received'],
];
const TILES = ['accountsSeen', 'pipelineCompleted', 'jobsAdded', 'lettersWritten'];
const LABEL = Object.fromEntries(TOTALS);

const shortDay = (day) => new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const show = (key, n) => (key === 'claudeSpendUsd' ? `$${n.toFixed(2)}` : n.toLocaleString());

/** One total by week, oldest on the left; screen readers get the same numbers as a table. */
function WeekBars({ field, weeks }) {
  const max = Math.max(1, ...weeks.map((w) => w[field]));
  const every = Math.ceil(weeks.length / 6); // about six labels, so they never run together
  return (
    <section className="funnel-card usage-chart">
      <h4>{LABEL[field]}</h4>
      <table className="sr-only">
        <caption>{LABEL[field]} per week, the last {weeks.length} weeks</caption>
        <thead>
          <tr>
            <th scope="col">Week ending</th>
            <th scope="col">{LABEL[field]}</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((w, i) => (
            <tr key={w.weekEnding}>
              <td>
                {w.weekEnding}
                {i === weeks.length - 1 ? ' (so far)' : ''}
              </td>
              <td>{show(field, w[field])}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className={`weeks${weeks.length > 12 ? ' dense' : ''}`} aria-hidden="true">
        {weeks.map((w, i) => {
          const current = i === weeks.length - 1;
          return (
            <div key={w.weekEnding} className={`week${current ? ' partial' : ''}`} title={`Week ending ${w.weekEnding}${current ? ' (so far)' : ''}: ${show(field, w[field])}`}>
              {weeks.length <= 12 && <span className="week-count">{w[field] ? show(field, w[field]) : ''}</span>}
              <span className="week-bar" style={{ height: `${(w[field] / max) * 100}%` }} />
              {(weeks.length - 1 - i) % every === 0 && <span className="week-label">{current ? 'now' : w.weekEnding.slice(5).replace('-', '/')}</span>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default function UsageAdmin() {
  const [range, setRange] = useState(12);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    setError(null);
    api.adminUsage(range).then(setRows, (err) => setError(err.message));
  }, [range]);

  const latest = rows?.[1]; // the latest full week (row 0 is this week so far)
  const oldestFirst = rows ? [...rows].reverse() : [];
  return (
    <div className="usage-admin">
      <div className="filters">
        <div className="segmented" role="tablist" aria-label="Weeks shown">
          {RANGES.map((n) => (
            <button key={n} role="tab" aria-selected={range === n} className={range === n ? 'on' : ''} onClick={() => setRange(n)}>
              {n} weeks
            </button>
          ))}
        </div>
        <span className="muted small">Totals across every account, kept in the app. Weeks run Sunday to Saturday.</span>
      </div>
      {error && <div className="error">{error}</div>}
      {!rows ? (
        !error && <p className="muted">Loading…</p>
      ) : (
        <>
          <div className="stats">
            {TILES.map((k) => (
              <div key={k} className="stat">
                <div className="stat-value">{show(k, latest[k])}</div>
                <div className="stat-label">{LABEL[k]}</div>
                <div className="muted small">Week ending {shortDay(latest.weekEnding)}</div>
              </div>
            ))}
          </div>

          <div className="usage-charts">
            {TOTALS.map(([k]) => (
              <WeekBars key={k} field={k} weeks={oldestFirst} />
            ))}
          </div>

          <section className="funnel-card">
            <h3>Every total</h3>
            <div className="usage-scroll">
              <table className="history">
                <thead>
                  <tr>
                    <th scope="col">Week ending</th>
                    {TOTALS.map(([k, label]) => (
                      <th key={k} scope="col">{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((w, i) => (
                    <tr key={w.weekEnding}>
                      <th scope="row">
                        {shortDay(w.weekEnding)}
                        {i === 0 ? ' (so far)' : ''}
                      </th>
                      {TOTALS.map(([k]) => (
                        <td key={k}>{show(k, w[k])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <p className="muted small">
            Accounts seen: this week, accounts that visited; earlier weeks, accounts with a pipeline run or an added job (a
            scheduled run counts). Letters count those the app wrote or you saved, not v1 imports. Claude spend counts calls
            with a known price. A deleted account's activity leaves these totals, apart from spend on the owner's key.
          </p>
        </>
      )}
    </div>
  );
}
