// Automatic runs (v3 Phase 7: moved here from server/app.ts). Two halves, so the scheduler can be a process of its own:
//
// - scheduleView: what the API shows (Settings, the Run pipeline card, /api/schedule): each user's automatic runs and
//   when each runs next, worked out from their saved settings (agents/automation.ts) with tools/scheduler.ts, never from
//   a scheduler's memory, so the API answers the same whether the scheduler runs beside it or elsewhere.
// - createAutomaticRuns: the scheduler (tools/scheduler.ts) with each user's pipelines and inbox checks, and the app's
//   backup and restore test from .env. Each job starts the same task as its button and waits for it; a failed one of
//   the owner's alerts the owner. It syncs from everyone's settings at start, every few minutes, and within
//   CHANGE_CHECK_MS of a save: a save marks AUTOMATION_CHANGED (markAutomationChanged), which it watches.
//
// The scheduler only enqueues and reads the database: it holds no Claude, Google, or Gmail settings.
import { runAsUser } from '../db/scope.ts';
import { OWNER_ID } from '../db/users.ts';
import { getSetting, setSetting } from '../db/settings.ts';
import { automatedUsers, automationFor, skipArgs } from '../agents/automation.ts';
import { createScheduler, nextRun, parseSchedule } from '../tools/scheduler.ts';
import type { JobStore } from '../db/index.ts';
import type { AutomationDefaults } from '../agents/automation.ts';
import type { Schedule, ScheduledJob } from '../tools/scheduler.ts';
import type { Jobs } from './jobs.ts';
import type { StartPipeline } from './tasks/pipeline.ts';
import type { StartCheck } from './tasks/inbox.ts';
import type { createAlerts } from './alerts.ts';

/** The app setting a saved Automatic runs change bumps, so a scheduler in another process resyncs. */
export const AUTOMATION_CHANGED = 'automation_changed';
/** How often the scheduler looks for a saved change (and how soon after a save it takes effect). */
export const CHANGE_CHECK_MS = 30 * 1000;
/** The app's own scheduled jobs (from .env), as opposed to each user's automatic runs. */
const APP_JOBS = ['backup', 'restore-test'];

type Log = { info?: (text: string) => void; warn?: (text: string) => void };
type Kinds = { pipeline: boolean; inbox: boolean };

/** A user's job names: the owner's are "pipeline" and "inbox" (the names the alerts and the runs table know), anyone else's "pipeline:<id>". */
export const jobOf = (uid: number, kind: 'pipeline' | 'inbox') => (uid === OWNER_ID ? kind : `${kind}:${uid}`);

/** Marks a saved change for the scheduler (Settings > Automatic runs saves it; so does a paused or deleted account, at the next sync). */
export async function markAutomationChanged(store: JobStore) {
  await setSetting(store.admin, AUTOMATION_CHANGED, new Date().toISOString());
}

/** The .env default times for each user's automatic runs (Settings shows them until a user saves their own). */
export const defaultsOf = (schedules: Array<{ name: string; schedule: Schedule }> = []): AutomationDefaults => {
  const spec = (name: string) => schedules.find((j) => j.name === name)?.schedule.spec ?? null;
  return { pipeline: spec('pipeline'), inbox: spec('inbox') };
};

const off = () => process.env.AUTOMATIC_RUNS === 'off';
const parsed = (spec: string) => {
  try {
    return parseSchedule(spec);
  } catch {
    return null; // a saved value that no longer parses runs at no time (agents/automation.ts reads it the same way)
  }
};

/**
 * The automatic runs as the API shows them. kinds: whether this app runs pipelines and inbox checks at all (no
 * runPipeline, no Gmail: none). schedules: the .env jobs; backup and restore-test show for everyone.
 */
