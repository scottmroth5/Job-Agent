import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { headerLines, SEPARATOR } from '../../../tools/letter-header.js';

const MAX_LINKS = 6;
const EMPTY = { name: '', email: '', phone: '', location: '', signoffName: '', links: [] };

/**
 * Settings: the cover letter header (agents/letter-header.js): name, email, phone, an optional location, the sign-off
 * name, and links, shown on every letter's Word, PDF, and Google Doc. Until saved it is filled in from your settings.
 */
export default function LetterHeaderSettings() {
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(true);
  const [note, setNote] = useState(null);
  const [error, setError] = useState(null);
  const show = (h) => {
    setForm({ ...EMPTY, ...h, links: h.links?.length ? h.links : [''] });
    setSaved(Boolean(h.saved));
  };
  useEffect(() => {
    api.letterHeader().then(show, (err) => setError(err.message));
  }, []);
  if (!form) return <section className="home-card">{error ? <div className="error">{error}</div> : <p className="muted">Loading…</p>}</section>;

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const setLink = (i, v) => setForm((f) => ({ ...f, links: f.links.map((l, k) => (k === i ? v : l)) }));
  const links = form.links.map((l) => l.trim()).filter(Boolean);
  const save = async (e) => {
    e.preventDefault();
    setError(null);
    setNote(null);
    try {
      show(await api.saveLetterHeader({ ...form, links }));
      setNote('Saved. New downloads and letters use it.');
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <section className="home-card">
      <h2>Cover letter header</h2>
      <p className="muted small">
        The top of every cover letter, in Word, PDF, and Google Docs. Your email and links are clickable in the documents.
        {!saved && ' Filled in from your settings; save it to keep it here.'}
      </p>
      <form className="search-form" onSubmit={save}>
        <div className="grid2">
          <label>
            Name
            <input value={form.name} maxLength={120} onChange={set('name')} placeholder="Your name as it appears on letters" required />
          </label>
          <label>
            Sign-off name (optional)
            <input value={form.signoffName} maxLength={120} onChange={set('signoffName')} placeholder="Under Sincerely; your name if empty" />
          </label>
          <label>
            Email
            <input type="email" value={form.email} maxLength={200} onChange={set('email')} placeholder="you@example.com" />
          </label>
          <label>
            Phone
            <input type="tel" value={form.phone} maxLength={40} onChange={set('phone')} placeholder="555-0100" />
          </label>
          <label>
            Location (optional)
            <input value={form.location} maxLength={120} onChange={set('location')} placeholder="City, ST" />
          </label>
        </div>
        <fieldset className="bare">
          <legend>Links</legend>
          {form.links.map((l, i) => (
            <div className="row header-link" key={i}>
              <input aria-label={`Link ${i + 1}`} value={l} maxLength={300} onChange={(e) => setLink(i, e.target.value)} placeholder="https://www.linkedin.com/in/…, your site, github.com/…" />
              <button type="button" className="link" onClick={() => setForm((f) => ({ ...f, links: f.links.filter((_, k) => k !== i) }))}>
                Remove
              </button>
            </div>
          ))}
          {form.links.length < MAX_LINKS && (
            <button type="button" onClick={() => setForm((f) => ({ ...f, links: [...f.links, ''] }))}>
              + Add a link
            </button>
          )}
        </fieldset>
        <div className="header-preview" aria-label="Preview">
          <span className="muted small">Preview</span>
          <b>{form.name || 'Your name'}</b>
          {headerLines({ ...form, links }).map((line, i) => (
            <span key={i}>
              {line.map((p, k) => (
                <span key={k}>
                  {k ? SEPARATOR : ''}
                  {p.url ? <a href={p.url} target="_blank" rel="noreferrer">{p.text}</a> : p.text}
                </span>
              ))}
            </span>
          ))}
        </div>
        <div className="row">
          <button type="submit" className="primary">
            Save header
          </button>
        </div>
      </form>
      {note && <p className="muted small">{note}</p>}
      {error && <div className="error">{error}</div>}
    </section>
  );
}
