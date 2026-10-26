// The in-app scheduler and the time zone helpers. Times are built in local time, so these pass in any zone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler, lastRun, nextRun, parseSchedule, schedulesFromEnv, CATCH_UP_HOURS } from '../server/scheduler.js';
import { createTaskRunner } from '../server/tasks.js';
import { dayOf, localDay, localDaysAgo } from '../tools/dates.js';

const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);

test('schedule specs: day names, groups, and times; mistakes are errors, not silently off', () => {
  const s = parseSchedule('Mon,Thu 06:00');
  assert.deepEqual([[...s.days].sort(), s.hour, s.minute], [[1, 4], 6, 0]);
  assert.deepEqual([...parseSchedule('weekdays 7:30').days].sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseSchedule('daily 23:00').days].length, 7);
  assert.deepEqual([...parseSchedule('monday, thursday 06:00').days].sort(), [1, 4]);
  for (const bad of ['Mon 25:00', 'Funday 06:00', 'monkey 06:00', '06:00', 'daily', '']) assert.throws(() => parseSchedule(bad), /schedule|time|day/, bad);
  assert.deepEqual(schedulesFromEnv({ SCHEDULE_PIPELINE: 'Mon,Thu 06:00', SCHEDULE_BACKUP: 'daily 23:00', SCHEDULE_INBOX: ' ' }).map((j) => j.name), ['pipeline', 'backup', 'restore-test'], 'the restore test follows the backup');
  assert.deepEqual(schedulesFromEnv({ SCHEDULE_BACKUP: 'daily 23:00', SCHEDULE_RESTORE_TEST: 'off' }).map((j) => j.name), ['backup']);
  assert.deepEqual(schedulesFromEnv({ SCHEDULE_PIPELINE: 'Mon 06:00' }).map((j) => j.name), ['pipeline'], 'no backup, no restore test');
  assert.throws(() => schedulesFromEnv({ SCHEDULE_BACKUP: 'nightly' }), /not a schedule/);
});

test('several parts joined by |: each part runs at its own times', () => {
  const s = parseSchedule('Mon,Thu 06:00 | Sat 09:30');
  assert.equal(s.spec, 'Mon,Thu 06:00 | Sat 09:30');
  // Friday Oct 16, 2026 at 10 PM: next is Saturday 9:30 (before Monday 6:00); last was Thursday 6:00.
  assert.deepEqual(nextRun(s, local(2026, 10, 16, 22)), local(2026, 10, 17, 9, 30));
  assert.deepEqual(lastRun(s, local(2026, 10, 16, 22)), local(2026, 10, 15, 6));
  // Saturday at noon: the last run is that morning's 9:30.
  assert.deepEqual(lastRun(s, local(2026, 10, 17, 12)), local(2026, 10, 17, 9, 30));
  assert.throws(() => parseSchedule('Mon 06:00 | Funday 07:00'), /not a day/);
  assert.throws(() => parseSchedule('Mon 06:00 |'), /not a schedule/);
  assert.equal(schedulesFromEnv({ SCHEDULE_PIPELINE: 'weekdays 06:00 | Sat 08:00' })[0].schedule.parts.length, 2);
});

test('monthly schedules: that day of each month, 1 to 28', () => {
  const s = parseSchedule('monthly 1 05:00');
  assert.deepEqual([s.monthDay, s.hour, s.minute], [1, 5, 0]);
  // Oct 16, 2026: next is Nov 1 at 5:00; last was Oct 1 at 5:00. A year end rolls over.
  assert.deepEqual(nextRun(s, local(2026, 10, 16, 12)), local(2026, 11, 1, 5));
  assert.deepEqual(lastRun(s, local(2026, 10, 16, 12)), local(2026, 10, 1, 5));
  assert.deepEqual(nextRun(s, local(2026, 12, 20)), local(2027, 1, 1, 5));
  assert.deepEqual(nextRun(s, local(2026, 11, 1, 4, 59)), local(2026, 11, 1, 5), 'the same day, before the time');
  for (const bad of ['monthly 31 05:00', 'monthly 0 05:00', 'monthly 1 25:00']) assert.throws(() => parseSchedule(bad), /day of the month|time/, bad);
});

test('next and last run times, in local time', () => {
  const s = parseSchedule('Mon,Thu 06:00');
  // Friday Oct 16, 2026 at 10 PM: next is Monday Oct 19 at 6:00; last was Thursday Oct 15 at 6:00.
  assert.deepEqual(nextRun(s, local(2026, 10, 16, 22)), local(2026, 10, 19, 6));
  assert.deepEqual(lastRun(s, local(2026, 10, 16, 22)), local(2026, 10, 15, 6));
  // Exactly at the time: it is the last run, and the next is the following one.
  assert.deepEqual(lastRun(s, local(2026, 10, 19, 6)), local(2026, 10, 19, 6));
  assert.deepEqual(nextRun(s, local(2026, 10, 19, 6)), local(2026, 10, 22, 6));
});

