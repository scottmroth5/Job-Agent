// The in-app scheduler: runs the pipeline, inbox check, and backup at set times while the server runs, so the
// same schedule works on Windows and in the cloud (no Task Scheduler, no cron). Times are in the app's time zone
// (TZ in .env). Each job is set by an environment variable and is off when it is unset:
//   SCHEDULE_PIPELINE="Mon,Thu 06:00"   the pipeline, then an inbox check when Gmail is set up
//   SCHEDULE_INBOX="daily 12:00"        an extra inbox check
//   SCHEDULE_BACKUP="daily 23:00"       the encrypted backup
//   SCHEDULE_RESTORE_TEST="monthly 1 05:00"  restores the newest backup into a scratch copy and checks it; on by default
//                                       (monthly 1 05:00) whenever SCHEDULE_BACKUP is set; "off" turns it off
// A spec is a day list (daily, weekdays, weekends, or names like Mon,Thu) and a 24-hour time (HH:MM), or several of
// those joined by "|" for different times on different days: "Mon,Thu 06:00 | Sat 09:00".
// A run missed while the server was off (or the computer asleep) runs when it comes back, if the missed time was
// within the last 12 hours and the job has not run since.

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const FULL_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const GROUPS = { daily: [0, 1, 2, 3, 4, 5, 6], weekdays: [1, 2, 3, 4, 5], weekends: [0, 6] };
export const CATCH_UP_HOURS = 12;
export const DEFAULT_RESTORE_TEST = 'monthly 1 05:00';
const CHECK_EVERY_MS = 30 * 1000;

/**
 * Parses "Mon,Thu 06:00", "daily 23:00", or "weekdays 7:30", and several of those joined by "|" ("Mon,Thu 06:00 | Sat 09:00"),
 * which run at each part's times. Throws a message that says what is wrong.
 */
export function parseSchedule(spec) {
  // Monthly: "monthly 1 05:00" runs on that day of the month (1 to 28, so every month has it).
  const monthly = /^\s*monthly\s+(\d{1,2})\s+(\d{1,2}):(\d{2})\s*$/i.exec(String(spec ?? ''));
  if (monthly) {
    const [monthDay, hour, minute] = monthly.slice(1).map(Number);
    if (monthDay < 1 || monthDay > 28) throw new Error(`"${spec}": the day of the month must be 1 to 28.`);
    if (hour > 23 || minute > 59) throw new Error(`"${spec}": the time must be between 00:00 and 23:59.`);
    return { spec: String(spec).trim(), monthDay, hour, minute, days: null };
  }
  const parts = String(spec ?? '').split('|');
  if (parts.length > 1) {
    const parsed = parts.map((p) => parseSchedule(p));
    return { ...parsed[0], spec: String(spec).trim(), parts: parsed };
  }
  const m = /^\s*([a-z,\s]+?)\s+(\d{1,2}):(\d{2})\s*$/i.exec(String(spec ?? ''));
  if (!m) throw new Error(`"${spec}" is not a schedule; use days and a time, like "Mon,Thu 06:00" or "daily 23:00".`);
  const [, daysText, hh, mm] = m;
  const hour = Number(hh);
  const minute = Number(mm);
  if (hour > 23 || minute > 59) throw new Error(`"${spec}": the time must be between 00:00 and 23:59.`);
  const days = new Set();
  for (const part of daysText.toLowerCase().split(/[\s,]+/).filter(Boolean)) {
    if (GROUPS[part]) GROUPS[part].forEach((d) => days.add(d));
    else {
      const d = DAY_NAMES.indexOf(part.slice(0, 3));
      if (d < 0 || !FULL_NAMES[d].startsWith(part)) throw new Error(`"${spec}": "${part}" is not a day.`);
      days.add(d);
    }
  }
  return { spec: String(spec).trim(), days, hour, minute };
}

// Whether a schedule runs on a date: its day of the month, or one of its weekdays.
const onDay = (s, t) => (s.monthDay ? t.getDate() === s.monthDay : s.days.has(t.getDay()));
const at = (base, s) => new Date(base.getFullYear(), base.getMonth(), base.getDate(), s.hour, s.minute, 0, 0);

