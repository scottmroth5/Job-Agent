import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaude } from '@scottmroth5/agent-core';
import { openJobStore } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { assertSafeBinding } from '../server/auth.js';

// Synthetic config, knowledge and postings only.
const config = {
  candidate: { name: 'Pat Example', signoffName: 'Pat' },
  search: { homeAreaLabel: 'the Anytown area', homeLocations: ['Anytown, ST'] },
  fractional: { targetAnnual: [200000, 250000], weeksPerYear: 48 },
  coverLetterChecks: [],
};
const KNOWLEDGE = 'Section 5: Job Targets. Engineering leadership. '.repeat(20);
const DESCRIPTION = 'Lead the platform engineering team through a growth phase with hands on architecture reviews. '.repeat(3);

function services() {
  const client = {
    messages: {
      create: async (params) => {
        const scoring = Boolean(params.output_config?.format);
        const data = { score: 8, fit: 'High', reason: 'Strong fit', whyItFits: 'w', caveats: '', rate: { min: null, max: null, unit: 'unknown' }, hoursPerWeek: { min: null, max: null }, roleType: 'Full time', locationConcern: 'none', strengths: ['Scale'], watchOuts: [], topTalkingPoint: 'Growth', suggestedStatus: 'worth_pursuing' };
        return { id: 'm', model: params.model, stop_reason: 'end_turn', content: [{ type: 'text', text: scoring ? JSON.stringify(data) : 'Body paragraph.' }], usage: { input_tokens: 10, output_tokens: 5 } };
      },
    },
  };
  return {
    claude: createClaude({ client }),
    knowledge: async () => KNOWLEDGE,
    drive: { getFile: async () => ({}), createFolder: async () => 'f', createDocFromHtml: async () => ({ id: 'd', url: 'https://docs.example.com/d' }) },
    http: { get: async () => { throw new Error('no network in tests'); }, sleep: async () => {} },
    createBrowser: async () => null,
  };
}

async function setup() {
  const store = openJobStore(':memory:');
  const add = (o) =>
    Number(
      store.db.prepare(`INSERT INTO postings (url, url_key, company, title, company_title_key, source, stage, status, track, rate_text, rate_min, rate_max, rate_unit,
          hours_min, hours_max, fetched_text, location, discovered_on, created_at, updated_at)
        VALUES (@url, @url, @company, @title, @url, 'LinkedIn', @stage, 'new', @track, @rate_text, @rate_min, @rate_max, @rate_unit, @hours_min, @hours_max, @text, 'Remote', '2026-09-30', 'x', 'x')`)
        .run({ rate_text: null, rate_min: null, rate_max: null, rate_unit: null, hours_min: null, hours_max: null, text: DESCRIPTION, stage: 'pipeline', track: 'fulltime', ...o }).lastInsertRowid,
    );
  const full = add({ url: 'https://jobs.example.com/1', company: 'Full Co', title: 'VP Engineering' });
  const frac = add({ url: 'https://jobs.example.com/2', company: 'Frac Co', title: 'Fractional CTO', track: 'fractional', rate_text: '$200 / hr', rate_min: 200, rate_max: 200, rate_unit: 'hour', hours_min: 15, hours_max: 15 });
  const found = add({ url: 'https://jobs.example.com/3', company: 'New Co', title: 'CTO', stage: 'discovered', text: null });
  store.db.prepare("INSERT INTO scores (posting_id, score, reason, analysis_json, source, created_at) VALUES (?, 9, 'Great', ?, 'v2', 'x')").run(frac, JSON.stringify({ fit: 'High', whyItFits: 'w' }));
  store.db.prepare("INSERT INTO artifacts (posting_id, kind, content, doc_url, flags_json, source, created_at) VALUES (?, 'cover_letter', 'Body', 'https://docs.example.com/x', '[\"weak closer\"]', 'v2', 'x')").run(frac);
  const app = await buildApp({ store, config, services: services() });
  return { store, app, ids: { full, frac, found } };
}