export function scheduleView({ store, schedules = [], kinds, enabled = true, now = () => new Date() }: { store: JobStore; schedules?: Array<{ name: string; schedule: Schedule }>; kinds: Kinds; enabled?: boolean; now?: () => Date }) {
  const defaults = defaultsOf(schedules);
  const appJobs = enabled ? schedules.filter((j) => APP_JOBS.includes(j.name)) : [];
  const next = (s: Schedule | null) => (s ? nextRun(s, now())?.toISOString() ?? null : null);

  /** Whether the user's automatic runs are on (an active account, on, and AUTOMATIC_RUNS not off), and their jobs. */
  async function mine(uid: number) {
    if (!enabled || off()) return { on: false, jobs: [] };
    if ((await store.admin.prepare('SELECT status FROM users WHERE id = ?').pluck().get(uid)) !== 'active') return { on: false, jobs: [] };
    const a = await automationFor(store.admin, uid, defaults);
    if (!a.on) return { on: false, jobs: [] };
    const jobs: Array<{ name: string; kind: 'pipeline' | 'inbox'; schedule: Schedule | null; spec: string }> = [];
    if (kinds.pipeline && a.pipeline) jobs.push({ name: jobOf(uid, 'pipeline'), kind: 'pipeline', schedule: parsed(a.pipeline), spec: a.pipeline });
    if (uid === OWNER_ID && kinds.inbox && a.inbox?.schedule) jobs.push({ name: 'inbox', kind: 'inbox', schedule: parsed(a.inbox.schedule), spec: a.inbox.schedule });
    return { on: true, jobs };
  }

  return {
    defaults,
    /** The user's next pipeline and inbox runs (Settings > Automatic runs). */
    async next(uid: number) {
      const { jobs } = await mine(uid);
      return { pipeline: next(jobs.find((j) => j.kind === 'pipeline')?.schedule ?? null), inbox: next(jobs.find((j) => j.kind === 'inbox')?.schedule ?? null) };
    },
    /** The Run pipeline card: whether automatic runs are on, and the next pipeline run and its schedule. */
    async pipeline(uid: number) {
      const { on, jobs } = await mine(uid);
      const job = jobs.find((j) => j.kind === 'pipeline');
      return { automatic: on, next: next(job?.schedule ?? null), schedule: job?.spec ?? null };
    },
    /** /api/schedule: the app's jobs and the user's own, never another user's. */
    async jobs(uid: number) {
      const { jobs } = await mine(uid);
      return [
        ...appJobs.map((j) => ({ name: j.name, schedule: j.schedule.spec, next: next(j.schedule) })),
        ...jobs.map((j) => ({ name: j.name, schedule: j.spec, next: next(j.schedule) })),
      ];
    },
  };
}

export type ScheduleView = ReturnType<typeof scheduleView>;

/**
 * The scheduler. starters are the task starters the buttons use (server/tasks): the pipeline, the inbox check (with
 * whether Gmail is set up), and the app's own tasks by name (backup, restore-test). alerts hears the owner's results.
 */
