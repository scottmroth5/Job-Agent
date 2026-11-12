import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../api.ts';
import type { ApiBody, ApiResponse } from '../api.ts';
import { dateTime } from '../format.ts';

type Automation = ApiResponse<'GET /api/account/automation'>;
type Body = ApiBody<'PUT /api/account/automation'>;
/** One run time: the days it runs (0 is Sunday) and a 24-hour time, "06:00". */
type Slot = { days: number[]; time: string };

// Shown Monday first; the numbers are JavaScript's (0 is Sunday), as server/scheduler.ts reads them.
const DAYS: Array<[number, string]> = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
const NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const GROUPS: Record<string, number[]> = { daily: [0, 1, 2, 3, 4, 5, 6], weekdays: [1, 2, 3, 4, 5], weekends: [0, 6] };

/** A schedule spec ("Mon,Thu 06:00 | Sat 09:00") as run times, or null when this screen cannot show it (a monthly one). */
export function slotsOf(spec: string | null | undefined): Slot[] | null {
  if (!spec) return [];
  const slots: Slot[] = [];
  for (const part of spec.split('|')) {
    const m = /^\s*([a-z,\s]+?)\s+(\d{1,2}):(\d{2})\s*$/i.exec(part);
    if (!m) return null;
    const days = new Set<number>();
    for (const word of m[1].toLowerCase().split(/[\s,]+/).filter(Boolean)) {
      if (GROUPS[word]) GROUPS[word].forEach((d) => days.add(d));
      else if (NAMES.includes(word.slice(0, 3))) days.add(NAMES.indexOf(word.slice(0, 3)));
      else return null;
    }
    slots.push({ days: [...days], time: `${m[2].padStart(2, '0')}:${m[3]}` });
  }
  return slots;
}

/** Run times as a schedule spec, or null for none; a time with no days is left out. */
export function specOf(slots: Slot[]): string | null {
  const parts = slots
    .filter((s) => s.days.length && /^\d{2}:\d{2}$/.test(s.time))
    .map((s) => `${s.days.length === 7 ? 'daily' : DAYS.filter(([d]) => s.days.includes(d)).map(([, n]) => n).join(',')} ${s.time}`);
  return parts.length ? parts.join(' | ') : null;
}

/** Run times: a row of day checkboxes and a time for each, with Add a time and Remove. */
function Times({ label, slots, onChange }: { label: string; slots: Slot[]; onChange: (slots: Slot[]) => void }) {
  const change = (i: number, slot: Slot) => onChange(slots.map((s, j) => (j === i ? slot : s)));
  return (
    <fieldset className="automation-times">
      <legend>{label}</legend>
      {slots.length === 0 && <p className="muted small">No times yet.</p>}
      {slots.map((slot, i) => (
        <div className="automation-slot" key={i}>
          {DAYS.map(([d, name]) => (
            <label className="switch" key={d}>
              <input
                type="checkbox"
                checked={slot.days.includes(d)}
                onChange={(e) => change(i, { ...slot, days: e.target.checked ? [...slot.days, d] : slot.days.filter((x) => x !== d) })}
              />
              {name}
            </label>
          ))}
          <label className="switch">
            at
            <input type="time" value={slot.time} onChange={(e) => change(i, { ...slot, time: e.target.value })} aria-label={`${label}: time ${i + 1}`} />
          </label>
          <button type="button" onClick={() => onChange(slots.filter((_, j) => j !== i))} aria-label={`Remove time ${i + 1}`}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...slots, { days: [1, 4], time: '06:00' }])}>
        Add a time
      </button>
    </fieldset>
  );
}

/**
 * Settings > Automatic runs (agents/automation.ts): whether the pipeline (and, for the owner, the inbox check) runs
 * on its own, when, and which Claude steps a scheduled pipeline does. Off is manual runs only: nothing starts unless
 * you press a button. The switch saves at once; the times and steps save with Save.
 */