test('list filters by track and stage and shows fit, pay, annualized estimate and letter', async () => {
  const { app, store, ids } = await setup();
  const all = (await app.inject('/api/postings')).json();
  assert.equal(all.length, 3);
  const fractional = (await app.inject('/api/postings?track=fractional')).json();
  assert.deepEqual(fractional.map((p) => p.id), [ids.frac]);
  const row = fractional[0];
  assert.deepEqual([row.score, row.fit, row.rate.unit, row.hours.min], [9, 'High', 'hour', 15]);
  assert.deepEqual(row.annualized, { low: 144000, mid: 144000, high: 144000 });
  assert.deepEqual(row.letter, { url: 'https://docs.example.com/x', name: null, flags: ['weak closer'] });
  assert.equal((await app.inject('/api/postings?stage=pipeline&track=fulltime')).json().length, 1);
  assert.equal((await app.inject('/api/postings?q=frac')).json().length, 1);
  assert.equal((await app.inject('/api/postings?track=bogus')).statusCode, 400);
  const discovered = (await app.inject('/api/postings?stage=discovered')).json()[0];
  assert.equal(discovered.needsDescription, true);
  await app.close();
  store.close();
});

test('detail and edits: status history, applied date, fractional switch, pay and hours, pasted description', async () => {
  const { app, store, ids } = await setup();
  const detail = (await app.inject(`/api/postings/${ids.frac}`)).json();
  assert.equal(detail.analysis.fit, 'High');
  assert.equal(detail.letter.content, 'Body');
  assert.equal((await app.inject('/api/postings/9999')).statusCode, 404);

  const patched = await app.inject({ method: 'PATCH', url: `/api/postings/${ids.full}`, payload: { status: 'applied', notes: 'Sent via referral', track: 'fractional', rateText: '$150 - $200 / hr', hoursText: '10 - 20 hrs' } });
  assert.equal(patched.statusCode, 200);
  const p = patched.json();
  assert.deepEqual([p.status, p.track, p.notes, p.rate.min, p.rate.unit, p.hours.max], ['applied', 'fractional', 'Sent via referral', 150, 'hour', 20]);
  assert.match(p.appliedOn, /^\d{4}-\d{2}-\d{2}$/, 'applying without a date sets today');
  assert.deepEqual(p.statusHistory.at(-1), { ...p.statusHistory.at(-1), fromStatus: 'new', toStatus: 'applied', changedBy: 'user' });

  const pasted = (await app.inject({ method: 'PATCH', url: `/api/postings/${ids.found}`, payload: { description: DESCRIPTION } })).json();
  assert.deepEqual([pasted.needsDescription, pasted.textSource], [false, 'pasted']);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/postings/${ids.full}`, payload: { status: 'maybe' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/postings/${ids.full}`, payload: {} })).statusCode, 400);
  await app.close();
  store.close();
});

test('adding a job runs as a task with progress steps; actions score and write materials', async () => {
  const { app, store, ids } = await setup();
  const res = await app.inject({ method: 'POST', url: '/api/postings', payload: { title: 'Head of Engineering', company: 'Added Co', description: DESCRIPTION, url: '' } });
  assert.equal(res.statusCode, 202);
  const task = await app.tasks.wait(res.json().taskId);
  assert.equal(task.status, 'done', task.error);
  assert.equal(task.result.created, true);
  assert.ok(task.steps.some((s) => /Scored 8 of 10/.test(s.message)));
  assert.equal((await app.inject(`/api/tasks/${res.json().taskId}`)).json().status, 'done');

  const bad = await app.inject({ method: 'POST', url: '/api/postings', payload: { description: 'short' } });
  const badTask = await app.tasks.wait(bad.json().taskId);
  assert.equal(badTask.status, 'failed');
  assert.match(badTask.error, /enter the job title and company|very short/);

  const scoreTask = await app.tasks.wait((await app.inject({ method: 'POST', url: `/api/postings/${ids.full}/actions/score` })).json().taskId);
  assert.equal(scoreTask.status, 'done', scoreTask.error);
  const writeTask = await app.tasks.wait((await app.inject({ method: 'POST', url: `/api/postings/${ids.full}/actions/write-materials` })).json().taskId);
  assert.equal(writeTask.status, 'done', writeTask.error);
  assert.equal(writeTask.result.docs, 1);
  assert.equal((await app.inject({ method: 'POST', url: `/api/postings/${ids.full}/actions/explode` })).statusCode, 400);

  const runs = store.db.prepare("SELECT name FROM runs WHERE name LIKE 'ui-%' ORDER BY id").pluck().all();
  assert.deepEqual(runs, ['ui-add', 'ui-add', 'ui-score', 'ui-write-materials']);
  await app.close();
  store.close();
});

