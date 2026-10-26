import { useRef, useState } from 'react';
import { api } from '../api.js';
import { renderMarkdown } from '../../../tools/markdown.js';
import { DashIcon } from './DashIcon.jsx';

/** Formatted Markdown, rendered safely (tools/markdown.js escapes everything first). */
export function Markdown({ text, className = 'md' }) {
  return <div className={className} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}

// Wraps the selection in markers (or inserts them around a placeholder) and keeps the selection on the text.
function wrap(el, before, after, placeholder) {
  const { selectionStart: a, selectionEnd: b, value } = el;
  const picked = value.slice(a, b) || placeholder;
  const next = value.slice(0, a) + before + picked + after + value.slice(b);
  return { next, select: [a + before.length, a + before.length + picked.length] };
}

// Starts each selected line (or the current line) with a list marker; again removes it.
function listLines(el, ordered) {
  const { selectionStart: a, selectionEnd: b, value } = el;
  const start = value.lastIndexOf('\n', a - 1) + 1;
  const endAt = value.indexOf('\n', b);
  const end = endAt === -1 ? value.length : endAt;
  const lines = value.slice(start, end).split('\n');
  const marker = /^(\s*)([-*+]|\d+[.)])\s+/;
  const all = lines.every((l) => marker.test(l));
  const changed = lines.map((l, i) => (all ? l.replace(marker, '$1') : `${ordered ? `${i + 1}.` : '-'} ${l}`)).join('\n');
  return { next: value.slice(0, start) + changed + value.slice(end), select: [start, start + changed.length] };
}

/** Markdown text box with Bold, Italic, list, and Link buttons (Ctrl+B, Ctrl+I, Ctrl+K; Ctrl+Enter saves). */
function NoteEditor({ initial = '', saveLabel, onSave, onCancel }) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const area = useRef(null);

  const apply = (fn) => {
    const el = area.current;
    if (!el) return;
    const { next, select } = fn(el);
    setDraft(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(...select);
    });
  };
  const bold = () => apply((el) => wrap(el, '**', '**', 'bold text'));
  const italic = () => apply((el) => wrap(el, '*', '*', 'italic text'));
  const link = () => {
    const url = window.prompt('Link address (https://...)');
    if (url && /^(https?:\/\/|mailto:)/i.test(url.trim())) apply((el) => wrap(el, '[', `](${url.trim()})`, 'link text'));
  };
  const save = async () => {
    if (!draft.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };
  const onKeyDown = (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); bold(); }
    else if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); italic(); }
    else if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); link(); }
    else if (mod && e.key === 'Enter') { e.preventDefault(); save(); }
    else if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
  };

  return (
    <div className="note-editor">
      <div className="md-toolbar" role="toolbar" aria-label="Formatting">
        <button type="button" title="Bold (Ctrl+B)" onClick={bold}><b>B</b></button>
        <button type="button" title="Italic (Ctrl+I)" onClick={italic}><i>I</i></button>
        <button type="button" title="Bulleted list" onClick={() => apply((el) => listLines(el, false))}>• List</button>
        <button type="button" title="Numbered list" onClick={() => apply((el) => listLines(el, true))}>1. List</button>
        <button type="button" title="Link (Ctrl+K)" onClick={link}>Link</button>
      </div>
      <textarea ref={area} rows={6} value={draft} autoFocus onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} placeholder="Your note" />
      <div className="row">
        <button className="primary" disabled={saving || !draft.trim()} onClick={save}>{saving ? 'Saving…' : saveLabel}</button>
        <button onClick={onCancel} disabled={saving}>Cancel</button>
        <span className="muted small">**bold**, *italic*, - bullet, [text](https://...)</span>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

const day = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const time = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const stamp = (iso) => new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

/** "Created Oct 16, 2026 · edited Oct 18, 2026", with the exact times on hover. */
function NoteDates({ note }) {
  if (note.source === 'earlier') {
    return <span title="These notes were written before notes had dates">Earlier notes, from before {day(note.createdAt)}</span>;
  }
  const edited = note.updatedAt !== note.createdAt;
  return (
    <span title={`Created ${stamp(note.createdAt)}${edited ? `\nLast edited ${stamp(note.updatedAt)}` : ''}`}>
      Created {day(note.createdAt)}
      {edited && ` · edited ${day(note.updatedAt) === day(note.createdAt) ? `at ${time(note.updatedAt)}` : day(note.updatedAt)}`}
      {note.source === 'agent' && ' · added by Job Agent'}
    </span>
  );
}

/** A job's notes: newest first, each with its dates; add a new one, or edit or delete any of them. */
export default function Notes({ jobId, entries, onChanged }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState(null);

  const remove = async (note) => {
    if (!window.confirm(`Delete the note from ${day(note.createdAt)}?`)) return;
    setError(null);
    try {
      await api.deleteNote(note.id);
      await onChanged();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <section>
      <h3 className="with-icon">
        <DashIcon name="notes" />
        Notes {!adding && <button className="link small demo-hide" onClick={() => { setAdding(true); setEditing(null); }}>+ Add a note</button>}
      </h3>
      {adding && (
        <NoteEditor
          saveLabel="Add note"
          onCancel={() => setAdding(false)}
          onSave={async (body) => {
            await api.addNote(jobId, body);
            setAdding(false);
            await onChanged();
          }}
        />
      )}
      {!entries.length && !adding && <p className="muted small">No notes yet.</p>}
      <ul className="notes">
        {entries.map((n) => (
          <li key={n.id}>
            <div className="note-meta muted small">
              <NoteDates note={n} />
              {editing !== n.id && (
                <span className="row">
                  <button className="link small demo-hide" onClick={() => { setEditing(n.id); setAdding(false); }}>Edit</button>
                  <button className="link small demo-hide" onClick={() => remove(n)}>Delete</button>
                </span>
              )}
            </div>
            {editing === n.id ? (
              <NoteEditor
                initial={n.body}
                saveLabel="Save changes"
                onCancel={() => setEditing(null)}
                onSave={async (body) => {
                  await api.updateNote(n.id, body);
                  setEditing(null);
                  await onChanged();
                }}
              />
            ) : (
              <Markdown text={n.body} />
            )}
          </li>
        ))}
      </ul>
      {error && <div className="error">{error}</div>}
    </section>
  );
}
