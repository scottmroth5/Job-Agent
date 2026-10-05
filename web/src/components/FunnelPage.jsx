import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useLookups } from '../lookups.jsx';

const WINDOWS = [
  ['30', 'Last 30 days'],
  ['90', 'Last 90 days'],
  ['all', 'All time'],
];
const SOURCE_LABELS = { manual: 'Added by hand', 'v1-manual': 'Added by hand (v1)', 'Google Jobs': 'Google results', email: 'Recruiter email' };
const sourceLabel = (s) => SOURCE_LABELS[s] ?? SOURCE_LABELS[s?.toLowerCase()] ?? s;
const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
const days = (x) => (x == null ? '–' : `${Math.round(x * 10) / 10} days`);

function Stat({ label, value, note }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {note && <div className="muted small">{note}</div>}
    </div>
  );
}

// Funnel: how applications turn into responses, interviews, and offers, and which job sites work.
export default function FunnelPage({ onOpenJob }) {
  const lk = useLookups();
  const [range, setRange] = useState('90');
  const [track, setTrack] = useState('all');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setError(null);
    api
      .funnel(range, track)
      .then(setData)
      .catch((err) => setError(err.message));
  }, [range, track]);

  if (error) return <div className="error">{error}</div>;
  if (!data) return <p className="muted">Loading…</p>;
  const t = data.totals;
  const steps = [
    ['Applied', t.applied],
    ['Responded', t.responded],
    ['Interview', t.interview],
    ['Offer', t.offer],
  ];
  const maxWeek = Math.max(1, ...data.weeks.map((w) => w.applied));

  return (
    <div className="funnel">
      <div className="filters">
        <div className="segmented" role="tablist" aria-label="Time window">
          {WINDOWS.map(([k, l]) => (
            <button key={k} role="tab" aria-selected={range === k} className={range === k ? 'on' : ''} onClick={() => setRange(k)}>
              {l}
            </button>
          ))}
        </div>
        <select value={track} onChange={(e) => setTrack(e.target.value)} aria-label="Track">
          <option value="all">All tracks</option>
          {lk.options('track', track).map((v) => (
            <option key={v.id} value={v.id}>{v.label}</option>
          ))}
        </select>
        <span className="muted small">
          {t.found.toLocaleString()} jobs found{range === 'all' ? '' : ' in this window'}, {t.scored7.toLocaleString()} scored 7+.
        </span>
      </div>

      <section className="funnel-card">
        <h3>Applications</h3>
        {t.applied === 0 ? (
          <p className="muted">No applications in this window yet.</p>
        ) : (
          <div className="funnel-bars">
            {steps.map(([label, n], i) => (
              <div key={label} className="funnel-row">
                <span className="funnel-label">{label}</span>
                <span className="funnel-track">
                  <span className="funnel-fill" style={{ width: `${Math.max(n ? 2 : 0, (n / t.applied) * 100)}%` }} />
                </span>
                <span className="funnel-num">
                  <b>{n}</b>
                  {i > 0 && <span className="muted small"> {pct(steps[i - 1][1] ? n / steps[i - 1][1] : null)} of {steps[i - 1][0].toLowerCase()}</span>}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="muted small">
          Also: {t.rejected} rejected, {t.noReply} with no reply after 21 days. An automatic "application received" email does not count as a response.
        </p>
      </section>

      <div className="stats">
        <Stat label="Response rate" value={pct(data.rates.response)} />
        <Stat label="Interview rate" value={pct(data.rates.interview)} />
        <Stat label="Days to first response" value={days(data.medians.daysToResponse)} note={`median of ${data.medians.responseSamples} dated`} />
        <Stat label="Days to first interview" value={days(data.medians.daysToInterview)} note={`median of ${data.medians.interviewSamples} dated`} />
      </div>

      <section className="funnel-card">
        <h3>By where you found the job</h3>
        {data.bySource.length === 0 ? (
          <p className="muted">Nothing yet.</p>
        ) : (
          <table className="history">
            <thead>
              <tr>
                <th>Source</th>
                <th>Applied</th>
                <th>Responses</th>
                <th>Interviews</th>
                <th>Offers</th>
                <th>Response rate</th>
              </tr>
            </thead>
            <tbody>
              {data.bySource.map((s) => (
                <tr key={s.source}>
                  <td>{sourceLabel(s.source)}</td>
                  <td>{s.applied}</td>
                  <td>{s.responded}</td>
                  <td>{s.interview}</td>
                  <td>{s.offer}</td>
                  <td>{pct(s.responseRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="funnel-card">
        <h3>Applications per week</h3>
        <div className="weeks" role="img" aria-label={`Applications per week for the last ${data.weeks.length} weeks`}>
          {data.weeks.map((w) => (
            <div key={w.weekStart} className="week" title={`Week of ${w.weekStart}: ${w.applied}`}>
              <span className="week-count">{w.applied || ''}</span>
              <span className="week-bar" style={{ height: `${(w.applied / maxWeek) * 100}%` }} />
              <span className="week-label">{w.weekStart.slice(5).replace('-', '/')}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="funnel-card">
        <h3>Waiting for a reply ({data.followUps.length})</h3>
        <p className="muted small">Applications with no response after 14 days. A short follow-up note often helps.</p>
        {data.followUps.length === 0 ? (
          <p className="muted">Nothing waiting.</p>
        ) : (
          <table className="history">
            <tbody>
              {data.followUps.map((f) => (
                <tr key={f.id}>
                  <td>
                    <button className="link" onClick={() => onOpenJob(f.id)}>{f.title} at {f.company}</button>
                  </td>
                  <td className="muted nowrap">applied {f.appliedOn}</td>
                  <td className="nowrap"><b>{f.days}</b> days</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
