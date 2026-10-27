import { useEffect, useState } from 'react';
import { api, followTask } from '../api.js';
import { Markdown } from './Notes.jsx';
import TaskProgress from './TaskProgress.jsx';
import { useDemo } from '../demo.jsx';
import { DashIcon } from './DashIcon.jsx';

const KINDS = ['Recruiter or search firm', 'Hiring manager', 'Executive, owner, or investor', 'Panel or team', 'Technical', 'Networking or introduction', 'Other'];
const FORMATS = ['Video', 'Phone', 'In person'];
const EMPTY_PERSON = { name: '', role: '', organization: '', url: '', about: '' };

const names = (attendees) => {
  const list = attendees.map((a) => a.name);
  return list.length > 2 ? `${list.slice(0, 2).join(', ')} and ${list.length - 2} more` : list.join(' and ');
};
const when = (iso) =>
  iso ? new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
const money = (usd) => (usd == null ? '' : ` · $${usd.toFixed(2)}`);

// Stops Escape from also closing the job panel behind a dialog.
const trapEscape = (close) => (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    close();
  }
};

/** Who the meeting is with and anything else Claude should know, then a task that writes the prep. */
function PrepDialog({ job, onClose, onDone }) {
  const [people, setPeople] = useState([{ ...EMPTY_PERSON, organization: job.company ?? '' }]);
  const [form, setForm] = useState({ meetingAt: '', kind: '', format: 'Video', context: '', research: true });
  const [task, setTask] = useState(null);
  const [error, setError] = useState(null);
  const busy = task?.status === 'running';

  const setPerson = (i, key) => (e) => setPeople((ps) => ps.map((p, k) => (k === i ? { ...p, [key]: e.target.value } : p)));
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const ready = people.some((p) => p.name.trim());

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const body = {
        attendees: people.filter((p) => p.name.trim()).map((p) => Object.fromEntries(Object.entries(p).filter(([, v]) => v.trim()))),
        meetingAt: form.meetingAt || null,
        kind: form.kind || null,
        format: form.format || null,
        context: form.context.trim() || null,
        research: form.research,
      };
      const { taskId } = await api.startPrep(job.id, body);
      const final = await followTask(taskId, setTask);
      if (final.status === 'done') onDone(final.result?.prepId);
      else setError(final.error ?? 'The prep could not be written.');
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="panel-backdrop" onClick={busy ? undefined : onClose} onKeyDown={trapEscape(busy ? () => {} : onClose)}>
      <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={submit} aria-label="Prepare for a meeting">
        <button type="button" className="close" onClick={onClose} aria-label="Close" disabled={busy}>×</button>
        <h2>Prepare for a meeting</h2>
        <p className="muted small">
          {job.title} at {job.company}. Claude reads your knowledge doc, this job's posting, fit analysis, cover letter, and notes, then researches the people and company online.
        </p>

        <h4>Who is the meeting with?</h4>
        {people.map((p, i) => (
          <fieldset key={i} className="person" disabled={busy}>
            <div className="grid2">
              <label>
                Name
                <input value={p.name} onChange={setPerson(i, 'name')} placeholder="First and last name" autoFocus={i === people.length - 1} />
              </label>
              <label>
                Title or role
                <input value={p.role} onChange={setPerson(i, 'role')} placeholder="e.g. Founder, VP Engineering" />
              </label>
              <label>
                Company or firm
                <input value={p.organization} onChange={setPerson(i, 'organization')} />
              </label>
              <label>
                <span>LinkedIn or bio link <span className="muted small">(optional)</span></span>
                <input type="url" value={p.url} onChange={setPerson(i, 'url')} placeholder="https://..." />
              </label>
            </div>
            <label>
              <span>What you know about them <span className="muted small">(optional)</span></span>
              <input value={p.about} onChange={setPerson(i, 'about')} placeholder="e.g. referred by a former colleague, met at a meetup" />
            </label>
            {people.length > 1 && (
              <button type="button" className="link small" onClick={() => setPeople((ps) => ps.filter((_, k) => k !== i))}>
                Remove this person
              </button>
            )}
          </fieldset>
        ))}
        {people.length < 8 && (
          <button type="button" className="link" disabled={busy} onClick={() => setPeople((ps) => [...ps, { ...EMPTY_PERSON, organization: ps.at(-1)?.organization ?? '' }])}>
            + Add another person
          </button>
        )}

        <h4>The meeting</h4>
        <div className="grid2">
          <label>
            Kind of meeting
            <select value={form.kind} onChange={set('kind')} disabled={busy}>
              <option value="">Let Claude judge</option>
              {KINDS.map((k) => <option key={k}>{k}</option>)}
            </select>
          </label>
          <label>
            Format
            <select value={form.format} onChange={set('format')} disabled={busy}>
              {FORMATS.map((f) => <option key={f}>{f}</option>)}
            </select>
          </label>
          <label>
            <span>When <span className="muted small">(optional)</span></span>
            <input type="datetime-local" value={form.meetingAt} onChange={set('meetingAt')} disabled={busy} />
          </label>
        </div>
        <label>
          <span>Anything else Claude should know <span className="muted small">(optional)</span></span>
          <textarea
            rows={5}
            value={form.context}
            onChange={set('context')}
            disabled={busy}
            placeholder="How the meeting came about, what you have discussed so far, your goals, things to decide or avoid, compensation guidance…"
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={form.research} onChange={set('research')} disabled={busy} /> Research the people and company online
        </label>
        <p className="muted small">Written by Claude Opus 5.5; takes 2 to 5 minutes and costs about $1 to $2 with research (less without).</p>

        <div className="row">
          <button className="primary" type="submit" disabled={!ready || busy}>{busy ? 'Writing…' : 'Write prep'}</button>
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
        <TaskProgress task={task} />
        {error && <div className="error">{error}</div>}
      </form>
    </div>
  );
}

