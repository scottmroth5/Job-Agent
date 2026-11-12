import { useState } from 'react';
import { api } from '../api.ts';

/** A job's scam check (server/queries.ts getPosting scam; agents/discovery/scam.ts ScamCheck). */
export type Scam = {
  status: 'checked' | 'failed';
  likelihood: 'none' | 'low' | 'medium' | 'high';
  signals: Array<{ code: string; label: string; weight: 'strong' | 'weak'; match: string }>;
  reasons: Array<{ reason: string; quote: string }>;
  summary: string;
  dismissed: boolean;
};

/**
 * The job panel's scam warning: a box for a medium or high risk (the reasons, their quotes, and the signs the rules
 * found) with Not a scam; one muted line for a low one or a dismissed one. A warning only: nothing is blocked.
 */
export default function ScamWarning({ jobId, scam, onChange }: { jobId: number; scam: Scam | null; onChange: (scam: Scam | null) => void }) {
  const [error, setError] = useState<string | null>(null);
  if (!scam) return null;
  const setDismissed = async (dismissed: boolean) => {
    setError(null);
    try {
      onChange(((await api.dismissScam(jobId, dismissed)) as { scam: Scam | null }).scam);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const risky = scam.likelihood === 'medium' || scam.likelihood === 'high';
  if (scam.dismissed)
    return (
      <p className="muted small">
        You marked this job not a scam.{' '}
        <button type="button" className="link-button" onClick={() => void setDismissed(false)}>
          Show the warning again
        </button>
        {error && <span className="error">{error}</span>}
      </p>
    );
  if (!risky) return scam.likelihood === 'low' ? <p className="muted small">Checked for scam signs: low risk.</p> : null;
  return (
    <section className="warn-box scam-warning" aria-labelledby={`scam-${jobId}`}>
      <strong id={`scam-${jobId}`}>Possible scam: {scam.likelihood} risk</strong>
      {scam.summary && <p>{scam.summary}</p>}
      {scam.status === 'failed' && <p className="small">The AI check could not run, so this comes from the warning signs below alone.</p>}
      {scam.reasons.length > 0 && (
        <ul>
          {scam.reasons.map((r, i) => (
            <li key={i}>
              {r.reason}
              {r.quote && <q className="muted"> {r.quote}</q>}
            </li>
          ))}
        </ul>
      )}
      {scam.signals.length > 0 && (
        <p className="small">
          Signs found: {scam.signals.map((s) => `${s.label} ("${s.match}")`).join('; ')}.
        </p>
      )}
      <p className="small muted">This is a guess and can be wrong. Check the company's own website before you share personal or bank details or pay for anything.</p>
      <button type="button" onClick={() => void setDismissed(true)}>
        Not a scam
      </button>
      {error && <div className="error">{error}</div>}
    </section>
  );
}
