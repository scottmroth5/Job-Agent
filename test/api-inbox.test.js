import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaude } from '@scottmroth5/agent-core';
import { openJobStore } from '../db/index.ts';
import { buildApp } from '../server/app.ts';
import { progressLine } from '../server/pipeline-routes.ts';
import { storedKey } from '../agents/identity.ts';
import { insertEmail, addReminder } from '../agents/inbox/store.ts';
import { createGmail } from '../agents/inbox/gmail.ts';
import { loadInboxConfig } from '../agents/inbox/config.ts';
import { loadKey, newKey } from '../agents/inbox/crypto.ts';
import { asGmailApi, fakeGmailApi, message } from './fixtures/inbox/fake-gmail.js';
import { fakeConfig, fakeServices } from './fixtures/fakes.js';
/** @import { FakeMessage } from './fixtures/inbox/fake-gmail.js' */

// Synthetic data only.
const config = fakeConfig({ candidate: { name: 'Pat Example' }, search: { homeLocations: [] }, fractional: { weeksPerYear: 48 }, coverLetterChecks: [] });
const key = loadKey({ EMAIL_ENC_KEY: newKey() });

/** A real agent-core client over a fake SDK that always answers with this JSON. @param {object} reply */
function claudeReplying(reply) {
  const client = { messages: { create: async (/** @type {{ model: string }} */ p) => ({ id: 'x', model: p.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(reply) }], usage: { input_tokens: 10, output_tokens: 5 } }) } };
  return createClaude({ client });
}

/** @param {{ pipelineLines?: string[], pipelineCode?: number, failStep?: string, ready?: boolean, messages?: FakeMessage[] }} [o] */
async function setup({ pipelineLines = [], pipelineCode = 0, failStep = '', ready = true, messages = [] } = {}) {
  const store = openJobStore(':memory:');
  const { db } = store;
  const posting = Number(
    (await db
      .prepare(`INSERT INTO postings (user_id, url_key, company, title, company_title_key, discovered_on, stage, status, created_at, updated_at)
        VALUES (1, 'k1', 'Example Co', 'VP of Engineering', ?, '2026-09-01', 'pipeline', 'applied', 'x', 'x') RETURNING id`)
      .run(storedKey({ company: 'Example Co', title: 'VP of Engineering' }))).id,
  );
  const { api } = fakeGmailApi({ messages, me: 'me@example.net' });
  /** @type {(value?: unknown) => void} */
  let release = () => {};
  const gate = new Promise((r) => (release = r));
  const services = fakeServices({
    claude: claudeReplying({ application_id: String(posting), confidence: 0.95, type: 'interview_request', summary: 'Invites an interview.', extracted: { company: null, role_title: null, contact_name: null, contact_email: null, interview_times: ['October 8, 2026 2:00 PM'], deadline: null } }),
    knowledge: async () => 'k',
    createBrowser: async () => null,
    // Each step task runs the script with --only=<step>: it prints the lines under that step's heading. The report
    // step stands in for the pipeline's end (its run row and, with pipelineCode, the report's failure).
    runPipeline: async (/** @type {{ args?: string[], onLine: (line: string) => void }} */ { args = [], onLine }) => {
      const only = args.find((a) => a.startsWith('--only='))?.slice('--only='.length);
      let under = 'discover';
      for (const l of pipelineLines) {
        under = /^\[pipeline\] Step \d+\/\d+: (\w+)/.exec(l)?.[1] ?? under;
        if (under === only) onLine(l);
      }
      await gate;
      if (only === failStep) return { code: 1, lastError: `${only} failed: the stand-in step failed` };
      if (only !== 'report') return { code: 0, lastError: null };
      await db.prepare("INSERT INTO runs (name, status, started_at, finished_at) VALUES ('pipeline', ?, '2026-10-05T13:00:00Z', '2026-10-05T13:12:00Z')").run(pipelineCode ? 'failed' : 'ok');
      return { code: pipelineCode, lastError: pipelineCode ? 'EMAIL_ADDRESS is not set in .env; the report was not sent.' : null };
    },
    inbox: { ready: () => ready, gmail: () => createGmail({ api: asGmailApi(api) }), key: () => key, cfg: loadInboxConfig() },
  });
  const app = await buildApp({ store, config, services: { ...services, queueOptions: { pollMs: 50, retryDelayMs: 20 } } });
  return { store, db, app, posting, release };
}