export function createAutomaticRuns({
  store,
  jobs,
  schedules = [],
  starters,
  alerts = null,
  log = console,
  waitMs = 5 * 1000,
  syncMs = 5 * 60 * 1000,
  changeMs = CHANGE_CHECK_MS,
}: {
  store: JobStore;
  jobs: Jobs;
  schedules?: Array<{ name: string; schedule: Schedule }>;
  starters: { pipeline?: StartPipeline | null; inbox?: { start: StartCheck; ready: () => boolean } | null; app?: Record<string, (() => Promise<string>) | null | undefined> };
  alerts?: ReturnType<typeof createAlerts> | null;
  log?: Log;
  /** How often a scheduled run checks whether its task has finished. */
  waitMs?: number;
  /** How often every user's settings are read again (a pause or a deleted account drops out). */
  syncMs?: number;
  /** How often a saved change is looked for. */
  changeMs?: number;
}) {
  const HOURS = 3600 * 1000;
  const defaults = defaultsOf(schedules);
  // Stopping ends every wait: a wait never reads a closed store or keeps the process alive.
  let closed = false;
  const sleeping = new Set<() => void>();
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        sleeping.delete(done);
        resolve();
      }
      sleeping.add(done);
    });
  // Waits for a scheduled task to finish (the queue runs it in its turn); a failed one fails the scheduled job, which
  // alerts the owner. Skipped (the type is turned off) and cancelled are not failures.
  const finish = async (taskId: string, hours: number) => {
    const uid = await jobs.queue.ownerOf(taskId);
    if (uid == null) return;
    const until = Date.now() + hours * HOURS;
    for (;;) {
      if (closed) throw Object.assign(new Error('The scheduler stopped before the run finished.'), { statusCode: 503 });
      const t = await jobs.queue.get(taskId, uid);
      if (!t || t.status === 'done' || t.status === 'skipped' || t.status === 'cancelled') return;
      if (t.status === 'failed' || t.status === 'dead') throw new Error(t.error ?? 'failed');
      if (Date.now() >= until) throw new Error(`The ${t.type} task did not finish in ${hours} hours.`);
      await sleep(waitMs);
    }
  };
  // Starting a task runs as its user, in their time zone (the owner's is the app's).
  const asUser = async (uid: number, fn: () => Promise<unknown>) => {
    const timeZone = uid === OWNER_ID ? null : (((await store.admin.prepare('SELECT time_zone FROM users WHERE id = ?').pluck().get(uid)) as string | null | undefined) ?? null);
    return await runAsUser(uid, fn, { timeZone });
  };
  // The user's settings when a run comes due, so a pause or a save since the last sync wins; null: run nothing.
  const current = async (uid: number) => {
    if ((await store.admin.prepare('SELECT status FROM users WHERE id = ?').pluck().get(uid)) !== 'active') return null;
    const a = await automationFor(store.admin, uid, defaults);
    return a.on ? a : null;
  };
  const { pipeline, inbox } = starters;
  const pipelineRun = (uid: number) => async () => {
    if (!pipeline) return;
    const run = (async () => {
      const a = await current(uid);
      if (!a) return;
      await asUser(uid, async () => {
        // Queued in its turn: one pipeline at a time across the app (the pipeline task type); 8 hours covers one ahead of it and its own 4.
        await finish(await pipeline({ by: 'schedule', args: skipArgs(a.steps) }), 8);
        // Then the owner's inbox, as the Windows scheduled run did; a pipeline failure above skips it.
        if (uid === OWNER_ID && a.inbox?.afterPipeline && inbox?.ready()) await finish(await inbox.start({ by: 'schedule' }), 1);
      });
    })();
    // Another user's failure is logged, never emailed to the owner (server/alerts.ts hears only the owner's jobs).
    if (uid === OWNER_ID) await run;
    else await run.catch((err: Error) => log.warn?.(`[schedule] pipeline for user ${uid}: ${err.message}`));
  };
  const inboxRun = async () => {
    if (!inbox) return;
    const a = await current(OWNER_ID);
    if (!a?.inbox?.schedule) return;
    // A check due while the owner's pipeline waits or runs waits for it (startCheck's depends_on).
    await asUser(OWNER_ID, async () => finish(await inbox.start({ by: 'schedule' }), 1));
  };
  // When a job last started, from the runs table; the owner's include runs from before runs had a user.
  const lastRanAt = (name: string, uid = OWNER_ID) => async () =>
    ((await store.admin
      .prepare(`SELECT started_at FROM runs WHERE name = ? AND (user_id = ? OR (? = ${OWNER_ID} AND user_id IS NULL)) ORDER BY id DESC LIMIT 1`)
      .pluck()
      .get(name, uid, uid)) as string | null | undefined) ?? null;
  const appRunners = starters.app ?? {};
  const scheduler = createScheduler({
    // The backup and the restore test are the app's, run as the owner (their runs are the owner's).
    jobs: schedules
      .filter((j) => APP_JOBS.includes(j.name) && appRunners[j.name])
      .map((j) => ({ ...j, run: async () => await asUser(OWNER_ID, async () => finish(await (appRunners[j.name] as () => Promise<string>)(), 1)), lastRanAt: lastRanAt(j.name) })),
    log,
    // A failed scheduled job of the owner's emails the owner (server/alerts.ts); the next success clears it. Another
    // user's jobs ("pipeline:<id>") never reach the alerts: job data goes to nobody but its own user.
    onResult: alerts ? (name, ok, error) => (name.includes(':') ? undefined : alerts.jobResult(name, ok, error)) : null,
  });

  let synced = new Set<string>();
  const syncNow = async () => {
    // AUTOMATIC_RUNS=off (a staging server holding a copy of the real data, v3 Phase 5) schedules nobody's runs, so a
    // rehearsal never spends on Claude or searches or runs the pipeline twice; the Run pipeline button still works.
    const on = off() ? [] : await automatedUsers(store.admin, defaults);
    const want = new Map<string, ScheduledJob>();
    for (const { uid, automation: a } of on) {
      const p = a.pipeline ? parsed(a.pipeline) : null;
      if (pipeline && p) want.set(jobOf(uid, 'pipeline'), { name: jobOf(uid, 'pipeline'), schedule: p, run: pipelineRun(uid), lastRanAt: lastRanAt('pipeline', uid) });
      const i = uid === OWNER_ID && a.inbox?.schedule ? parsed(a.inbox.schedule) : null;
      if (inbox && i) want.set('inbox', { name: 'inbox', schedule: i, run: inboxRun, lastRanAt: lastRanAt('inbox') });
    }
    for (const name of synced) if (!want.has(name)) scheduler.set(name, null);
    for (const [name, job] of want) scheduler.set(name, job);
    synced = new Set(want.keys());
  };
  const sync = async () => {
    await syncNow().catch((err: Error) => log.warn?.(`[schedule] automatic runs: ${err.message}`));
  };

  let lastChange: string | null = null;
  let lastTick = 0;
  const timers: Array<ReturnType<typeof setInterval>> = [];
  return {
    sync,
    status: () => scheduler.status(),
    /** Whether the scheduler looked for changes lately (its health check, apps/scheduler.ts). */
    healthy: () => Date.now() - lastTick < Math.max(3 * changeMs, 5_000),
    async start() {
      lastChange = await getSetting(store.admin, AUTOMATION_CHANGED).catch(() => null);
      lastTick = Date.now();
      await sync();
      await scheduler.start();
      timers.push(setInterval(() => void sync(), syncMs)); // sync catches its own errors
      timers.push(setInterval(() => {
        void getSetting(store.admin, AUTOMATION_CHANGED)
          .then(async (v) => {
            lastTick = Date.now();
            if (v === lastChange) return;
            lastChange = v;
            await sync();
          })
          .catch((err: Error) => log.warn?.(`[schedule] checking for saved changes: ${err.message}`));
      }, changeMs));
      for (const t of timers) t.unref();
    },
    stop() {
      closed = true;
      for (const done of [...sleeping]) done();
      scheduler.stop();
      for (const t of timers) clearInterval(t);
      timers.length = 0;
    },
  };
}

export type AutomaticRuns = ReturnType<typeof createAutomaticRuns>;
