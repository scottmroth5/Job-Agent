import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { ApiResponse } from '../api.ts';

type Usage = ApiResponse<'GET /api/admin/usage'>;
type Week = Usage['weeks'][number];
type Field = Exclude<keyof Week, 'weekEnding'>;
type Location = Usage['locations'][number];
/** [label, count] rows for a chart. */
type Rows = Array<[string, number]>;

// Admin > Usage: the app's weekly totals across every account (GET /api/admin/usage). Counts only, kept in the app;
// nothing here goes to an analytics service. Weeks run Sunday to Saturday; the first row is this week so far.
const RANGES = [4, 12, 52];
const TOTALS: Array<[Field, string]> = [
  ['accountsSeen', 'Accounts seen'],
  ['pipelineCompleted', 'Pipeline runs completed'],
  ['pipelineFailed', 'Pipeline runs failed'],
  ['jobsAdded', 'Jobs added'],
  ['lettersWritten', 'Cover letters written'],
  ['prepsWritten', 'Meeting preps written'],
  ['claudeSpendUsd', 'Claude spend'],
  ['feedbackReceived', 'Feedback received'],
];
const TILES: Field[] = ['accountsSeen', 'pipelineCompleted', 'jobsAdded', 'lettersWritten'];
const LABEL = Object.fromEntries(TOTALS) as Record<Field, string>;

const shortDay = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const show = (key: Field, n: number) => (key === 'claudeSpendUsd' ? `$${n.toFixed(2)}` : n.toLocaleString());

/** One total by week, oldest on the left; screen readers get the same numbers as a table. */
function WeekBars({ field, weeks }: { field: Field; weeks: Week[] }) {
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

// Device, browser, location, and source totals (server/usage-totals.ts): each shown on its own, never combined.
const DEVICE_ORDER = [
  ['phone', 'Phone'],
  ['tablet', 'Tablet'],
  ['computer', 'Computer'],
];
const SOURCE_ORDER = [
  ['linkedin', 'LinkedIn'],
  ['github', 'GitHub'],
  ['site', 'Your site'],
  ['demo', 'Demo'],
  ['other', 'Other'],
  ['direct', 'Direct'],
];
const count = (list: Array<{ value: string; count: number }>, value: string) => list.find((r) => r.value === value)?.count ?? 0;
/** [value, count] for the largest `limit` (the list comes largest first), the rest summed as "Everything else". */
const top = (list: Array<{ value: string; count: number }>, limit: number): Rows => {
  const rows: Rows = list.map((r) => [r.value, r.count]);
  if (rows.length <= limit) return rows;
  return [...rows.slice(0, limit), ['Everything else', rows.slice(limit).reduce((s, [, n]) => s + n, 0)]];
};

/** Rows of [label, count] as horizontal bars, with the same numbers as a table for screen readers. */
function Breakdown({ caption, label, rows }: { caption: string; label: string; rows: Rows }) {
  const total = rows.reduce((s, [, n]) => s + n, 0);
  if (!total) return <p className="muted">Nothing counted yet.</p>;
  const max = Math.max(...rows.map(([, n]) => n));
  return (
    <>
      <table className="sr-only">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{label}</th>
            <th scope="col">Count</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([l, n]) => (
            <tr key={l}>
              <td>{l}</td>
              <td>{n}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="funnel-bars" aria-hidden="true">
        {rows.map(([l, n]) => (
          <div key={l} className="funnel-row">
            <span className="funnel-label">{l}</span>
            <span className="funnel-track">
              <span className="funnel-fill" style={{ width: `${Math.max(n ? 2 : 0, (n / max) * 100)}%` }} />
            </span>
            <span className="funnel-num">
              <b>{n.toLocaleString()}</b>
              <span className="muted small"> {Math.round((n / total) * 100)}%</span>
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

/** Totals of [key, count], largest first, the top `limit` (the rest summed as "Everywhere else"). */
function rollup(locations: Location[], keyOf: (l: Location) => string, limit: number): Rows {
  const sums = new Map<string, number>();
  for (const l of locations) sums.set(keyOf(l), (sums.get(keyOf(l)) ?? 0) + l.count);
  const sorted = [...sums].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (sorted.length <= limit) return sorted;
  return [...sorted.slice(0, limit), ['Everywhere else', sorted.slice(limit).reduce((s, [, n]) => s + n, 0)]];
}

/** Visits by location: countries, then states, then cities, each its own chart; unknown is its own row. */
function Locations({ locations }: { locations: Location[] }) {
  const known = locations.filter((l) => l.country);
  const unknown = locations.filter((l) => !l.country).reduce((s, l) => s + l.count, 0);
  const withUnknown = (rows: Rows): Rows => (unknown ? [...rows, ['Unknown', unknown]] : rows);
  return (
    <section className="funnel-card">
      <h3>Visits by location</h3>
      <p className="muted small">Approximate, from the address on the server. Each account counts once a day.</p>
      <div className="usage-charts">
        <div>
          <h4>Countries</h4>
          <Breakdown caption="Visits by country" label="Country" rows={withUnknown(rollup(known, (l) => l.country, 10))} />
        </div>
        <div>
          <h4>States</h4>
          <Breakdown caption="Visits by state, top 10" label="State" rows={withUnknown(rollup(known, (l) => `${l.state}, ${l.country}`, 10))} />
        </div>
        <div>
          <h4>Cities</h4>
          <Breakdown caption="Visits by city, top 10" label="City" rows={withUnknown(rollup(known, (l) => `${l.city}, ${l.state}`, 10))} />
        </div>
      </div>
    </section>
  );
}

export default function UsageAdmin() {
  const [range, setRange] = useState(12);
  const [data, setData] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    api.adminUsage(range).then(setData, (err) => setError((err as Error).message));
  }, [range]);

  const rows = data?.weeks ?? null;

  const latest = rows?.[1] as Week; // the latest full week (row 0 is this week so far); read only when rows came, which always has 4 or more
  const oldestFirst = rows ? [...rows].reverse() : [];
  const usage = data as Usage; // read below only once rows (from data) came
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

          <div className="usage-charts">
            <section className="funnel-card">
              <h3>Visits by device</h3>
              <p className="muted small">Each account counts once a day.</p>
              <Breakdown caption="Visits by device" label="Device" rows={DEVICE_ORDER.map(([v, l]) => [l, count(usage.devices, v)])} />
            </section>
            <section className="funnel-card">
              <h3>Visits by browser</h3>
              <p className="muted small">Browser and major version. Each account counts once a day.</p>
              <Breakdown caption="Visits by browser, top 10" label="Browser" rows={top(usage.browsers, 10)} />
            </section>
            <section className="funnel-card">
              <h3>Arrivals by source</h3>
              <p className="muted small">Page loads from outside the app; returning from Google sign-in is not counted.</p>
              <Breakdown caption="Arrivals by source" label="Source" rows={SOURCE_ORDER.map(([v, l]) => [l, count(usage.sources, v)])} />
            </section>
          </div>
          <Locations locations={usage.locations} />

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
            Devices, browsers, locations, and sources are counted from November 2026 on and are not linked to any account.
          </p>
          <p className="muted small">
            Location data:{' '}
            <a href="https://db-ip.com" target="_blank" rel="noreferrer">
              IP to City Lite by DB-IP
            </a>
            , CC BY 4.0.
          </p>
        </>
      )}
    </div>
  );
}