test('progress lines come from the pipeline output', () => {
  assert.equal(progressLine('[pipeline] Step 2/5: discover'), 'Step 2/5: discover');
  assert.equal(progressLine('Sent "Job Agent: 3 new" (x).'), 'Report emailed');
  assert.equal(progressLine('LinkedIn: 40 found in 6 requests'), null);
});

test('Run pipeline: progress, the last run time, and no second run while one is going', async () => {
  const { app, store, release } = await setup({ pipelineLines: ['[pipeline] Step 1/5: discover', 'LinkedIn: 3 found', '[pipeline] Step 5/5: report', 'Sent "Job Agent" (x).'] });
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/pipeline' })).json(), { running: false, last: null, lastFinished: null, taskId: null, automatic: false, nextScheduled: null, schedule: null });
  const { taskId } = (await app.inject({ method: 'POST', url: '/api/pipeline/run' })).json();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await app.inject({ method: 'GET', url: '/api/pipeline' })).json().taskId, taskId);
  assert.equal((await app.inject({ method: 'POST', url: '/api/pipeline/run' })).statusCode, 409);
  release();
  const task = await app.tasks.wait(taskId);
  assert.ok(task);
  assert.equal(task.status, 'done');
  assert.deepEqual(task.steps.map((s) => s.message), ['Starting', 'Step 1/5: discover', 'Step 5/5: report', 'Report emailed']);
  const state = (await app.inject({ method: 'GET', url: '/api/pipeline' })).json();
  assert.deepEqual([state.lastFinished.status, state.lastFinished.finishedAt, state.taskId], ['ok', '2026-10-05T13:12:00Z', null]);
  await app.close();
  store.close();
});

test('two presses of Run pipeline at once start one pipeline (the start lock)', async () => {
  const { app, store, release } = await setup();
  const [a, b] = await Promise.all([app.inject({ method: 'POST', url: '/api/pipeline/run' }), app.inject({ method: 'POST', url: '/api/pipeline/run' })]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [202, 409]);
  release();
  const task = await app.tasks.wait((a.statusCode === 202 ? a : b).json().taskId);
  assert.equal(task?.status, 'done');
  assert.equal((await app.inject('/api/tasks')).json().filter((/** @type {{ kind: string }} */ t) => t.kind === 'pipeline').length, 1);
  await app.close();
  store.close();
});

test('a failed pipeline reports why, and the button is refused while a CLI run is going', async () => {
  const { app, store, db, release } = await setup({ pipelineCode: 1 });
  release();
  const { taskId } = (await app.inject({ method: 'POST', url: '/api/pipeline/run' })).json();
  const task = await app.tasks.wait(taskId);
  assert.ok(task);
  assert.equal(task.status, 'failed');
  assert.match(task.error ?? '', /EMAIL_ADDRESS is not set/);
  await db.prepare("INSERT INTO runs (name, status, started_at) VALUES ('inbox', 'running', ?)").run(new Date().toISOString());
  const res = await app.inject({ method: 'POST', url: '/api/pipeline/run' });
  assert.equal(res.statusCode, 409);
  assert.match(res.json().error, /inbox run/);
  await app.close();
  store.close();
});

