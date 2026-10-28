import { useState } from 'react';
import { api } from '../api.js';
import { renderMarkdown } from '../../../tools/markdown.js';

const MAX_FILES = 4;
const MAX_MB = 8;
const ACCEPT = '.pdf,.txt,.md,application/pdf,text/plain,text/markdown';
const typeOf = (f) => (f.type === 'application/pdf' || /\.pdf$/i.test(f.name) ? 'application/pdf' : /\.md$/i.test(f.name) ? 'text/markdown' : f.type === 'text/plain' || /\.txt$/i.test(f.name) ? 'text/plain' : f.type);

/** A file's contents as base64 (what the draft route takes). */
const readBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });

/**
 * Build a draft: share your resume and LinkedIn profile (as PDFs) and anything else, and your AI drafts About you and a
 * starting search. Nothing is saved: onUseProfile and onUseSearch put the draft in the forms for you to review and save.
 * The owner's search settings live in their settings file, so they get the About you only (no onUseSearch).
 */
export default function DraftBuilder({ onUseProfile, onUseSearch = null }) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState([]);
  const [pasted, setPasted] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState(null);

  if (!open) {
    return (
      <p>
        <button type="button" onClick={() => setOpen(true)}>
          Build a draft from my resume and LinkedIn…
        </button>
      </p>
    );
  }

  const add = (list) => {
    setError(null);
    const next = [...files, ...list].slice(0, MAX_FILES);
    const big = next.find((f) => f.size > MAX_MB * 1024 * 1024);
    if (big) return setError(`${big.name} is over ${MAX_MB} MB.`);
    setFiles(next);
  };
  const build = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDraft(null);
    try {
      const payload = {
        files: await Promise.all(files.map(async (f) => ({ name: f.name, type: typeOf(f), data: await readBase64(f) }))),
        texts: pasted.trim() ? [{ label: 'Pasted text (LinkedIn and other materials)', text: pasted }] : [],
        notes,
      };
      setDraft(await api.buildDraft(payload));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="draft-builder">
      <h3>Build a draft</h3>
      <p className="muted small">
        Share what you have; your AI writes a first draft of About you and your search (usually under 10 cents). Nothing is saved until you choose to,
        and your files are not kept. See Help, <i>Writing About you</i>, for how to save your LinkedIn profile as a PDF.
      </p>
      <form onSubmit={build} className="search-form">
        <label>
          Your resume and LinkedIn profile (PDF), or text files: up to {MAX_FILES}
          <input type="file" multiple accept={ACCEPT} onChange={(e) => add([...e.target.files])} />
        </label>
        {files.length > 0 && (
          <ul className="draft-files">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`}>
                {f.name} <button type="button" className="link" onClick={() => setFiles(files.filter((_, k) => k !== i))}>remove</button>
              </li>
            ))}
          </ul>
        )}
        <label>
          Paste anything else (optional): your LinkedIn About and Experience, a job ad you would love, review highlights
          <textarea rows={5} maxLength={30000} value={pasted} onChange={(e) => setPasted(e.target.value)} />
        </label>
        <label>
          What you want next, in a sentence or two (optional)
          <textarea rows={2} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <div className="row">
          <button className="primary" type="submit" disabled={busy || (!files.length && !pasted.trim())}>
            {busy ? 'Drafting… (about a minute)' : 'Build draft'}
          </button>
          <button type="button" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      </form>
      {error && <div className="error">{error}</div>}

      {draft && (
        <div className="draft-result">
          <h3>Your draft</h3>
          {draft.questions.length > 0 && (
            <div className="warn-box">
              <b>To make it better, answer these in About you:</b>
              <ul>
                {draft.questions.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="markdown draft-preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(draft.aboutYou) }} />
          <p className="muted small">
            Search: {draft.search.terms.join(', ') || 'no titles suggested'}
            {draft.search.homeLocations.length ? ` · in person: ${draft.search.homeLocations.join(', ')}` : ' · remote'}
          </p>
          <div className="row">
            <button type="button" className="primary" onClick={() => onUseProfile(draft.aboutYou)}>
              Use this About you
            </button>
            {onUseSearch && (
              <button type="button" onClick={() => onUseSearch(draft)}>
                Use these search settings
              </button>
            )}
          </div>
          <p className="muted small">{onUseSearch ? 'Both fill the forms below' : 'It fills About you below'} for you to edit; remember to Save.</p>
        </div>
      )}
    </div>
  );
}
