import { useState } from 'react';
import { api } from '../api.js';

const MAX_BYTES = 25 * 1024 * 1024;
const size = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`);

// Files attached to a job: add by picking or dropping files; open, download, or delete each one.
export default function Attachments({ jobId, items, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [over, setOver] = useState(false);

  const upload = async (files) => {
    setError(null);
    const list = [...files];
    const tooBig = list.filter((f) => f.size > MAX_BYTES);
    if (tooBig.length) setError(`Over the 25 MB limit: ${tooBig.map((f) => f.name).join(', ')}`);
    const ok = list.filter((f) => f.size <= MAX_BYTES && f.size > 0);
    if (!ok.length) return;
    setBusy(true);
    try {
      for (const f of ok) await api.uploadAttachment(jobId, f);
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a) => {
    if (!window.confirm(`Delete "${a.filename}"? This removes the file.`)) return;
    try {
      await api.deleteAttachment(a.id);
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <section>
      <h3>Attachments</h3>
      {items.length > 0 && (
        <ul className="attachments">
          {items.map((a) => (
            <li key={a.id}>
              <a href={`/api/attachments/${a.id}/file`} target="_blank" rel="noreferrer">{a.filename}</a>
              <span className="muted small"> {size(a.sizeBytes)} · {a.createdAt.slice(0, 10)}</span>
              <span className="row">
                <a className="small" href={`/api/attachments/${a.id}/file?download`} download>Download</a>
                <button className="link small" onClick={() => remove(a)}>Delete</button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <label
        className={`drop-zone${over ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          upload(e.dataTransfer.files);
        }}
      >
        <input type="file" multiple disabled={busy} onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
        <span>{busy ? 'Uploading…' : 'Drop files here or choose files (25 MB each)'}</span>
      </label>
      {error && <div className="error">{error}</div>}
    </section>
  );
}