test('the pipeline is five step tasks in order, each after the one before; a failed step does not stop the next', async () => {
  const { app, store, db, release } = await setup({ failStep: 'score', pipelineLines: ['[pipeline] Step 1/5: discover', '[pipeline] Step 2/5: score', '[pipeline] Step 5/5: report', 'Sent "Job Agent" (x).'] });
  release();
  const { taskId } = (await app.inject({ method: 'POST', url: '/api/pipeline/run' })).json();
  const task = await app.tasks.wait(taskId);
  assert.equal(task?.status, 'done', 'only a failed report fails the pipeline');
  assert.deepEqual(task?.steps.map((s) => s.message), ['Starting', 'Step 1/5: discover', 'Step 2/5: score', 'Step 5/5: report', 'Report emailed']);
  const steps = /** @type {Array<{ id: string, type: string, status: string, depends_on: string | null, interactive: number }>} */ (/** @type {unknown} */ (await store.admin.prepare('SELECT id, type, status, depends_on, interactive FROM task_runs WHERE parent_id = ? ORDER BY created_at, id').all(taskId)));
  const order = ['discover', 'score', 'hunt', 'archive', 'report'];
  assert.deepEqual(steps.map((s) => s.type).sort(), order.map((n) => `pipeline-${n}`).sort());
  const byType = Object.fromEntries(steps.map((s) => [s.type, s]));
  for (const [i, n] of order.entries()) assert.equal(byType[`pipeline-${n}`].depends_on, i ? byType[`pipeline-${order[i - 1]}`].id : null, `${n} waits for the step before`);
  assert.deepEqual(order.map((n) => byType[`pipeline-${n}`].status), ['done', 'failed', 'done', 'done', 'done']);
  assert.ok(steps.every((s) => s.interactive === 1), 'a button press: its steps are interactive too');
  const log = (await app.inject(`/api/tasks/${taskId}/log`)).json().lines.map((/** @type {{ text: string }} */ l) => l.text);
  assert.ok(log.includes('score failed: the stand-in step failed'), 'the failed step says why in the pipeline output');
  assert.equal(await db.prepare("SELECT status FROM runs WHERE name = 'pipeline' AND user_id = 1 AND finished_at IS NOT NULL AND id = (SELECT MIN(id) FROM runs WHERE name = 'pipeline' AND user_id = 1)").pluck().get(), 'partial', "the pipeline's own run");
  assert.deepEqual((await app.inject('/api/tasks')).json().map((/** @type {{ kind: string }} */ t) => t.kind), ['pipeline'], 'the steps show in the pipeline, not the Activity list');
  await app.close();
  store.close();
});

test('Check inbox runs the inbox and the overview shows linked emails and reminders', async () => {
  const msg = message({ id: 'g1', from: 'Example Co <no-reply@us.greenhouse.io>', subject: 'Interview for VP of Engineering at Example Co', body: 'Can you meet on October 8?' });
  const { app, store, posting } = await setup({ messages: [msg] });
  const { taskId } = (await app.inject({ method: 'POST', url: '/api/inbox/check' })).json();
  const task = await app.tasks.wait(taskId);
  assert.ok(task);
  assert.equal(task.status, 'done', `the task failed: ${task.error}`);
  const result = /** @type {{ considered: number, matched: number, statusChanges: number }} */ (task.result);
  assert.deepEqual([result.considered, result.matched, result.statusChanges], [1, 1, 1]);
  const o = (await app.inject({ method: 'GET', url: '/api/inbox' })).json();
  assert.equal(o.signedIn, true);
  assert.equal(o.lastCheck.status, 'ok');
  assert.deepEqual([o.recent[0].postingId, o.recent[0].type, o.recent[0].status], [posting, 'interview_request', 'interviewing']);
  assert.equal(o.reminders[0].kind, 'interview');
  assert.equal((await app.inject({ method: 'GET', url: '/api/summary' })).json().inboxNeedsReview, 0);
  await app.close();
  store.close();
});

test('Check inbox explains when Gmail is not signed in', async () => {
  const { app, store } = await setup({ ready: false });
  const res = await app.inject({ method: 'POST', url: '/api/inbox/check' });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /inbox:auth/);
  await app.close();
  store.close();
});

