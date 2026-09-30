import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

function PromptList({ prompts, selected, onSelect }) {
  return (
    <nav className="prompt-list" aria-label="Prompts">
      {prompts.map((p) => (
        <button key={p.name} className={p.name === selected ? 'on' : ''} onClick={() => onSelect(p.name)}>
          <span className="role">{p.label}</span>
          <span className={`badge ${p.source === 'custom' ? 'warn' : ''}`}>{p.source === 'custom' ? 'edited' : 'default'}</span>
          <div className="muted small">{p.usedBy}</div>
        </button>
      ))}
    </nav>
  );
}

function PromptEditor({ name, onSaved }) {
  const [p, setP] = useState(null);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewId, setPreviewId] = useState('');
  const [showDefault, setShowDefault] = useState(false);
  const [showSchema, setShowSchema] = useState(false);
  const area = useRef(null);

  const load = async () => {
    const data = await api.prompt(name);
    setP(data);
    setDraft(data.template);
    setNote('');
    setPreview(null);
    setError(null);
  };

  useEffect(() => {
    setMessage(null);
    load().catch((err) => setError(err.message));
  }, [name]);

  if (!p) return <div className="muted">{error ?? 'Loading…'}</div>;
  const dirty = draft !== p.template;

  const insert = (placeholder) => {
    const el = area.current;
    const text = `{{${placeholder}}}`;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? draft.length;
    setDraft(draft.slice(0, start) + text + draft.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + text.length, start + text.length);
    });
  };

  const act = async (fn, success) => {
    setError(null);
    setMessage(null);
    try {
      const data = await fn();
      if (data) {
        setP(data);
        setDraft(data.template);
        setNote('');
      }
      setMessage(success);
      onSaved();
    } catch (err) {
      setError(err.message);
    }
  };

  const runPreview = async () => {
    setError(null);
    try {
      setPreview(await api.previewPrompt(name, draft, previewId));
    } catch (err) {
      setError(err.message);
    }
  };

  const used = new Set([...draft.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)].map((m) => m[1]));

  return (
    <div className="prompt-editor">
      <div className="panel-head">
        <div>
          <h2>{p.label}</h2>
          <div className="muted small">
            {p.source === 'custom' ? `Edited ${p.updatedAt?.slice(0, 10)}${p.note ? `: ${p.note}` : ''}` : 'Using the default from the repo'} · version {p.version}
          </div>
        </div>
      </div>
      <div className="warn-box small">
        Changes apply to the next run. Every score and letter records the prompt version that produced it. After changing a scoring
        prompt, rerun the scoring eval (<code>npm run eval:score</code>) to check it still ranks jobs well.
      </div>

      <div className="chips" aria-label="Placeholders">
        <span className="muted small">Insert:</span>
        {p.allowed.map((ph) => (
          <button key={ph} type="button" className={`chip ${used.has(ph) ? 'used' : ''} ${p.required.includes(ph) ? 'required' : ''}`} onClick={() => insert(ph)} title={p.required.includes(ph) ? 'Required' : 'Optional'}>
            {`{{${ph}}}`}
          </button>
        ))}
      </div>

      <textarea ref={area} className="prompt-text" rows={22} value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} aria-label="Prompt text" />
      <div className="muted small">{draft.length.toLocaleString()} characters · required placeholders are outlined</div>

      <div className="links">
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for this version (optional)" style={{ flex: '1 1 220px' }} disabled={!dirty} />
        <button className="primary" disabled={!dirty} onClick={() => act(() => api.savePrompt(name, draft, note), 'Saved. The next run uses this version.')}>Save version</button>
        <button
          disabled={!dirty}
          onClick={() => {
            setDraft(p.template);
            setPreview(null);
            setError(null);
          }}
        >
          Discard changes
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {message && <div className="small">{message}</div>}

      <section>
        <h3>Preview</h3>
        <div className="links">
          <input value={previewId} onChange={(e) => setPreviewId(e.target.value.replace(/\D/g, ''))} placeholder="Job # (optional)" style={{ width: 140 }} />
          <button onClick={runPreview}>Preview with a real job</button>
          <span className="muted small">Fills the draft above; nothing is sent to Claude.</span>
        </div>
        {preview?.problems?.length > 0 && <div className="error">{preview.problems.join(' ')}</div>}
        {preview?.message && <div className="muted">{preview.message}</div>}
        {preview?.text && (
          <>
            <div className="muted small">Job #{preview.posting.id}: {preview.posting.title} at {preview.posting.company}</div>
            <pre className="posting-text">{preview.text}</pre>
          </>
        )}
      </section>

      <section>
        <h3>History</h3>
        <div className="links">
          <button disabled={p.source === 'default'} onClick={() => act(() => api.restorePrompt(name, null), 'Back to the default.')}>Use the default</button>
          <button className="link" onClick={() => setShowDefault((v) => !v)}>{showDefault ? 'hide' : 'show'} default text</button>
        </div>
        {showDefault && <pre className="posting-text">{p.defaultTemplate}</pre>}
        {p.versions.length === 0 ? (
          <p className="muted small">No saved versions yet.</p>
        ) : (
          <table className="history">
            <tbody>
              {p.versions.map((v) => (
                <tr key={v.id}>
                  <td className="muted small">{v.createdAt.slice(0, 16).replace('T', ' ')}</td>
                  <td>{v.note ?? <span className="muted">no note</span>}</td>
                  <td className="muted small">{v.version}</td>
                  <td>
                    {v.active ? (
                      <span className="badge ok">active</span>
                    ) : (
                      <>
                        <button className="link" onClick={() => setDraft(v.template)}>load into editor</button>
                        <button className="link" onClick={() => act(() => api.restorePrompt(name, v.id), 'Restored that version.')}>restore</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {p.schema && (
        <section>
          <h3>
            Output format <span className="muted small">(read-only: the code reads these fields)</span>{' '}
            <button className="link" onClick={() => setShowSchema((v) => !v)}>{showSchema ? 'hide' : 'show'}</button>
          </h3>
          {showSchema && <pre className="posting-text">{p.schema}</pre>}
        </section>
      )}
    </div>
  );
}

export default function AdminPage() {
  const [prompts, setPrompts] = useState([]);
  const [selected, setSelected] = useState('score');
  const [error, setError] = useState(null);
  const refresh = () => api.prompts().then(setPrompts).catch((err) => setError(err.message));
  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="admin">
      {error && <div className="error">{error}</div>}
      <PromptList prompts={prompts} selected={selected} onSelect={setSelected} />
      <PromptEditor name={selected} onSaved={refresh} />
    </div>
  );
}