export default function AutomationSettings() {
  const [data, setData] = useState<Automation | null>(null);
  const [pipeline, setPipeline] = useState<Slot[]>([]);
  const [inbox, setInbox] = useState<Slot[]>([]);
  const [custom, setCustom] = useState(false);
  const [steps, setSteps] = useState({ score: true, letters: true });
  const [afterPipeline, setAfterPipeline] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const show = (d: Automation) => {
    setData(d);
    const p = slotsOf(d.pipeline);
    const i = slotsOf(d.inbox?.schedule);
    setCustom(p == null || i == null);
    setPipeline(p ?? []);
    setInbox(i ?? []);
    setSteps(d.steps);
    setAfterPipeline(d.inbox?.afterPipeline ?? true);
  };
  useEffect(() => {
    api.automation().then(show, (err: Error) => setError(err.message));
  }, []);

  const body = (on: boolean): Body => ({
    on,
    pipeline: specOf(pipeline),
    steps,
    ...(data?.owner ? { inbox: { afterPipeline, schedule: specOf(inbox) } } : {}),
  });
  const save = async (next: Body, done: string) => {
    setError(null);
    setNote(null);
    try {
      show(await api.saveAutomation(next));
      setNote(done);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save(body(Boolean(data?.on)), 'Saved.');
  };

  if (!data) return <section className="home-card"><h2>Automatic runs</h2>{error ? <div className="error">{error}</div> : <p className="muted">Loading…</p>}</section>;
  const next = [data.next.pipeline && `pipeline ${dateTime(data.next.pipeline)}`, data.next.inbox && `inbox ${dateTime(data.next.inbox)}`].filter(Boolean).join(', ');
  return (
    <section className="home-card" id="automatic-runs">
      <h2>Automatic runs</h2>
      <label className="switch check-row">
        <input type="checkbox" checked={data.on} onChange={(e) => void save(body(e.target.checked), e.target.checked ? 'Automatic runs are on.' : 'Automatic runs are off: manual runs only.')} />
        Run automatically on the times below
      </label>
      {data.on ? (
        <p className="small">{next ? `Next: ${next}.` : 'On, but no time is set yet: add one below and save.'}</p>
      ) : (
        <p className="manual-only" role="status">
          <span className="badge warn">Manual runs only</span> Automatic runs are off. Nothing runs, and no Claude is used, unless you press a button.
        </p>
      )}
      <form onSubmit={submit}>
        <fieldset disabled={!data.on} className="automation-fields">
          {custom && <p className="muted small">Your saved times are in a form this screen cannot show (a monthly time, say). Saving here replaces them.</p>}
          <Times label="Pipeline (find, score, write materials, archive)" slots={pipeline} onChange={setPipeline} />
          <fieldset className="automation-times">
            <legend>What a scheduled pipeline does with Claude</legend>
            <label className="switch">
              <input type="checkbox" checked={steps.score} onChange={(e) => setSteps({ ...steps, score: e.target.checked })} />
              Score new jobs
            </label>
            <label className="switch">
              <input type="checkbox" checked={steps.letters} onChange={(e) => setSteps({ ...steps, letters: e.target.checked })} />
              Write cover letters and resume tweaks for promoted jobs
            </label>
            <p className="muted small">Finding jobs uses no Claude, so it always runs. Run pipeline on Home still does every step.</p>
          </fieldset>
          {data.owner && (
            <>
              <label className="switch check-row">
                <input type="checkbox" checked={afterPipeline} onChange={(e) => setAfterPipeline(e.target.checked)} />
                Check the inbox after each scheduled pipeline run
              </label>
              <Times label="Inbox checks at their own times (optional)" slots={inbox} onChange={setInbox} />
            </>
          )}
          <button type="submit" className="primary">
            Save times
          </button>
        </fieldset>
      </form>
      <p className="muted small">Times are in {data.timeZone}. A run that comes due while another pipeline is running waits for it to finish.</p>
      {note && <p className="muted small">{note}</p>}
      {error && <div className="error">{error}</div>}
    </section>
  );
}
