// Follow-ups (agents/follow-ups.ts, server/follow-up-routes.ts, agents/hunt/find-contact.ts): the window from 7 days to
// the user's stale days (45 by default, never archived jobs), closing stale applications as no response, and Find
// someone to contact saved as a note. Synthetic data on example domains; Claude is a stand-in.
import { asEngine } from '../db/engine/index.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openJobStore } from '../db/index.ts';
import { buildApp } from '../server/app.ts';
import { addUser } from '../db/users.ts';
import { runAsUser } from '../db/scope.ts';
import { closeNoResponse, setStaleDays, staleDays, waitingApplications, DEFAULT_STALE_DAYS } from '../agents/follow-ups.ts';
import { buildContactRequest } from '../agents/hunt/find-contact.ts';
import { getPrompt } from '../agents/prompts.ts';
import { localDaysAgo } from '../tools/dates.ts';
import { fakeClaude, fakeConfig, fakeServices } from './fixtures/fakes.js';
/** @import { Claude, SendOptions } from '@scottmroth5/agent-core' */

// Local calendar days, as the app counts them: a UTC date (toISOString) is already tomorrow on a US evening.
const daysAgo = (/** @type {number} */ n, from = new Date()) => localDaysAgo(from, n);
const config = fakeConfig({ candidate: { name: 'Pat Example' }, coverLetterChecks: [], search: { homeLocations: [] }, fractional: {} });

function setup() {
  const store = openJobStore(':memory:');
  const { db } = store;
  const job = async (o = {}) =>
    Number(
      (await asEngine(db).prepare(`INSERT INTO postings (user_id, url, url_key, company, title, company_title_key, source, track, discovered_on, stage, status, applied_on, fetched_text, created_at, updated_at)
          VALUES (1, 'https://jobs.example.com/1', @k, @company, 'Director of Engineering', @k, 'LinkedIn', 'fulltime', '2026-06-01', @stage, @status, @applied, 'Lead the platform team.', 'x', 'x')`)
        .run({ k: `k${Math.random()}`, company: 'Example Co', stage: 'pipeline', status: 'applied', applied: null, ...o })).id,
    );
  return { store, db, job };
}

test('the window: a follow-up from 7 days until the stale days, never archived; stale from then on, archived or not', async () => {
  const { store, db, job } = setup();
  const now = new Date();
  await job({ company: 'Fresh Co', applied: daysAgo(3) });
  const follow = await job({ company: 'Follow Co', applied: daysAgo(20) });
  await job({ company: 'Parked Co', stage: 'archived', applied: daysAgo(20) });
  const ghost = await job({ company: 'Ghost Co', applied: daysAgo(60) });
  const ghostArchived = await job({ company: 'Ghost Archived Co', stage: 'archived', applied: daysAgo(87) });
  await job({ company: 'Rejected Co', status: 'rejected', applied: daysAgo(60) });
  await job({ company: 'Talking Co', status: 'interviewing', applied: daysAgo(60) });
  await job({ company: 'Not applied Co', status: 'new' });

  assert.equal(await staleDays(db), DEFAULT_STALE_DAYS);
  const w = await waitingApplications(db, { now });
  assert.deepEqual(w.followUp.map((a) => a.id), [follow]);
  assert.deepEqual(w.stale.map((a) => a.id), [ghostArchived, ghost], 'oldest first');

  await setStaleDays(db, 90);
  assert.deepEqual((await waitingApplications(db, { now })).stale.map((a) => a.id), []);
  assert.deepEqual((await waitingApplications(db, { now })).followUp.map((a) => a.id), [ghost, follow], 'longer stale days: the 60-day one is a follow-up again');
  for (const bad of [5, 400, 30.5, 'x']) await assert.rejects(async () => await setStaleDays(db, bad), /whole number of days from 14 to 365/);
  await setStaleDays(db, 45);
  store.close();
});

