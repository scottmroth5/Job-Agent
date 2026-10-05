import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaude } from '@scottmroth5/agent-core';
import { openJobStore } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { progressLine } from '../server/pipeline-routes.js';
import { storedKey } from '../agents/identity.js';
import { insertEmail, addReminder } from '../agents/inbox/store.js';
import { createGmail } from '../agents/inbox/gmail.js';
import { loadInboxConfig } from '../agents/inbox/config.js';
import { loadKey, newKey } from '../agents/inbox/crypto.js';
import { fakeGmailApi, message } from './fixtures/inbox/fake-gmail.js';

// Synthetic data only.
const config = { candidate: { name: 'Pat Example' }, search: { homeLocations: [] }, fractional: { weeksPerYear: 48 }, coverLetterChecks: [] };
const key = loadKey({ EMAIL_ENC_KEY: newKey() });

function claudeReplying(reply) {
  const client = { messages: { create: async (p) => ({ id: 'x', model: p.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(reply) }], usage: { input_tokens: 10, output_tokens: 5 } }) } };
  return createClaude({ client });
}

async function setup({ pipelineLines = [], pipelineCode = 0, ready = true, messages = [] } = {}) {
  const store = openJobStore(':memory:');
  const { db } = store;
  const posting = Number(
    db
      .prepare(`INSERT INTO postings (url_key, company, title, company_title_key, discovered_on, stage, status, created_at, updated_at)
        VALUES ('k1', 'Example Co', 'VP of Engineering', ?, '2026-09-01', 'pipeline', 'applied', 'x', 'x')`)
      .run(storedKey({ company: 'Example Co', title: 'VP of Engineering' })).lastInsertRowid,
  );
  const { api } = fakeGmailApi({ messages, me: 'me@example.net' });
  let release;
  const gate = new Promise((r) => (release = r));
  const services = {
    claude: claudeReplying({ application_id: String(posting), confidence: 0.95, type: 'interview_request', summary: 'Invites an interview.', extracted: { company: null, role_title: null, contact_name: null, contact_email: null, interview_times: ['October 8, 2026 2:00 PM'], deadline: null } }),
    knowledge: async () => 'k',
    createBrowser: async () => null,
    runPipeline: async ({ onLine }) => {
      for (const l of pipelineLines) onLine(l);
      await gate;
      db.prepare("INSERT INTO runs (name, status, started_at, finished_at) VALUES ('pipeline', ?, '2026-10-05T13:00:00Z', '2026-10-05T13:12:00Z')").run(pipelineCode ? 'failed' : 'ok');
      return { code: pipelineCode, lastError: pipelineCode ? 'EMAIL_ADDRESS is not set in .env; the report was not sent.' : null };
    },
    inbox: { ready: () => ready, gmail: () => createGmail({ api }), key: () => key, cfg: loadInboxConfig() },
  };
  const app = await buildApp({ store, config, services });
  return { store, db, app, posting, release };
}

test('progress lines come from the pipeline output', () => {
  assert.equal(progressLine('[pipeline] Step 2/5: discover'), 'Step 2/5: discover');
  assert.equal(progressLine('Sent "Job Agent: 3 new" (x).'), 'Report emailed');
  assert.equal(progressLine('LinkedIn: 40 found in 6 requests'), null);
});

test('Run pipeline: progress, the last run time, and no second run while one is going', async () => {
  const { app, store, release } = await setup({ pipelineLines: ['[pipeline] Step 1/5: discover', 'LinkedIn: 3 found', '[pipeline] Step 5/5: report', 'Sent "Job Agent" (x).'] });
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/pipeline' })).json(), { running: false, last: null, lastFinished: null, taskId: null });
  const { taskId } = (await app.inject({ method: 'POST', url: '/api/pipeline/run' })).json();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await app.inject({ method: 'GET', url: '/api/pipeline' })).json().taskId, taskId);
  assert.equal((await app.inject({ method: 'POST', url: '/api/pipeline/run' })).statusCode, 409);
  release();
  const task = await app.tasks.wait(taskId);
  assert.equal(task.status, 'done');
  assert.deepEqual(task.steps.map((s) => s.message), ['Starting', 'Step 1/5: discover', 'Step 5/5: report', 'Report emailed']);
  const state = (await app.inject({ method: 'GET', url: '/api/pipeline' })).json();
  assert.deepEqual([state.lastFinished.status, state.lastFinished.finishedAt, state.taskId], ['ok', '2026-10-05T13:12:00Z', null]);
  await app.close();
  store.close();
});

test('a failed pipeline reports why, and the button is refused while a CLI run is going', async () => {
  const { app, store, db, release } = await setup({ pipelineCode: 1 });
  release();
  const { taskId } = (await app.inject({ method: 'POST', url: '/api/pipeline/run' })).json();
  const task = await app.tasks.wait(taskId);
  assert.equal(task.status, 'failed');
  assert.match(task.error, /EMAIL_ADDRESS is not set/);
  db.prepare("INSERT INTO runs (name, status, started_at) VALUES ('inbox', 'running', ?)").run(new Date().toISOString());
  const res = await app.inject({ method: 'POST', url: '/api/pipeline/run' });
  assert.equal(res.statusCode, 409);
  assert.match(res.json().error, /inbox run/);
  await app.close();
  store.close();
});

test('Check inbox runs the inbox and the overview shows linked emails and reminders', async () => {
  const msg = message({ id: 'g1', from: 'Example Co <no-reply@us.greenhouse.io>', subject: 'Interview for VP of Engineering at Example Co', body: 'Can you meet on October 8?' });
  const { app, store, posting } = await setup({ messages: [msg] });
  const { taskId } = (await app.inject({ method: 'POST', url: '/api/inbox/check' })).json();
  const task = await app.tasks.wait(taskId);
  assert.equal(task.status, 'done', task.error);
  assert.deepEqual([task.result.considered, task.result.matched, task.result.statusChanges], [1, 1, 1]);
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
  const emailId = insertEmail(db, {
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

  const reminderId = addReminder(db, { postingId: posting, emailId, kind: 'assessment', note: 'Due Friday' });
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/inbox/reminders/${reminderId}`, payload: { status: 'done' } })).json().status, 'done');
  assert.equal((await app.inject({ method: 'GET', url: '/api/inbox' })).json().reminders.length, 0);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/inbox/reminders/${reminderId}`, payload: { status: 'done' } })).statusCode, 404);
  await app.close();
  store.close();
});