/** The next scheduled time strictly after `from`, in local time (the earliest of the parts' next times). */
export function nextRun(s, from = new Date()) {
  if (s.parts) return s.parts.map((p) => nextRun(p, from)).filter(Boolean).sort((a, b) => a - b)[0] ?? null;
  for (let i = 0; i <= (s.monthDay ? 62 : 7); i += 1) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
    const t = at(day, s);
    if (onDay(s, t) && t > from) return t;
  }
  return null;
}

/** The latest scheduled time at or before `when` (the latest of the parts' last times). */
export function lastRun(s, when = new Date()) {
  if (s.parts) return s.parts.map((p) => lastRun(p, when)).filter(Boolean).sort((a, b) => b - a)[0] ?? null;
  for (let i = 0; i <= (s.monthDay ? 62 : 7); i += 1) {
    const day = new Date(when.getFullYear(), when.getMonth(), when.getDate() - i);
    const t = at(day, s);
    if (onDay(s, t) && t <= when) return t;
  }
  return null;
}

/** The jobs set in the environment: [{ name, schedule }]. Throws on a bad spec, so a typo never silently disables a job. */
export function schedulesFromEnv(env = process.env) {
  const jobs = [];
  for (const [name, key] of [['pipeline', 'SCHEDULE_PIPELINE'], ['inbox', 'SCHEDULE_INBOX'], ['backup', 'SCHEDULE_BACKUP']]) {
    if (env[key]?.trim()) jobs.push({ name, schedule: parseSchedule(env[key]) });
  }
  // The restore test follows the backup: monthly by default once backups are scheduled, unless turned off.
  const restore = env.SCHEDULE_RESTORE_TEST?.trim() || (env.SCHEDULE_BACKUP?.trim() ? DEFAULT_RESTORE_TEST : '');
  if (restore && restore.toLowerCase() !== 'off') jobs.push({ name: 'restore-test', schedule: parseSchedule(restore) });
  return jobs;
}

/**
 * @param {object} o
 * @param {Array<{ name: string, schedule: object, run: () => Promise<void>, lastRanAt: () => string|null }>} o.jobs
 *   run starts the job and resolves when it is done; lastRanAt is when it last started (ISO), from the runs table
 * @param {() => Date} [o.now]
 * @param {{ info: Function, warn: Function }} [o.log]
 * @param {(fn: Function, ms: number) => any} [o.every]  setInterval (injectable for tests)
 * @param {(name: string, ok: boolean, error: string|null) => unknown} [o.onResult]  after each run (server/alerts.js)
 */
export function createScheduler({ jobs, now = () => new Date(), log = console, every = setInterval, clear = clearInterval, onResult = null }) {
  const state = jobs.map((j) => ({ ...j, next: nextRun(j.schedule, now()), running: false, lastResult: null }));
  let timer = null;

  const fire = async (job, why) => {
    if (job.running) return;
    job.running = true;
    log.info?.(`[schedule] ${job.name}: starting (${why})`);
    let error = null;
    try {
      await job.run();
      job.lastResult = 'ok';
    } catch (err) {
      error = err.message;
      job.lastResult = 'failed';
      log.warn?.(`[schedule] ${job.name}: ${err.message}`);
    } finally {
      job.running = false;
    }
    // Tell the alerts (an email on failure, recovery on success); a problem there never changes the job's result.
    if (onResult) await Promise.resolve().then(() => onResult(job.name, !error, error)).catch(() => {});
  };

  const tick = () => {
    const t = now();
    for (const job of state) {
      if (job.next && t >= job.next) {
        job.next = nextRun(job.schedule, t);
        fire(job, 'scheduled');
      }
    }
  };

  return {
    /** Starts checking, after running any job whose last scheduled time was missed. */
    start() {
      const t = now();
      for (const job of state) {
        const missed = lastRun(job.schedule, t);
        const ran = job.lastRanAt();
        if (missed && t - missed <= CATCH_UP_HOURS * 3600 * 1000 && (!ran || new Date(ran) < missed)) fire(job, 'missed while the server was off');
      }
      timer = every(tick, CHECK_EVERY_MS);
      timer?.unref?.();
      return this;
    },
    stop() {
      if (timer) clear(timer);
      timer = null;
    },
    tick,
    /** For the UI: each job, its schedule, and when it runs next. */
    status: () => state.map((j) => ({ name: j.name, schedule: j.schedule.spec, next: j.next?.toISOString() ?? null, running: j.running, lastResult: j.lastResult })),
  };
}
