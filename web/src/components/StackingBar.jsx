import { moneyShort } from '../format.js';

// Tick fractional engagements in the table to see how they stack against the annual target
// (the tracker's math: hourly rate x hours x weeks, or monthly x 12).
export default function StackingBar({ jobs, target, onClear }) {
  const known = jobs.filter((j) => j.annualized);
  const low = known.reduce((s, j) => s + j.annualized.low, 0);
  const high = known.reduce((s, j) => s + j.annualized.high, 0);
  const [tLow, tHigh] = target;
  const pct = Math.min(100, Math.round((((low + high) / 2) / tHigh) * 100));
  const hours = jobs.reduce((s, j) => s + (j.hours ? (j.hours.min + j.hours.max) / 2 : 0), 0);

  return (
    <div className="stacking">
      {jobs.length === 0 ? (
        <span className="muted">Tick fractional roles below to see how they stack toward your {moneyShort(tLow)} to {moneyShort(tHigh)} target.</span>
      ) : (
        <>
          <div className="stack-line">
            <strong>{jobs.length} selected:</strong> {moneyShort(low)} to {moneyShort(high)} per year · about {Math.round(hours)} hrs/wk
            {known.length < jobs.length && <span className="muted"> ({jobs.length - known.length} without pay or hours)</span>}
            <button className="link" onClick={onClear}>clear</button>
          </div>
          <div className="meter" aria-label="Progress toward target">
            <div className={`fill ${low >= tLow ? 'met' : ''}`} style={{ width: `${pct}%` }} />
          </div>
          <div className="muted small">Target {moneyShort(tLow)} to {moneyShort(tHigh)}</div>
        </>
      )}
    </div>
  );
}
