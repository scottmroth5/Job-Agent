import { useEffect, useRef, useState } from 'react';
import { api, followTask } from '../api.js';
import { useLookups } from '../lookups.jsx';
import { rateText, hoursText, annualText, scoreClass, payText, PAY_FROM, sourceLabel } from '../format.js';
import TaskProgress from './TaskProgress.jsx';
import Attachments from './Attachments.jsx';
import Notes, { Markdown } from './Notes.jsx';
import MeetingPrep from './MeetingPrep.jsx';
import LetterSection from './LetterSection.jsx';
import { useDemo } from '../demo.jsx';
import { isOwner, useMe } from '../me.jsx';
import { DashIcon } from './DashIcon.jsx';


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

// How the current score was made (server/queries.js scoreDetails): when, by which model, from the posting text or the
// title alone, and with which prompt, so a reader can judge it and knows when a re-score would change it.
const modelName = (id) => {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id ?? '');
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : id;
};
const dayText = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function ScoreDetails({ d }) {
  if (!d || d.from === 'v1' || String(d.source).startsWith('v1')) return null; // v1 imports have their own line below
  const parts = [];
  if (d.from === 'rule') parts.push(`Scored ${dayText(d.at)} by a rule, not AI (a list of jobs or a site you skip)`);
  else parts.push(`Scored ${dayText(d.at)}${d.model ? ` by ${modelName(d.model)}` : ''}`);
  if (d.from === 'text') parts.push('from the posting text');
  if (d.from === 'title') parts.push(`from the title only, so capped at 5${d.uncappedScore ? ` (it would be ${d.uncappedScore})` : ''}`);
  const p = d.prompt;
  if (p) {
    const which = p.kind === 'default' ? 'the default prompt' : p.kind === 'edit' ? `your prompt edit of ${dayText(p.editedAt)}${p.note ? ` (${p.note})` : ''}` : 'an earlier version of the prompt';
    parts.push(`with ${which}${p.current ? '' : ', since changed'}`);
  }
  const stale = d.textSinceScore || (p && !p.current);
  return (
    <p className="score-details muted small">
      {parts.join(' · ')}.
      {stale && <span className="budget warn"> {d.textSinceScore ? 'A description was added since: Re-score to use it.' : 'Re-score to use the current prompt.'}</span>}
    </p>
  );
}

// The job's next steps (server/today.js, the same rules as Home's Today list): open reminders with their due dates, an
// offer to answer, or a follow-up due. Opening a job from Today or the Inbox lands here, on the task.
const STEP_LABELS = { assessment: 'Assessment', interview: 'Interview', offer: 'Offer', follow_up: 'Follow up', stale: 'Stale' };
const dueText = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// The link without its scheme and "www.", shortened for the header: "execthread.com/jobs/1234".
const shortUrl = (url) => {
  try {
    const u = new URL(url);
    const text = `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}${u.search}`;
    return text.length > 70 ? `${text.slice(0, 69)}…` : text;
  } catch {
    return url;
  }
};

/**
 * The posting's link, and Skip this site: a note on why, then the site is on Settings > Job sites to skip, and the
 * saved jobs from it (this one included, unless you applied) can be removed in one step.
 */