/** A finished prep, formatted, with its Google Doc (when there is one), a copy button, and a Word download. */
function PrepReader({ prepId, onClose }) {
  const demo = useDemo();
  const [prep, setPrep] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.prep(prepId).then(setPrep, (err) => setError(err.message));
  }, [prepId]);
  const copy = async () => {
    await navigator.clipboard.writeText(prep.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="panel-backdrop" onClick={onClose} onKeyDown={trapEscape(onClose)} tabIndex={-1}>
      <article className="dialog prep-reader" onClick={(e) => e.stopPropagation()} aria-label="Meeting prep">
        <button type="button" className="close" onClick={onClose} aria-label="Close" autoFocus>×</button>
        {error && <div className="error">{error}</div>}
        {!prep && !error && <p className="muted">Loading…</p>}
        {prep && (
          <>
            <div className="links">
              {prep.docUrl && <a className="button" href={prep.docUrl} target="_blank" rel="noreferrer">Open Google Doc</a>}
              <button onClick={copy}>{copied ? 'Copied' : 'Copy text'}</button>
              {!demo && (
                <a className="button" href={`/api/meeting-preps/${prep.id}/docx`} download>
                  Download Word
                </a>
              )}
              <button onClick={() => window.print()}>Print</button>
            </div>
            <Markdown text={prep.content} className="md prep" />
            <p className="muted small">
              Written {new Date(prep.createdAt).toLocaleString()} by {prep.model}
              {prep.research ? `, ${prep.webSearches} web searches` : ', no research'}
              {money(prep.costUsd)}. Check researched facts before relying on them.
            </p>
          </>
        )}
      </article>
    </div>
  );
}

/** The job's meeting preps and the button that starts a new one. */
export default function MeetingPrep({ job, onChanged, askSignal = 0 }) {
  const [asking, setAsking] = useState(false);
  // The Next step box's Prepare for a meeting (DetailPanel) opens the same form.
  useEffect(() => {
    if (askSignal) setAsking(true);
  }, [askSignal]);
  const [reading, setReading] = useState(null);
  const [error, setError] = useState(null);
  const preps = job.meetingPreps ?? [];

  const remove = async (p) => {
    if (!window.confirm(`Delete the prep for ${names(p.attendees)}? ${p.docUrl ? 'Its Google Doc stays in Drive.' : ''}`)) return;
    try {
      await api.deletePrep(p.id);
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <section>
      <h3 className="with-icon">
        <DashIcon name="prep" />
        Meeting prep <button className="link small demo-hide" onClick={() => setAsking(true)}>Prepare for a meeting</button>
      </h3>
      {preps.length ? (
        <ul className="preps">
          {preps.map((p) => (
            <li key={p.id}>
              <button className="link" onClick={() => setReading(p.id)}>{names(p.attendees)}</button>
              <span className="muted small">
                {' '}
                {[p.kind, when(p.meetingAt)].filter(Boolean).join(' · ') || `written ${new Date(p.createdAt).toLocaleDateString()}`}
              </span>
              <span className="row">
                {p.docUrl && <a className="small" href={p.docUrl} target="_blank" rel="noreferrer">Google Doc</a>}
                <button className="link small demo-hide" onClick={() => remove(p)}>Delete</button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No prep yet. Before a call or interview, Prepare for a meeting writes a prep document like the ones you make by hand.</p>
      )}
      {error && <div className="error">{error}</div>}
      {asking && (
        <PrepDialog
          job={job}
          onClose={() => setAsking(false)}
          onDone={(prepId) => {
            setAsking(false);
            onChanged();
            if (prepId) setReading(prepId);
          }}
        />
      )}
      {reading && <PrepReader prepId={reading} onClose={() => setReading(null)} />}
    </section>
  );
}