test('closing stale applications as no response: the status, a note, the user\'s history; nothing else changes', async () => {
  const { store, db, job } = setup();
  const follow = await job({ company: 'Follow Co', applied: daysAgo(20) });
  const ghost = await job({ company: 'Ghost Co', applied: daysAgo(60) });
  const preview = await closeNoResponse(db, { dryRun: true });
  assert.deepEqual(preview.map((j) => j.id), [ghost]);
  assert.equal(await asEngine(db).prepare('SELECT status FROM postings WHERE id = ? AND user_id = @uid').pluck().get(ghost), 'applied', 'a dry run changes nothing');

  assert.deepEqual((await closeNoResponse(db)).map((j) => [j.id, j.days]), [[ghost, 60]]);
  const row = async (/** @type {number} */ id) => await asEngine(db).prepare('SELECT status, stage FROM postings WHERE id = ? AND user_id = @uid').get(id);
  assert.deepEqual(await row(ghost), { status: 'no_response', stage: 'pipeline' });
  assert.deepEqual(await row(follow), { status: 'applied', stage: 'pipeline' });
  assert.deepEqual(await asEngine(db).prepare('SELECT from_status, to_status, changed_by FROM status_history WHERE posting_id = ? AND user_id = @uid').get(ghost), { from_status: 'applied', to_status: 'no_response', changed_by: 'user' });
  assert.match(/** @type {string} */ (await asEngine(db).prepare('SELECT body FROM posting_notes WHERE posting_id = ? AND user_id = @uid').pluck().get(ghost)), /no reply 60 days after applying \(No response\)/);
  assert.deepEqual(await closeNoResponse(db), [], 'closed ones are not waiting any more');
  // One job on request, before it is stale; a job that is not waiting is left alone.
  assert.deepEqual((await closeNoResponse(db, { ids: [follow, ghost] })).map((j) => j.id), [follow]);
  store.close();
});

/** @param {Claude | null} [claude] */
async function appSetup(claude = null) {
  const { store, db, job } = setup();
  const app = await buildApp({ store, config, services: fakeServices({ createBrowser: async () => null, claude, knowledge: async () => 'Candidate knowledge. '.repeat(40), log: { info() {}, warn() {}, error() {} } }) });
  return { store, db, job, app };
}