test('scheduler: runs a due job once, catches up a recently missed run, and skips one already done', async () => {
  let clock = local(2026, 10, 19, 5, 59);
  const ran = [];
  const jobs = [
    { name: 'pipeline', schedule: parseSchedule('Mon,Thu 06:00'), run: async () => ran.push('pipeline'), lastRanAt: () => local(2026, 10, 15, 6, 1).toISOString() },
    { name: 'backup', schedule: parseSchedule('daily 23:00'), run: async () => ran.push('backup'), lastRanAt: () => local(2026, 10, 18, 23, 0, 5).toISOString() },
  ];
  const scheduler = createScheduler({ jobs, now: () => clock, log: {}, every: () => null });
  scheduler.start();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ran, [], 'nothing missed: last night\'s backup ran, and the pipeline ran Thursday');

  clock = local(2026, 10, 19, 6, 0, 30);
  scheduler.tick();
  scheduler.tick();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ran, ['pipeline'], 'due once, not twice');
  assert.equal(scheduler.status().find((j) => j.name === 'pipeline').next, local(2026, 10, 22, 6).toISOString());

  // The server comes back at 7:00 AM after being off overnight (CATCH_UP_HOURS covers it): last night's backup
  // was missed and runs now.
  assert.ok(CATCH_UP_HOURS >= 8);
  const late = [];
  const back = createScheduler({
    jobs: [{ name: 'backup', schedule: parseSchedule('daily 23:00'), run: async () => late.push('backup'), lastRanAt: () => local(2026, 10, 17, 23).toISOString() }],
    now: () => local(2026, 10, 19, 7),
    log: {},
    every: () => null,
  }).start();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(late, ['backup']);
  back.stop();
});

test('scheduler: a failing job is logged and does not stop the next one', async () => {
  const warnings = [];
  let clock = local(2026, 10, 19, 5);
  const scheduler = createScheduler({
    jobs: [{ name: 'backup', schedule: parseSchedule('daily 06:00'), run: async () => { throw new Error('Drive is down'); }, lastRanAt: () => local(2026, 10, 18, 6).toISOString() }],
    now: () => clock,
    log: { warn: (m) => warnings.push(m), info: () => {} },
    every: () => null,
  }).start();
  clock = local(2026, 10, 19, 6, 1);
  scheduler.tick();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(warnings, ['[schedule] backup: Drive is down']);
  assert.equal(scheduler.status()[0].lastResult, 'failed');
});

test('tasks: wait resolves when the task ends, without polling', async () => {
  const tasks = createTaskRunner();
  let finish;
  const id = tasks.start('x', {}, () => new Promise((r) => { finish = r; }));
  const waiting = tasks.wait(id, 1000);
  await new Promise((r) => setImmediate(r)); // the task starts on the next turn
  finish('ok');
  assert.equal((await waiting).status, 'done');
  const slow = tasks.start('y', {}, () => new Promise(() => {}));
  await assert.rejects(tasks.wait(slow, 20), /did not finish/);
});

test('API: /api/schedule lists the jobs, and a missed backup runs as a task when the server starts', async () => {
  const { openJobStore } = await import('../db/index.js');
  const { buildApp } = await import('../server/app.js');
  const store = openJobStore(':memory:');
  const scripts = [];
  const app = await buildApp({
    store,
    config: { candidate: { name: 'P' }, search: { homeLocations: [] }, fractional: {}, coverLetterChecks: [] },
    services: {
      createBrowser: async () => null,
      runScript: async ({ script, onLine }) => {
        scripts.push(script);
        onLine('Encrypted backup written');
        return { code: 0, lastError: null };
      },
      runPipeline: async () => ({ code: 0, lastError: null }),
      // Daily at the minute just passed, so the never-run backup counts as missed and catches up at start.
      schedules: schedulesFromEnv({ SCHEDULE_RESTORE_TEST: 'off', SCHEDULE_BACKUP: `daily ${String(new Date(Date.now() - 60000).getHours()).padStart(2, '0')}:${String(new Date(Date.now() - 60000).getMinutes()).padStart(2, '0')}`, SCHEDULE_PIPELINE: 'Mon,Thu 06:00' }),
      log: { info: () => {}, warn: () => {} },
    },
  });
  await app.ready();
  const s = (await app.inject('/api/schedule')).json();
  assert.deepEqual(s.jobs.map((j) => [j.name, Boolean(j.next)]), [['pipeline', true], ['backup', true]]);
  assert.ok(s.timeZone);
  assert.equal((await app.inject('/api/pipeline')).json().schedule, 'Mon,Thu 06:00');
  for (let i = 0; i < 50 && !scripts.length; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(scripts, ['scripts/backup.js']);
  const backupTask = (await app.inject('/api/tasks')).json().find((t) => t.kind === 'backup');
  assert.equal(backupTask.meta.by, 'schedule');
  await app.close();
  store.close();
});

test('calendar days use the app time zone, never UTC', () => {
  // 10:30 PM local on Oct 16 is Oct 16, whatever toISOString() says.
  assert.equal(localDay(local(2026, 10, 16, 22, 30)), '2026-10-16');
  assert.equal(localDaysAgo(local(2026, 10, 16, 22, 30), 30), '2026-09-16');
  assert.equal(dayOf('2026-10-16'), '2026-10-16');
  assert.equal(dayOf(local(2026, 10, 16, 23, 59).toISOString()), '2026-10-16');
  assert.equal(dayOf(null), null);
});