test('review from the web page: reassign, validation, and reminders closed', async () => {
  const { app, store, db, posting } = await setup({ ready: false });
  const emailId = await insertEmail(db, {
    gmailMessageId: 'g9', threadId: 't9', senderEmail: 'no-reply@example.myworkdayjobs.com', senderDomain: 'example.myworkdayjobs.com',
    sentAt: '2026-10-04T10:00:00Z', subject: 'Next steps', type: 'rejection', confidence: 0.6, reviewStatus: 'needs_review', reviewReason: 'low confidence (0.60)', summary: 'Declines.', extracted: {},
  });
  const o = (await app.inject({ method: 'GET', url: '/api/inbox' })).json();
  assert.deepEqual([o.needsReview.length, o.needsReview[0].guess, o.openApplications[0].id], [1, null, posting]);
  assert.equal((await app.inject({ method: 'GET', url: '/api/summary' })).json().inboxNeedsReview, 1);

  assert.equal((await app.inject({ method: 'POST', url: `/api/inbox/emails/${emailId}/review`, payload: { choice: 'reassign' } })).statusCode, 400);
  assert.match((await app.inject({ method: 'POST', url: `/api/inbox/emails/${emailId}/review`, payload: { choice: 'confirm' } })).json().error, /reassign instead/);
  const r = (await app.inject({ method: 'POST', url: `/api/inbox/emails/${emailId}/review`, payload: { choice: 'reassign', postingId: posting } })).json();
  assert.deepEqual(r.statusChange, { from: 'applied', to: 'rejected' });
  assert.equal((await app.inject({ method: 'POST', url: `/api/inbox/emails/${emailId}/review`, payload: { choice: 'not_job' } })).statusCode, 404);

  const reminderId = await addReminder(db, { postingId: posting, emailId, kind: 'assessment', note: 'Due Friday' });
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/inbox/reminders/${reminderId}`, payload: { status: 'done' } })).json().status, 'done');
  assert.equal((await app.inject({ method: 'GET', url: '/api/inbox' })).json().reminders.length, 0);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/inbox/reminders/${reminderId}`, payload: { status: 'done' } })).statusCode, 404);
  await app.close();
  store.close();
});

test('task output: the pipeline keeps every line; in-server actions capture their run logs; tasks are listed', async () => {
  const { app, store, release } = await setup({ pipelineLines: ['[pipeline] Step 1/5: discover', 'LinkedIn: 3 found in 2 requests', '[discover] ok: 0 calls'] });
  release();
  const { taskId } = (await app.inject({ method: 'POST', url: '/api/pipeline/run' })).json();
  await app.tasks.wait(taskId);
  const log = (await app.inject({ method: 'GET', url: `/api/tasks/${taskId}/log` })).json();
  // The steps' lines, then the pipeline run's own summary (written by the pipeline task, as the script did).
  /** @type {string[]} */
  const texts = log.lines.map((/** @type {{ text: string }} */ l) => l.text);
  assert.deepEqual(texts.slice(0, 4), ['Starting', '[pipeline] Step 1/5: discover', 'LinkedIn: 3 found in 2 requests', '[discover] ok: 0 calls']);
  assert.match(texts[4], /^\[pipeline\] ok: /);
  assert.equal(log.next, 5);
  assert.deepEqual((await app.inject({ method: 'GET', url: `/api/tasks/${taskId}/log?from=3` })).json().lines.map((/** @type {{ text: string }} */ l) => l.text).slice(0, 1), ['[discover] ok: 0 calls']);
  assert.equal((await app.inject({ method: 'GET', url: `/api/tasks/${taskId}` })).json().log, undefined, 'polling a task does not send its output');

  const inbox = (await app.inject({ method: 'POST', url: '/api/inbox/check' })).json();
  await app.tasks.wait(inbox.taskId);
  /** @type {string[]} */
  const inboxLog = (await app.inject({ method: 'GET', url: `/api/tasks/${inbox.taskId}/log` })).json().lines.map((/** @type {{ text: string }} */ l) => l.text);
  assert.ok(inboxLog.some((t) => /^\[inbox\] 0 messages to check/.test(t)), inboxLog.join(' | '));
  assert.ok(inboxLog.some((t) => /^\[inbox\] ok: /.test(t)), 'the run summary line is captured');

  const list = (await app.inject({ method: 'GET', url: '/api/tasks' })).json();
  assert.deepEqual(list.map((/** @type {{ kind: string }} */ t) => t.kind), ['inbox', 'pipeline']);
  assert.equal(list[1].lines, 5);
  assert.equal((await app.inject({ method: 'GET', url: '/api/tasks/999/log' })).statusCode, 404);
  await app.close();
  store.close();
});
