import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Markdown } from './Notes.jsx';

const HOW = { typed: 'Typed or edited', file: 'From an uploaded file', draft: 'From Build a draft', restore: 'Restored', earlier: 'Saved before versions were kept', sample: 'The sample' };
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'date unknown');

/**
 * The knowledge doc's versions (every save keeps the one before, up to 20): when and how each was saved, and View,
 * Download Word, or Make current (saved as a new version, so nothing is lost).
 */
export default function KnowledgeVersions({ onRestored }) {
  const [versions, setVersions] = useState(null);
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    api.profileVersions().then(setVersions, () => setVersions([]));
  }, []);
  if (!versions?.length) return null;

  const view = async (n) => {
    setError(null);
    if (viewing?.n === n) return setViewing(null);
    try {
      setViewing(await api.profileVersion(n));
    } catch (err) {
      setError(err.message);
    }
  };
  const restore = async (n) => {
    setError(null);
    try {
      onRestored(await api.restoreProfileVersion(n));
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="knowledge-versions">
      <button type="button" className="link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide versions' : `Versions (${versions.length})`}
      </button>
      {open && (
        <ul className="letter-versions">
          {versions.map((v) => (
            <li key={v.n}>
              <div className="row">
                <b>Version {v.n}</b>
                {v.current && <span className="badge ok">current</span>}
                <span className="muted small">
                  {HOW[v.source] ?? 'Saved'} · {when(v.savedAt)} · {v.chars.toLocaleString()} characters
                </span>
              </div>
              <div className="row">
                <button type="button" className="link" onClick={() => view(v.n)}>
                  {viewing?.n === v.n ? 'Hide' : 'View'}
                </button>
                <a className="small" href={`/api/account/profile.docx?version=${v.n}`} download>
                  Download Word
                </a>
                {!v.current && (
                  <button type="button" onClick={() => restore(v.n)}>
                    Make current
                  </button>
                )}
              </div>
              {viewing?.n === v.n && <Markdown text={viewing.text} className="md knowledge-view" />}
            </li>
          ))}
        </ul>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
