import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useDemo } from '../demo.jsx';
import { DashIcon } from './DashIcon.jsx';

const day = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** Word or PDF of the current letter, or of one version. */
function LetterDownload({ jobId, versionId = null, label = 'Download' }) {
  const q = versionId ? `?version=${versionId}` : '';
  return (
    <details className="download-menu">
      <summary className="button">{label}</summary>
      <div className="download-options" role="menu" aria-label="Download the letter">
        <a role="menuitem" href={`/api/postings/${jobId}/letter.docx${q}`} download>
          Word (.docx)
        </a>
        <a role="menuitem" href={`/api/postings/${jobId}/letter.pdf${q}`} download>
          PDF
        </a>
        <span className="muted small">With your name, contact line, date, greeting, and sign-off.</span>
      </div>
    </details>
  );
}

/**
 * Revise with Claude: say what to change, get a revised draft and a note on what changed, and keep going; edit the draft
 * by hand too. Nothing is saved until Use this version, which makes it the current letter (a new version).
 */
function Reviser({ job, current, onSaved, onClose }) {
  const [draft, setDraft] = useState(current);
  const [lastClaude, setLastClaude] = useState(current); // the draft as Claude (or the saved letter) left it
  const [turns, setTurns] = useState([]);
  const [feedback, setFeedback] = useState('');
  const [flags, setFlags] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const edited = draft !== lastClaude;

  const ask = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.reviseLetter(job.id, { letter: draft, feedback, history: turns.map(({ feedback: f, changes }) => ({ feedback: f, changes })) });
      setTurns([...turns, { feedback, changes: r.changes }]);
      setDraft(r.letter);
      setLastClaude(r.letter);
      setFlags(r.flags);
      setFeedback('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      // A draft Claude wrote is a revision; once you have edited it by hand, it is your version.
      const r = await api.saveLetter(job.id, draft, turns.length && !edited ? 'revision' : 'user');
      onSaved(r.docError ? `Saved as the current letter. ${r.docError}` : 'Saved as the current letter.');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="letter-work">
      <h4>Revise with Claude</h4>
      {turns.length > 0 && (
        <ol className="letter-turns">
          {turns.map((t, i) => (
            <li key={i}>
              <div>
                <b>You:</b> {t.feedback}
              </div>
              <div className="muted">
                <b>Claude:</b> {t.changes || 'Revised the letter.'}
              </div>
            </li>
          ))}
        </ol>
      )}
      <form onSubmit={ask} className="letter-ask">
        <label>
          {turns.length ? 'What else should change?' : 'What should change?'}
          <textarea
            rows={3}
            value={feedback}
            maxLength={2000}
            placeholder="e.g. Lead with the platform rebuild; make the second paragraph shorter; sound warmer; mention that I have worked with distributed teams."
            onChange={(e) => setFeedback(e.target.value)}
          />
        </label>
        <div className="row">
          <button className="primary" type="submit" disabled={busy || feedback.trim().length < 3}>
            {busy ? 'Revising (about 20 seconds)…' : 'Ask Claude'}
          </button>
          <span className="muted small">Uses your AI, about 2 cents a revision. Facts come only from your knowledge doc and resume.</span>
        </div>
      </form>
      <label>
        The draft {edited ? '(edited by you)' : turns.length ? '(revised)' : ''}
        <textarea className="letter-draft" rows={14} value={draft} maxLength={8000} onChange={(e) => setDraft(e.target.value)} />
      </label>
      {flags.length > 0 && <div className="warn-box small">Check before you send: {flags.join('; ')}</div>}
      <div className="row">
        <button type="button" className="primary" disabled={busy || draft.trim() === current.trim()} onClick={save}>
          Use this version
        </button>
        <button type="button" disabled={busy} onClick={() => { setDraft(current); setLastClaude(current); setTurns([]); setFlags([]); }}>
          Start over
        </button>
        <button type="button" className="link" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

/** Your own version: paste it or read it from a file (Word, PDF, or text), check it, and save it as the current letter. */
function OwnVersion({ job, current, onSaved, onClose }) {
  const [text, setText] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.saveLetter(job.id, text, 'user');
      onSaved(r.docError ? `Saved as the current letter. ${r.docError}` : 'Saved as the current letter.');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <div className="letter-work">
      <h4>Use my own version</h4>
      <div className="row">
        <label className="button file-button">
          Fill from a file
          <input
            type="file"
            accept=".docx,.pdf,.txt,.md"
            className="sr-only"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              setError(null);
              try {
                setText((await api.letterFromFile(job.id, file)).text);
              } catch (err) {
                setError(err.message);
              }
            }}
          />
        </label>
        <span className="muted small">Word, PDF, or text; or paste below. A greeting and sign-off are added for you in Word and PDF.</span>
      </div>
      <textarea className="letter-draft" rows={14} value={text} maxLength={8000} onChange={(e) => setText(e.target.value)} />
      <div className="row">
        <button type="button" className="primary" disabled={busy || text.trim().length < 100 || text.trim() === current.trim()} onClick={save}>
          Save as the current letter
        </button>
        <button type="button" className="link" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

/** Every version, newest first: how it was made, when, its checks, and view, download, or make current. */
function Versions({ job, versions, onRestored }) {
  const demo = useDemo();
  const [open, setOpen] = useState(null);
  const [error, setError] = useState(null);
  return (
    <div className="letter-work">
      <h4>Versions</h4>
      <ul className="letter-versions">
        {versions.map((v) => (
          <li key={v.id}>
            <div className="row">
              <b>Version {v.number}</b>
              {v.current && <span className="badge ok">current</span>}
              <span className="muted small">
                {v.how} · {day(v.createdAt)}
                {v.resume ? ` · resume: ${v.resume}` : ''}
                {v.flags.length ? ` · check: ${v.flags.join('; ')}` : ''}
              </span>
            </div>
            <div className="row">
              <button type="button" className="link" onClick={() => setOpen(open === v.id ? null : v.id)}>
                {open === v.id ? 'Hide' : 'View'}
              </button>
              <LetterDownload jobId={job.id} versionId={v.id} />
              {!v.current && !demo && (
                <button
                  type="button"
                  onClick={async () => {
                    setError(null);
                    try {
                      await api.restoreLetter(job.id, v.id);
                      onRestored(`Version ${v.number} is the current letter again.`);
                    } catch (err) {
                      setError(err.message);
                    }
                  }}
                >
                  Make current
                </button>
              )}
            </div>
            {open === v.id && <pre className="tweaks">{v.content}</pre>}
          </li>
        ))}
      </ul>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

/**
 * The job panel's Cover letter: the current letter with Copy and Download (Word or PDF), Revise with Claude, Use my
 * own version, and Versions. Every save is a new version (server/letter-routes.js); nothing is overwritten.
 */
export default function LetterSection({ job, onChanged }) {
  const demo = useDemo();
  const [mode, setMode] = useState(null); // null | 'revise' | 'own' | 'versions'
  const [versions, setVersions] = useState([]);
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState(null);
  const loadVersions = () => api.letters(job.id).then(setVersions, () => setVersions([]));
  useEffect(() => {
    loadVersions();
  }, [job.id, job.letter?.createdAt]);
  useEffect(() => {
    setMode(null);
    setNote(null);
  }, [job.id]);

  const letter = job.letter;
  if (!letter?.content) return null;
  const current = versions.find((v) => v.current);
  const saved = async (message) => {
    setMode(null);
    setNote(message);
    await onChanged();
  };
  const toggle = (m) => setMode(mode === m ? null : m);

  return (
    <section className="letter-section">
      <h3 className="with-icon">
        <DashIcon name="letter" />
        Cover letter
      </h3>
      <p className="muted small">
        {current ? `Version ${current.number} of ${versions.length} · ${current.how} · ${day(current.createdAt)}` : ''}
        {letter.resume ? `${current ? ' · ' : ''}written from your resume: ${letter.resume}` : ''}
      </p>
      <div className="row">
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard.writeText(letter.content);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? 'Copied!' : 'Copy letter'}
        </button>
        <LetterDownload jobId={job.id} />
        {!demo && (
          <>
            <button type="button" className={mode === 'revise' ? 'on' : ''} onClick={() => toggle('revise')}>
              Revise with Claude
            </button>
            <button type="button" className={mode === 'own' ? 'on' : ''} onClick={() => toggle('own')}>
              Use my own version
            </button>
          </>
        )}
        {versions.length > 1 && (
          <button type="button" className={mode === 'versions' ? 'on' : ''} onClick={() => toggle('versions')}>
            Versions ({versions.length})
          </button>
        )}
      </div>
      {note && <p className="muted small">{note}</p>}
      {mode === 'revise' && <Reviser job={job} current={letter.content} onSaved={saved} onClose={() => setMode(null)} />}
      {mode === 'own' && <OwnVersion job={job} current={letter.content} onSaved={saved} onClose={() => setMode(null)} />}
      {mode === 'versions' && <Versions job={job} versions={versions} onRestored={saved} />}
      {mode !== 'revise' && mode !== 'own' && <pre className="tweaks">{letter.content}</pre>}
    </section>
  );
}
