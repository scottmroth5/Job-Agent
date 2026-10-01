import { useEffect, useState } from 'react';
import { api, followTask } from '../api.js';
import { STATUSES, STATUS_LABELS, rateText, hoursText, annualText, scoreClass, payText, PAY_FROM } from '../format.js';
import TaskProgress from './TaskProgress.jsx';

function List({ items }) {
  if (!items?.length) return <p className="muted">None noted.</p>;
  return (
    <ul>
      {items.map((x, i) => (
        <li key={i}>{x}</li>
      ))}
    </ul>
  );
}

export default function DetailPanel({ id, onClose, onChanged }) {
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [notes, setNotes] = useState('');
  const [terms, setTerms] = useState({ rateText: '', hoursText: '' });
  const [paste, setPaste] = useState('');
  const [task, setTask] = useState(null);
  const [copied, setCopied] = useState(false);
  const [showText, setShowText] = useState(false);

  const load = async () => {
    try {
      const j = await api.get(id);
      setJob(j);
      setNotes(j.notes ?? '');
      setTerms({ rateText: j.rateText ?? rateText(j), hoursText: hoursText(j).replace(' hrs/wk', ' hrs') });
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    setTask(null);
    setPaste('');
    setShowText(false);
    load();
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id]);

  const save = async (patch) => {
    try {
      const j = await api.update(id, patch);
      setJob(j);
      setError(null);
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  };

  const run = async (action) => {
    setError(null);
    try {
      const { taskId } = await api.action(id, action);
      const final = await followTask(taskId, setTask);
      if (final.status === 'done') {
        await load();
        onChanged();
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const copyTweaks = async () => {
    await navigator.clipboard.writeText(job.tweaks.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const busy = task?.status === 'running';
  const a = job?.analysis ?? {};
  const fractional = job?.track === 'fractional';

  return (
    <div className="panel-backdrop" onClick={onClose}>
      <aside className="panel" onClick={(e) => e.stopPropagation()} aria-label="Job details">
        <button className="close" onClick={onClose} aria-label="Close">×</button>
        {!job && !error && <p className="muted">Loading…</p>}
        {error && <div className="error">{error}</div>}
        {job && (
          <>
            <div className="panel-head">
              <span className={scoreClass(job.score)}>{job.score ?? '–'}{job.fit && <span className="fit"> {job.fit}</span>}</span>
              <div>
                <h2>{job.title}</h2>
                <div className="muted">
                  {job.company}
                  {job.location ? ` · ${job.location}` : ''} · {job.source}
                </div>
                {job.pay && (
                  <div className="small">
                    Pay: {payText(job)}
                    {job.annualized && job.pay.unit !== 'year' ? ` (about ${annualText(job.annualized)})` : ''}
                    <span className="muted"> · {PAY_FROM[job.pay.from]}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="links">
              {job.url && <a className="button primary" href={job.url} target="_blank" rel="noreferrer">Open posting / apply ↗</a>}
              {job.letter?.url && <a className="button" href={job.letter.url} target="_blank" rel="noreferrer">Cover letter (Google Doc) ↗</a>}
              {job.tweaks && <button onClick={copyTweaks}>{copied ? 'Copied!' : 'Copy resume tweaks'}</button>}
            </div>
            {job.letter?.flags?.length > 0 && <div className="warn-box">Cover letter needs review: {job.letter.flags.join('; ')}</div>}
            {job.letter && !job.letter.url && <div className="warn-box">The cover letter was written but not saved as a Doc yet; the next run retries it.</div>}

            <section className="grid2">
              <label>
                Status
                <select value={job.status} onChange={(e) => save({ status: e.target.value })}>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                  ))}
                </select>
              </label>
              <label>
                Applied on
                <input type="date" value={job.appliedOn ?? ''} onChange={(e) => save({ appliedOn: e.target.value || null })} />
              </label>
              <label>
                Stage
                <select value={job.stage} onChange={(e) => save({ stage: e.target.value })}>
                  <option value="discovered">Discovered</option>
                  <option value="pipeline">Pipeline</option>
                  <option value="archived">Archived</option>
                </select>
              </label>
              <label className="switch">
                <input type="checkbox" checked={fractional} onChange={(e) => save({ track: e.target.checked ? 'fractional' : 'fulltime' })} />
                Fractional role
              </label>
            </section>

            {fractional && (
              <section className="terms-box">
                <div className="grid2">
                  <label>
                    Rate
                    <input value={terms.rateText} placeholder="$150 - $200 / hr" onChange={(e) => setTerms((t) => ({ ...t, rateText: e.target.value }))} onBlur={() => save({ rateText: terms.rateText })} />
                  </label>
                  <label>
                    Hours per week
                    <input value={terms.hoursText} placeholder="10 - 15 hrs" onChange={(e) => setTerms((t) => ({ ...t, hoursText: e.target.value }))} onBlur={() => save({ hoursText: terms.hoursText })} />
                  </label>
                </div>
                <div className="muted small">
                  {job.annualized ? `About ${annualText(job.annualized)} at these terms` : 'Enter a rate and hours to see the annualized estimate.'}
                  {job.extra?.companyStage ? ` · ${job.extra.companyStage}` : ''}
                  {job.extra?.industry ? ` · ${job.extra.industry}` : ''}
                  {job.extra?.notes?.length ? ` · ${job.extra.notes.join(', ')}` : ''}
                </div>
              </section>
            )}

            <section>
              <h3>Why it fits</h3>
              {a.whyItFits || job.reason ? <p>{a.whyItFits ?? job.reason}</p> : null}
              {job.scoreSource?.startsWith('v1') && (
                <p className="muted small">
                  Scored by v1{job.scoreSource === 'v1-quick' ? ' from the title only' : ''}. Use Re-score for a full analysis
                  {job.needsDescription ? ' (paste the description first)' : ''}.
                </p>
              )}
              {job.score == null && <p className="muted">Not scored yet.</p>}
              {a.caveats && (
                <>
                  <h4>Caveats</h4>
                  <p>{a.caveats}</p>
                </>
              )}
              {a.topTalkingPoint && (
                <>
                  <h4>Lead with</h4>
                  <p>{a.topTalkingPoint}</p>
                </>
              )}
              {(a.strengths || a.watchOuts) && (
                <div className="grid2">
                  <div>
                    <h4>Strengths</h4>
                    <List items={a.strengths} />
                  </div>
                  <div>
                    <h4>Watch outs</h4>
                    <List items={a.watchOuts} />
                  </div>
                </div>
              )}
            </section>

            <section>
              <h3>Notes</h3>
              <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Your notes about this job" />
              {notes !== (job.notes ?? '') && <button onClick={() => save({ notes })}>Save notes</button>}
            </section>

            {job.needsDescription && (
              <section className="warn-box">
                <h3>Needs a description</h3>
                <p className="small">The posting could not be read automatically. Paste the job description to score it and write materials.</p>
                <textarea rows={6} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Paste the job description" />
                <button disabled={paste.trim().length < 100} onClick={async () => { await save({ description: paste }); await run('score'); }}>
                  Save and score
                </button>
              </section>
            )}

            <section>
              <h3>Actions</h3>
              <div className="links">
                <button disabled={busy} onClick={() => run(job.letter ? 'regenerate' : 'write-materials')}>
                  {job.letter ? 'Regenerate letter and tweaks' : 'Write resume tweaks and cover letter'}
                </button>
                <button disabled={busy} onClick={() => run('score')}>Re-score</button>
                {job.url && <button disabled={busy} onClick={() => run('refetch')}>Refetch posting</button>}
              </div>
              <TaskProgress task={task} />
            </section>

            {job.tweaks && (
              <section>
                <h3>Resume tweaks</h3>
                <pre className="tweaks">{job.tweaks.content}</pre>
              </section>
            )}

            {job.text && (
              <section>
                <h3>
                  Posting text <span className="muted small">({job.textSource})</span>{' '}
                  <button className="link" onClick={() => setShowText((v) => !v)}>{showText ? 'hide' : 'show'}</button>
                </h3>
                {showText && <pre className="posting-text">{job.text}</pre>}
              </section>
            )}

            <section className="muted small">
              Discovered {job.discoveredOn}
              {job.statusHistory?.length > 1 && ` · ${job.statusHistory.length - 1} status changes`}
              {job.scores?.length > 0 && ` · scored ${job.scores.length} time${job.scores.length > 1 ? 's' : ''}`}
            </section>
          </>
        )}
      </aside>
    </div>
  );
}
