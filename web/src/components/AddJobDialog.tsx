import { useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { useLookups } from '../lookups.tsx';
import { api, followTask } from '../api.ts';
import TaskProgress from './TaskProgress.tsx';
import type { ApiBody, Job, Task } from '../api.ts';

type AddForm = { url: string; title: string; company: string; location: string; description: string; notes: string; track: string; rateText: string; hoursText: string; writeMaterials: boolean };
/** The saved job the form matched (the add task's result when it found one). */
type Match = { id: Job['id']; title: string; company: string; summary?: string; url?: string | null };

const EMPTY: AddForm = { url: '', title: '', company: '', location: '', description: '', notes: '', track: '', rateText: '', hoursText: '', writeMaterials: false };

/** What the form adds to an existing job: terms, location, description, and notes appended (never title/company). */
function updateFromForm(form: AddForm, existingNotes: string | null | undefined) {
  const patch: ApiBody<'PATCH /api/postings/:id'> = {};
  if (form.track) patch.track = form.track;
  if (form.rateText.trim()) patch.rateText = form.rateText.trim();
  if (form.hoursText.trim()) patch.hoursText = form.hoursText.trim();
  if (form.location.trim()) patch.location = form.location.trim();
  if (form.description.trim().length >= 100) patch.description = form.description.trim();
  if (form.notes.trim() && !(existingNotes ?? '').includes(form.notes.trim())) {
    patch.notes = [existingNotes, form.notes.trim()].filter(Boolean).join('\n');
  }
  return patch;
}

function DuplicateCard({ match, matchedBy, form, onOpen }: { match: Match; matchedBy: string; form: AddForm; onOpen: (id: Job['id']) => void }) {
  const [state, setState] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const update = async () => {
    setError(null);
    try {
      const current = await api.get(match.id);
      const patch = updateFromForm(form, current.notes);
      if (!Object.keys(patch).length) {
        setState('Nothing new to add.');
        return;
      }
      await api.update(match.id, patch);
      setState(`Updated: ${Object.keys(patch).map((k) => ({ rateText: 'rate', hoursText: 'hours' } as Record<string, string | undefined>)[k] ?? k).join(', ')}.`);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="warn-box">
      <strong>This job is already saved</strong> <span className="muted small">(matched by {matchedBy})</span>
      <div style={{ margin: '6px 0' }}>
        <div className="role">{match.title}</div>
        <div>{match.company}</div>
        <div className="muted small">{match.summary}</div>
        {match.url && <a className="small" href={match.url} target="_blank" rel="noreferrer">{match.url}</a>}
      </div>
      <div className="links">
        <button type="button" className="primary" onClick={() => onOpen(match.id)}>Open that job</button>
        <button type="button" onClick={update}>Update it with what I entered</button>
      </div>
      <div className="muted small">Updating adds your track, rate, hours, location, description and notes; it does not change the saved title or company.</div>
      {state && <div className="small">{state}</div>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

export default function AddJobDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (id: Job['id']) => void }) {
  const lk = useLookups();
  const [form, setForm] = useState<AddForm>(EMPTY);
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof AddForm) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [key]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value }));
  const busy = task?.status === 'running';
  const done = task?.status === 'done';
  const duplicate = done && task.result?.created === false ? task.result : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const body = Object.fromEntries(Object.entries(form).filter(([, v]) => v !== '' && v !== false)) as ApiBody<'POST /api/postings'>;
    try {
      const { taskId } = await api.add(body);
      const final = await followTask(taskId, setTask);
      if (final.status === 'done' && final.result?.created) onAdded(final.result.id);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="panel-backdrop" onClick={busy ? undefined : onClose}>
      <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={submit} aria-label="Add a job">
        <button type="button" className="close" onClick={onClose} aria-label="Close" disabled={busy}>×</button>
        <h2>Add a job</h2>
        <p className="muted small">Paste the link, the description, or both. With only a link, the text is fetched for you; add the description when the site blocks that (for example Go Fractional).</p>
        <label>
          Link to the posting
          <input type="url" value={form.url} onChange={set('url')} placeholder="https://..." disabled={busy || done} />
        </label>
        <div className="grid2">
          <label>
            Title <span className="muted small">(needed without a link)</span>
            <input value={form.title} onChange={set('title')} disabled={busy || done} />
          </label>
          <label>
            Company
            <input value={form.company} onChange={set('company')} disabled={busy || done} />
          </label>
        </div>
        <label>
          Description
          <textarea rows={6} value={form.description} onChange={set('description')} placeholder="Paste the job description (optional with a link)" disabled={busy || done} />
        </label>
        <div className="grid2">
          <label>
            Track
            <select value={form.track} onChange={set('track')} disabled={busy || done}>
              <option value="">Detect automatically</option>
              {lk.options('track').map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
          </label>
          <label>
            Location
            <input value={form.location} onChange={set('location')} placeholder="Remote, or City, ST" disabled={busy || done} />
          </label>
        </div>
        {lk.showsTerms(form.track) && (
          <div className="grid2">
            <label>
              Rate
              <input value={form.rateText} onChange={set('rateText')} placeholder="$150 - $200 / hr" disabled={busy || done} />
            </label>
            <label>
              Hours per week
              <input value={form.hoursText} onChange={set('hoursText')} placeholder="10 - 15 hrs" disabled={busy || done} />
            </label>
          </div>
        )}
        <label>
          Notes
          <input value={form.notes} onChange={set('notes')} placeholder="Where you found it, who referred you…" disabled={busy || done} />
        </label>
        <label className="switch">
          <input type="checkbox" checked={form.writeMaterials} onChange={set('writeMaterials')} disabled={busy || done} />
          Write resume tweaks and a cover letter even if it scores under 7
        </label>
        {error && <div className="error">{error}</div>}
        {duplicate ? (
          <DuplicateCard
            match={duplicate.existing}
            matchedBy={duplicate.matchedBy}
            form={form}
            onOpen={(id) => {
              onAdded(id);
              onClose();
            }}
          />
        ) : (
          <TaskProgress task={task} />
        )}
        <div className="links">
          {!done && (
            <button className="primary" type="submit" disabled={busy || (!form.url && !form.description)}>
              {busy ? 'Working…' : 'Add job'}
            </button>
          )}
          {(done || task?.status === 'failed') && (
            <button type="button" onClick={() => { setForm(EMPTY); setTask(null); }}>Add another</button>
          )}
          <button type="button" onClick={onClose} disabled={busy}>Close</button>
        </div>
      </form>
    </div>
  );
}