function PostingLink({ url, demo, onChanged }) {
  const [mode, setMode] = useState(null); // null | 'ask' | { site, savedJobs } | { removed }
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const act = async (fn) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    }
  };
  const skip = (e) => {
    e.preventDefault();
    act(async () => {
      const r = await api.skipSite(url, note.trim());
      setMode({ site: r.site, savedJobs: r.sites.find((s) => s.site === r.site)?.savedJobs ?? 0 });
    });
  };
  return (
    <div className="posting-url small">
      {demo ? <span className="muted">{shortUrl(url)}</span> : <a href={url} target="_blank" rel="noreferrer" title={url}>{shortUrl(url)}</a>}
      {!demo && mode === null && (
        <button type="button" className="link-button" onClick={() => setMode('ask')} title="Never keep jobs from this site">
          Skip this site
        </button>
      )}
      {mode === 'ask' && (
        <form className="row skip-ask" onSubmit={skip}>
          <input aria-label="Why skip this site (optional)" value={note} maxLength={300} placeholder="Why (optional), e.g. paywall" onChange={(e) => setNote(e.target.value)} />
          <button type="submit" className="primary">Skip this site</button>
          <button type="button" className="link" onClick={() => setMode(null)}>Cancel</button>
        </form>
      )}
      {mode?.site && (
        <div className="row">
          <span>
            Skipping {mode.site}: new jobs from it are never kept (Settings &gt; Job sites to skip).
          </span>
          {mode.savedJobs > 0 && (
            <button
              type="button"
              onClick={() =>
                act(async () => {
                  const r = await api.removeSiteJobs(mode.site);
                  setMode({ removed: r.removed, from: mode.site });
                  await onChanged();
                })
              }
            >
              Remove the {mode.savedJobs === 1 ? 'saved job' : `${mode.savedJobs} saved jobs`} from it
            </button>
          )}
        </div>
      )}
      {mode?.removed !== undefined && <span>Removed {mode.removed === 1 ? '1 saved job' : `${mode.removed} saved jobs`} from {mode.from} (archived and marked passed).</span>}
      {error && <span className="error">{error}</span>}
    </div>
  );
}

function NextSteps({ steps, busy, onPrepare, onDone, onFindContact, onCloseNoResponse }) {
  if (!steps?.length) return null;
  return (
    <section className="next-steps" aria-label="Next step">
      <h3>Next step</h3>
      {steps.map((t, i) => (
        <div key={t.id ?? `${t.kind}-${i}`} className="next-step">
          <span className={`badge today-${t.kind}${t.overdue ? ' overdue' : ''}`}>{STEP_LABELS[t.kind] ?? t.kind}</span>
          <span className="next-step-text">
            <b>{t.text}</b>
            {t.due && <span className="muted small">{t.overdue ? 'Was due' : 'Due'} {dueText(t.due)}</span>}
          </span>
          <span className="row">
            {t.kind === 'interview' && (
              <button type="button" className="demo-hide" onClick={onPrepare}>
                Prepare for a meeting
              </button>
            )}
            {t.id && (
              <button type="button" className="demo-hide" onClick={() => onDone(t.id)}>
                Done
              </button>
            )}
            {(t.kind === 'follow_up' || t.kind === 'stale') && (
              <button type="button" disabled={busy} onClick={onFindContact} title="Web search on your AI for the hiring manager or a recruiter, and a short note to send (saved in Notes)">
                Find someone to contact
              </button>
            )}
            {(t.kind === 'follow_up' || t.kind === 'stale') && (
              <button type="button" className={`demo-hide${t.kind === 'stale' ? ' primary' : ''}`} disabled={busy} onClick={onCloseNoResponse}>
                Close: no response
              </button>
            )}
          </span>
        </div>
      ))}
    </section>
  );
}

