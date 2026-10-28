import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useDemo } from '../demo.jsx';

const ACCEPT = '.pdf,.docx,.txt,.md';
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** One resume: its label and the job titles it is for (edited in place), default, replace, download, delete. */
function ResumeRow({ r, demo, onChanged, onError }) {
  const [label, setLabel] = useState(r.label);
  const [titles, setTitles] = useState(r.titles);
  const dirty = label !== r.label || titles !== r.titles;
  const act = async (fn) => {
    onError(null);
    try {
      await fn();
      await onChanged();
    } catch (err) {
      onError(err.message);
    }
  };
  return (
    <li className="resume-row">
      <fieldset className="bare" disabled={demo}>
        <div className="grid2">
          <label>
            Label
            <input value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label>
            Use for job titles with
            <input value={titles} maxLength={300} placeholder="e.g. VP, CTO, Head of" onChange={(e) => setTitles(e.target.value)} />
          </label>
        </div>
      </fieldset>
      <div className="row resume-meta">
        {r.isDefault ? <span className="badge ok">default</span> : null}
        <span className="muted small">
          {r.filename} · {r.chars.toLocaleString()} characters · updated {day(r.updatedAt)}
        </span>
        <a className="button small-button" href={`/api/resumes/${r.id}/file`} download>
          Download
        </a>
        <span className="row demo-hide">
          {dirty && (
            <button type="button" className="primary" onClick={() => act(() => api.updateResume(r.id, { label, titles }))}>
              Save
            </button>
          )}
          {!r.isDefault && (
            <button type="button" onClick={() => act(() => api.updateResume(r.id, { isDefault: true }))}>
              Make default
            </button>
          )}
          <label className="button file-button">
            Replace file
            <input
              type="file"
              accept={ACCEPT}
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) act(() => api.replaceResume(r.id, file));
              }}
            />
          </label>
          <button
            type="button"
            onClick={() => window.confirm(`Delete the resume "${r.label}"? Letters already written from it stay.`) && act(() => api.deleteResume(r.id))}
          >
            Delete
          </button>
        </span>
      </div>
    </li>
  );
}

/**
 * Settings > Resumes: the resumes letters, resume tweaks, and meeting prep are written from. Each job uses the resume
 * whose titles match its title, else the default (agents/resumes.js pickResume).
 */
export default function ResumesSettings() {
  const demo = useDemo();
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.resumes().then(setList, (err) => setError(err.message));
  useEffect(() => {
    load();
  }, []);

  const upload = async (file) => {
    setError(null);
    setBusy(true);
    try {
      await api.uploadResume(file);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="home-card">
      <h2>Resumes</h2>
      <p className="muted small">
        Letters, resume tweaks, and meeting prep are written from the resume that fits each job: the one whose job titles match the posting's title, else
        the default. Scoring reads your knowledge doc, not resumes. PDF, Word .docx, or text, up to 5 MB.
      </p>
      {list === null ? null : list.length === 0 ? (
        <p className="muted">{demo ? 'No sample resumes.' : 'No resumes yet. Until you add one, writing works from your knowledge doc alone.'}</p>
      ) : (
        <ul className="resume-list">
          {list.map((r) => (
            <ResumeRow key={`${r.id}-${r.updatedAt}`} r={r} demo={demo} onChanged={load} onError={setError} />
          ))}
        </ul>
      )}
      <div className="row demo-hide">
        <label className={`button primary file-button${busy ? ' disabled' : ''}`}>
          {busy ? 'Reading the file…' : 'Upload a resume'}
          <input
            type="file"
            accept={ACCEPT}
            className="sr-only"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) upload(file);
            }}
          />
        </label>
        <span className="muted small">After uploading, give it a label and the job titles it is for.</span>
      </div>
      {error && <div className="error">{error}</div>}
    </section>
  );
}