test('actions are refused while a pipeline run is in progress', async () => {
  const { app, store, ids } = await setup();
  store.db.prepare("INSERT INTO runs (name, status, started_at) VALUES ('pipeline', 'running', ?)").run(new Date().toISOString());
  const res = await app.inject({ method: 'POST', url: `/api/postings/${ids.full}/actions/score` });
  assert.equal(res.statusCode, 409);
  assert.match(res.json().error, /still running/);
  await app.close();
  store.close();
});

test('admin: list, view, preview, save (validated), and restore prompts', async () => {
  const { app, store, ids } = await setup();
  const list = (await app.inject('/api/admin/prompts')).json();
  assert.deepEqual(list.map((p) => [p.name, p.source]), [['score', 'default'], ['score-fractional', 'default'], ['resume-tweaks', 'default'], ['cover-letter', 'default']]);

  const score = (await app.inject('/api/admin/prompts/score')).json();
  assert.ok(score.template.includes('{{company}}') && score.schema.includes('"score"') && score.required.includes('jobContentBlock'));
  assert.equal((await app.inject('/api/admin/prompts/unknown')).statusCode, 400);

  const draft = `${score.template}\nPREVIEW-MARKER`;
  const preview = (await app.inject({ method: 'POST', url: '/api/admin/prompts/score/preview', payload: { template: draft, postingId: ids.full } })).json();
  assert.deepEqual(preview.problems, []);
  assert.ok(preview.text.includes('PREVIEW-MARKER') && preview.text.includes('Full Co') && !preview.text.includes('{{'));
  const badPreview = (await app.inject({ method: 'POST', url: '/api/admin/prompts/score/preview', payload: { template: 'nothing' } })).json();
  assert.ok(badPreview.problems.length > 0);

  const bad = await app.inject({ method: 'PUT', url: '/api/admin/prompts/score', payload: { template: 'no placeholders here' } });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /Required placeholders/);

  const saved = (await app.inject({ method: 'PUT', url: '/api/admin/prompts/score', payload: { template: draft, note: 'try a marker' } })).json();
  assert.deepEqual([saved.source, saved.note, saved.versions.length], ['custom', 'try a marker', 1]);
  const restored = (await app.inject({ method: 'POST', url: '/api/admin/prompts/score/restore', payload: { versionId: null } })).json();
  assert.equal(restored.source, 'default');
  const again = (await app.inject({ method: 'POST', url: '/api/admin/prompts/score/restore', payload: { versionId: saved.versionId } })).json();
  assert.equal(again.template, draft);
  await app.close();
  store.close();
});

test('OpenAPI lists the routes; summary reports the fractional target; binding is localhost only', async () => {
  const { app, store } = await setup();
  const spec = (await app.inject('/api/openapi.json')).json();
  for (const path of ['/api/postings', '/api/postings/{id}', '/api/postings/{id}/actions/{action}', '/api/tasks/{id}', '/api/summary']) {
    assert.ok(spec.paths[path], path);
  }
  const s = (await app.inject('/api/summary')).json();
  assert.deepEqual([s.fractionalTarget, s.pipeline], [[200000, 250000], 2]);
  assert.doesNotThrow(() => assertSafeBinding({ host: '127.0.0.1' }));
  assert.throws(() => assertSafeBinding({ host: '0.0.0.0' }), /only allows localhost/);
  await app.close();
  store.close();
});