export default function DetailPanel({ id, onClose, onChanged, onOpen }) {
  const lk = useLookups();
  const demo = useDemo();
  const me = useMe();
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [terms, setTerms] = useState({ rateText: '', hoursText: '' });
  const [paste, setPaste] = useState('');
  const [task, setTask] = useState(null);
  const [contactSample, setContactSample] = useState(null); // the demo's canned Find someone to contact answer
  useEffect(() => setContactSample(null), [id]);
  const [copied, setCopied] = useState(false);
  const [askPrep, setAskPrep] = useState(0); // the Next step box's Prepare for a meeting opens the prep form
  // With a Google Doc, the letter's text is shown on request; without one (other users), always.
  const [showText, setShowText] = useState(false);
  const [ident, setIdent] = useState(null); // { title, company } while editing

  const load = async () => {
    try {
      const j = await api.get(id);
      setJob(j);
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
    setIdent(null);
    load();
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id]);

  // A dialog for the keyboard and screen readers: focus moves into the panel when it opens, Tab stays inside it, and
  // closing it puts focus back on whatever opened it (a job's title, a Today row, an Inbox link).
  const panelRef = useRef(null);
  useEffect(() => {
    const opener = document.activeElement;
    panelRef.current?.focus();
    return () => {
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);
  const trapTab = (e) => {
    if (e.key !== 'Tab' || !panelRef.current) return;
    const items = [...panelRef.current.querySelectorAll('a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')].filter(
      (el) => !el.disabled && el.offsetParent !== null,
    );
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

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
  const fractional = lk.showsTerms(job?.track);

  return (
    <div className="panel-backdrop" onClick={onClose}>
      <aside
        className="panel"
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={job ? 'panel-title' : undefined}
        aria-label={job ? undefined : 'Job details'}
        onKeyDown={trapTab}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="close" onClick={onClose} aria-label="Close">×</button>
        {!job && !error && <p className="muted">Loading…</p>}
        {error && <div className="error">{error}</div>}
        {job && (
          <>
            <div className="panel-head">
              <span className={scoreClass(job.score)}>{job.score ?? '–'}{job.fit && <span className="fit"> {job.fit}</span>}</span>
              <div>
                {ident ? (
                  <form
                    className="ident-edit"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      await save({ title: ident.title, company: ident.company });
                      setIdent(null);
                    }}
                  >
                    <label>
                      Title
                      <input value={ident.title} onChange={(e) => setIdent((v) => ({ ...v, title: e.target.value }))} required autoFocus />
                    </label>
                    <label>
                      Company
                      <input value={ident.company} onChange={(e) => setIdent((v) => ({ ...v, company: e.target.value }))} required />
                    </label>
                    <div className="row">
                      <button type="submit" className="primary">Save</button>
                      <button type="button" onClick={() => setIdent(null)}>Cancel</button>
                    </div>
                  </form>
                ) : (
                  <>
                    <h2 id="panel-title">{job.title}</h2>
                    <div className="muted">
                      {job.company}
                      {job.location ? ` · ${job.location}` : ''} · {sourceLabel(job.source)}
                      <button className="link-button demo-hide" onClick={() => setIdent({ title: job.title, company: job.company })} title="Fix the title or company so duplicates are recognized">
                        Edit
                      </button>
                    </div>
                  </>
                )}
                {job.url && <PostingLink key={job.id} url={job.url} demo={demo} onChanged={async () => { await load(); onChanged(); }} />}
                {job.pay && (
                  <div className="small">
                    Pay: {payText(job)}
                    {job.annualized && job.pay.unit !== 'year' ? ` (about ${annualText(job.annualized)})` : ''}
                    <span className="muted"> · {PAY_FROM[job.pay.from]}</span>
                  </div>
                )}
              </div>
            </div>

            <NextSteps
              steps={job.nextSteps}
              onPrepare={() => setAskPrep((n) => n + 1)}
              onDone={async (id) => {
                await api.closeReminder(id, 'done').catch((err) => setError(err.message));
                await load();
                onChanged();
              }}
              busy={busy}
              onFindContact={async () => {
                setError(null);
                try {
                  // The demo shows a canned sample (no AI, nothing saved); the real app runs the search as a task.
                  if (demo) {
                    setContactSample((await api.findContactSample(job.id)).markdown);
                    return;
                  }
                  const final = await followTask((await api.findContact(job.id)).taskId, setTask);
                  if (final.status === 'done') {
                    await load();
                    onChanged();
                  }
                } catch (err) {
                  setError(err.message);
                }
              }}
              onCloseNoResponse={async () => {
                setError(null);
                try {
                  await api.closeNoResponse(job.id);
                  await load();
                  onChanged();
                } catch (err) {
                  setError(err.message);
                }
              }}
            />
            {/* The search's progress right under the step that started it; the result lands in Notes. */}
            {contactSample && (
              <section className="sample-result" aria-label="Sample result">
                <p className="small">
                  <b>Sample result.</b> In the real app this searches the web on your AI (about 10 to 30 cents) and saves the answer under Notes. This demo used no AI and saved
                  nothing; the people are made up.{' '}
                  <button type="button" className="link" onClick={() => setContactSample(null)}>
                    Hide
                  </button>
                </p>
                <Markdown text={contactSample} />
              </section>
            )}
            {task?.kind === 'find-contact' && <TaskProgress task={task} />}
            {task?.kind === 'find-contact' && task.status === 'done' && <p className="muted small">Saved under Notes below. Check each person on LinkedIn before you write.</p>}

            <div className="links">
              {job.url && !demo && <a className="button primary" href={job.url} target="_blank" rel="noreferrer">Open posting / apply ↗</a>}
              {job.letter?.url && <a className="button" href={job.letter.url} target="_blank" rel="noreferrer">Cover letter (Google Doc) ↗</a>}
              {job.tweaks && <button onClick={copyTweaks}>{copied ? 'Copied!' : 'Copy resume tweaks'}</button>}
            </div>
            {job.copies?.length > 0 && (
              <div className="warn-box copies">
                <strong>Looks like the same job as:</strong>
                {job.copies.map((c) => (
                  <div key={c.id} className="copy-row">
                    <span>
                      {c.title} at {c.company} · {lk.label('stage', c.stage)}, {lk.label('status', c.status)}
                      {c.appliedOn ? ` ${c.appliedOn}` : ''} (#{c.id})
                    </span>
                    <span className="row">
                      {onOpen && <button onClick={() => onOpen(c.id)}>Open it</button>}
                      {lk.groupOf('stage', job.stage) !== 'archived' && <button className="demo-hide" onClick={() => save({ duplicateOf: c.id })}>Mark this one duplicate</button>}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {job.letter?.flags?.length > 0 && <div className="warn-box">Cover letter needs review: {job.letter.flags.join('; ')}</div>}
            {job.letter && !job.letter.url && !demo && isOwner(me) && <div className="warn-box">The cover letter was written but not saved as a Doc yet; the next run retries it.</div>}

            <fieldset className="grid2 plain" disabled={demo}>
              <label>
                Status
                <select value={job.status} onChange={(e) => save({ status: e.target.value })}>
                  {lk.options('status', job.status).map((s) => (
                    <option key={s.id} value={s.id}>{lk.label('status', s.id, { markArchived: true })}</option>
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
                  {lk.options('stage', job.stage).map((s) => (
                    <option key={s.id} value={s.id}>{lk.label('stage', s.id, { markArchived: true })}</option>
                  ))}
                </select>
              </label>
              <label>
                Track
                <select value={job.track} onChange={(e) => save({ track: e.target.value })}>
                  {lk.options('track', job.track).map((t) => (
                    <option key={t.id} value={t.id}>{lk.label('track', t.id, { markArchived: true })}</option>
                  ))}
                </select>
              </label>
            </fieldset>

            {fractional && (
              <fieldset className="terms-box plain" disabled={demo}>
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
              </fieldset>
            )}

            <section>
              <h3 className="with-icon"><DashIcon name="score" />Why it fits</h3>
              {a.whyItFits || job.reason ? <p>{a.whyItFits ?? job.reason}</p> : null}
              <ScoreDetails d={job.scoreDetails} />
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

            <Notes key={job.id} jobId={job.id} entries={job.noteEntries ?? []} onChanged={async () => { await load(); onChanged(); }} />

            <MeetingPrep job={job} askSignal={askPrep} onChanged={async () => { await load(); onChanged(); }} />

            {!demo && <Attachments jobId={job.id} items={job.attachments ?? []} onChanged={async () => { await load(); onChanged(); }} />}

            {job.needsDescription && !demo && (
              <section className="warn-box">
                <h3>Needs a description</h3>
                <p className="small">The posting could not be read automatically. Paste the job description to score it and write materials.</p>
                <textarea rows={6} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Paste the job description" />
                <button disabled={paste.trim().length < 100} onClick={async () => { await save({ description: paste }); await run('score'); }}>
                  Save and score
                </button>
              </section>
            )}

            {!demo && (
            <section>
              <h3>Actions</h3>
              <div className="links">
                <button disabled={busy} onClick={() => run(job.letter ? 'regenerate' : 'write-materials')}>
                  {job.letter ? 'Regenerate letter and tweaks' : 'Write resume tweaks and cover letter'}
                </button>
                <button disabled={busy} onClick={() => run('score')}>Re-score</button>
                {job.url && <button disabled={busy} onClick={() => run('refetch')}>Refetch posting</button>}
              </div>
              {task?.kind !== 'find-contact' && <TaskProgress task={task} />}
            </section>
            )}

            <LetterSection job={job} onChanged={async () => { await load(); onChanged(); }} />

            {job.tweaks && (
              <section>
                <h3 className="with-icon"><DashIcon name="resume" />Resume tweaks</h3>
                {job.tweaks.resume && <p className="muted small">For your resume: {job.tweaks.resume}</p>}
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
