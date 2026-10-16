// The in-app scheduler: runs the pipeline, inbox check, and backup at set times while the server runs, so the
// same schedule works on Windows and in the cloud (no Task Scheduler, no cron). Times are in the app's time zone
// (TZ in .env). Each job is set by an environment variable and is off when it is unset:
//   SCHEDULE_PIPELINE="Mon,Thu 06:00"   the pipeline, then an inbox check when Gmail is set up
//   SCHEDULE_INBOX="daily 12:00"        an extra inbox check
//   SCHEDULE_BACKUP="daily 23:00"       the encrypted backup
// A spec is a day list (daily, weekdays, weekends, or names like Mon,Thu) and a 24-hour time (HH:MM).
// A run missed while the server was off (or the computer asleep) runs when it comes back, if the missed time was
// within the last 12 hours and the job has not run since.

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const FULL_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const GROUPS = { daily: [0, 1, 2, 3, 4, 5, 6], weekdays: [1, 2, 3, 4, 5], weekends: [0, 6] };
export const CATCH_UP_HOURS = 12;
const CHECK_EVERY_MS = 30 * 1000;

/** Parses "Mon,Thu 06:00", "daily 23:00", or "weekdays 7:30". Throws a message that says what is wrong. */
export function parseSchedule(spec) {
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

const at = (base, s) => new Date(base.getFullYear(), base.getMonth(), base.getDate(), s.hour, s.minute, 0, 0);

/** The next scheduled time strictly after `from`, in local time. */
export function nextRun(s, from = new Date()) {
  for (let i = 0; i <= 7; i += 1) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
    const t = at(day, s);
    if (s.days.has(t.getDay()) && t > from) return t;
  }
  return null;
}

/** The latest scheduled time at or before `when`. */
export function lastRun(s, when = new Date()) {
  for (let i = 0; i <= 7; i += 1) {
    const day = new Date(when.getFullYear(), when.getMonth(), when.getDate() - i);
    const t = at(day, s);
    if (s.days.has(t.getDay()) && t <= when) return t;
  }
  return null;
}

/** The jobs set in the environment: [{ name, schedule }]. Throws on a bad spec, so a typo never silently disables a job. */
export function schedulesFromEnv(env = process.env) {
  const jobs = [];
  for (const [name, key] of [['pipeline', 'SCHEDULE_PIPELINE'], ['inbox', 'SCHEDULE_INBOX'], ['backup', 'SCHEDULE_BACKUP']]) {
    if (env[key]?.trim()) jobs.push({ name, schedule: parseSchedule(env[key]) });
  }
  return jobs;
}

/**
 * @param {object} o
 * @param {Array<{ name: string, schedule: object, run: () => Promise<void>, lastRanAt: () => string|null }>} o.jobs
 *   run starts the job and resolves when it is done; lastRanAt is when it last started (ISO), from the runs table
 * @param {() => Date} [o.now]
 * @param {{ info: Function, warn: Function }} [o.log]
 * @param {(fn: Function, ms: number) => any} [o.every]  setInterval (injectable for tests)
 */
export function createScheduler({ jobs, now = () => new Date(), log = console, every = setInterval, clear = clearInterval }) {
  const state = jobs.map((j) => ({ ...j, next: nextRun(j.schedule, now()), running: false, lastResult: null }));
  let timer = null;

  const fire = async (job, why) => {
    if (job.running) return;
    job.running = true;
    log.info?.(`[schedule] ${job.name}: starting (${why})`);
    try {
      await job.run();
      job.lastResult = 'ok';
    } catch (err) {
      job.lastResult = 'failed';
      log.warn?.(`[schedule] ${job.name}: ${err.message}`);
    } finally {
      job.running = false;
    }
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