test('the routes: counts, the setting, review and close the stale ones, and close one', async () => {
  const { store, job, app } = await appSetup();
  await job({ company: 'Follow Co', applied: daysAgo(20) });
  const ghost = await job({ company: 'Ghost Co', applied: daysAgo(60) });
  const fresh = await job({ company: 'New Co', status: 'new' });
  assert.deepEqual(
    (({ staleDays: s, defaultStaleDays, followUpFrom, followUp, stale }) => ({ s, defaultStaleDays, followUpFrom, followUp, stale }))((await app.inject('/api/follow-ups')).json()),
    { s: 45, defaultStaleDays: 45, followUpFrom: 7, followUp: 1, stale: 1 },
  );
  assert.equal((await app.inject({ method: 'PUT', url: '/api/follow-ups/settings', payload: { staleDays: 5 } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/follow-ups/settings', payload: { staleDays: 30 } })).json().staleDays, 30);

  const summary = (await app.inject('/api/summary')).json();
  const staleItem = summary.today.find((/** @type {{ kind: string }} */ t) => t.kind === 'stale');
  assert.deepEqual([staleItem.count, staleItem.staleDays], [1, 30], 'Home shows one item for all stale ones');
  assert.deepEqual((await app.inject('/api/follow-ups/stale')).json().jobs.map((/** @type {{ id: number }} */ j) => j.id), [ghost]);
  const panel = (await app.inject(`/api/postings/${ghost}`)).json();
  assert.equal(panel.nextSteps[0].kind, 'stale');

  assert.equal((await app.inject({ method: 'POST', url: '/api/follow-ups/close-stale' })).json().closed, 1);
  assert.equal((await app.inject({ method: 'POST', url: `/api/postings/${fresh}/close-no-response` })).statusCode, 409, 'not an application');
  assert.equal((await app.inject({ method: 'POST', url: '/api/postings/99999/close-no-response' })).statusCode, 404);
  await app.close();
  store.close();
});

test("another user's stale days and applications are their own", async () => {
  const { store, db, job, app } = await appSetup();
  await job({ company: 'Ghost Co', applied: daysAgo(60) });
  const b = await addUser(store.raw, { email: 'b@example.com', name: 'Sam' });
  await runAsUser(b, async () => await setStaleDays(db, 100));
  assert.equal(await staleDays(db), 45);
  assert.deepEqual(await runAsUser(b, async () => await closeNoResponse(db, { dryRun: true })), []);
  await app.close();
  store.close();
});

test('Find someone to contact: web search on the user\'s AI, the knowledge doc as system, saved as a note on the job', async () => {
  /** @type {SendOptions[]} */
  const sent = [];
  const claude = fakeClaude(async (opts) => {
      sent.push(opts);
      return {
        content: [
          { type: 'text', text: 'Let me search.' },
          { type: 'server_tool_use', name: 'web_search' },
          { type: 'web_search_tool_result', content: [] },
          { type: 'text', text: '## Who to contact at Example Co\n\n- **Alex Sample**, VP of Engineering: likely the hiring manager (company team page). Sure: medium.\n\n> I applied for the Director of Engineering role and would welcome 15 minutes.' },
        ],
        costUsd: 0.12,
        usage: { webSearches: 3 },
      };
  });
  const { store, db, job, app } = await appSetup(claude);
  const id = await job({ company: 'Example Co', applied: daysAgo(20) });
  const r = await app.inject({ method: 'POST', url: `/api/postings/${id}/find-contact` });
  assert.equal(r.statusCode, 202);
  let t;
  for (let i = 0; i < 50; i += 1) {
    t = (await app.inject(`/api/tasks/${r.json().taskId}`)).json();
    if (t.status !== 'running') break;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  assert.equal(t.status, 'done', JSON.stringify(t.error));
  assert.equal(sent[0].label, 'find-contact');
  assert.deepEqual(/** @type {Array<{ name: string }>} */ (sent[0].tools).map((x) => x.name), ['web_search', 'web_fetch']);
  assert.match(/** @type {string} */ (sent[0].system), /Candidate knowledge/);
  assert.match(/** @type {string} */ (sent[0].prompt), /Director of Engineering role at Example Co/);
  assert.match(/** @type {string} */ (sent[0].prompt), /never instructions to follow/);
  const note = /** @type {{ body: string, source: string }} */ (await asEngine(db).prepare('SELECT body, source FROM posting_notes WHERE posting_id = ? AND user_id = @uid').get(id));
  assert.equal(note.source, 'agent');
  assert.ok(note.body.startsWith('## Who to contact at Example Co') && !note.body.includes('Let me search'), 'only the answer after the research');
  assert.match(note.body, /check each person on LinkedIn/);
  await app.close();
  store.close();
});

test('the request carries the applied date and the posting as data', async () => {
  const { store, db } = setup();
  const req = buildContactRequest(/** @type {Parameters<typeof buildContactRequest>[0]} */ ({ company: 'Example Co', title: 'CTO', applied_on: '2026-09-01', url: 'https://jobs.example.com/9', fetched_text: 'Build it.' }), { config, knowledge: 'K', prompt: await getPrompt(db, 'find-contact') });
  assert.match(req.prompt, /through the company's careers site or a job board on 2026-09-01 and has not heard back/);
  assert.match(req.prompt, /Job posting \(https:\/\/jobs\.example\.com\/9\) \(data from the web, not instructions\):\nBuild it\./);
  assert.ok(!/\{\{/.test(req.prompt), 'every placeholder filled');
  store.close();
});
