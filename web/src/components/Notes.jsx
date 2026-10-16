import { useRef, useState } from 'react';
import { renderMarkdown } from '../../../tools/markdown.js';

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

/** The job's notes: formatted when reading; Markdown with a small toolbar when editing. */
export default function Notes({ value, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
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

  const start = () => {
    setDraft(value ?? '');
    setEditing(true);
    requestAnimationFrame(() => area.current?.focus());
  };
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
      setEditing(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };
  const onKeyDown = (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); bold(); }
    else if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); italic(); }
    else if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); link(); }
    else if (mod && e.key === 'Enter') { e.preventDefault(); save(); }
    else if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); }
  };

  if (!editing) {
    return (
      <section>
        <h3>
          Notes <button className="link small" onClick={start}>{value ? 'Edit' : 'Add notes'}</button>
        </h3>
        {value ? <Markdown text={value} /> : <p className="muted small">No notes yet.</p>}
      </section>
    );
  }
  return (
    <section>
      <h3>Notes</h3>
      <div className="md-toolbar" role="toolbar" aria-label="Formatting">
        <button type="button" title="Bold (Ctrl+B)" onClick={bold}><b>B</b></button>
        <button type="button" title="Italic (Ctrl+I)" onClick={italic}><i>I</i></button>
        <button type="button" title="Bulleted list" onClick={() => apply((el) => listLines(el, false))}>• List</button>
        <button type="button" title="Numbered list" onClick={() => apply((el) => listLines(el, true))}>1. List</button>
        <button type="button" title="Link (Ctrl+K)" onClick={link}>Link</button>
      </div>
      <textarea ref={area} rows={8} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} placeholder="Your notes about this job" />
      <div className="row">
        <button className="primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save notes'}</button>
        <button onClick={() => setEditing(false)}>Cancel</button>
        <span className="muted small">**bold**, *italic*, - bullet, [text](https://...)</span>
      </div>
      {error && <div className="error">{error}</div>}
    </section>
  );
}
