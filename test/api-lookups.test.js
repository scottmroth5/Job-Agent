import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openJobStore } from '../db/index.js';
import { buildApp } from '../server/app.js';

// Synthetic data only.
async function setup() {
  const store = openJobStore(':memory:');
  const job = Number(
    store.db
      .prepare(`INSERT INTO postings (url_key, company, title, company_title_key, discovered_on, stage, status, created_at, updated_at)
        VALUES ('k1', 'Example Co', 'CTO', 'example|cto', '2026-10-01', 'pipeline', 'applied', 'x', 'x')`)
      .run().lastInsertRowid,
  );
  const app = await buildApp({ store, config: { search: { homeLocations: [] }, fractional: { weeksPerYear: 48 } }, services: { createBrowser: async () => null } });
  return { store, app, job };
}

const call = (app, method, url, payload) => app.inject({ method, url, ...(payload ? { payload } : {}) });

test('GET /api/lookups lists values in order with groups and roles', async () => {
  const { app, store } = await setup();
  const l = (await call(app, 'GET', '/api/lookups')).json();
  assert.deepEqual(l.lists.status.map((v) => v.id), ['new', 'applied', 'interviewing', 'offer', 'passed', 'closed', 'rejected', 'duplicate']);
  assert.deepEqual(l.lists.track.find((v) => v.id === 'fractional').settings, { scorePrompt: 'score-fractional', terms: true });
  assert.equal(l.roles.stage.promote, 'pipeline');
  assert.ok(l.groups.status.some((g) => g.key === 'conversation'));
  assert.ok(l.roleDefinitions.stage.some((r) => r.role === 'archive'));
  assert.equal(l.lists.status[0].jobs, undefined, 'job counts only on the admin route');
  await app.close();
  store.close();
});

test('admin: add, rename, reorder, archive, and restore; jobs keep IDs and use new values', async () => {
  const { app, store, job } = await setup();
  const added = (await call(app, 'POST', '/api/admin/lookups/status', { label: 'Phone screen', group: 'conversation' })).json();
  assert.equal(added.id, 'phone_screen');
  assert.equal((await call(app, 'PATCH', `/api/postings/${job}`, { status: 'phone_screen' })).json().status, 'phone_screen');
  assert.equal((await call(app, 'GET', '/api/postings?status=progress')).json().length, 1);

  let admin = (await call(app, 'PATCH', '/api/admin/lookups/status/phone_screen', { label: 'Recruiter screen' })).json();
  assert.equal(admin.lists.status.find((v) => v.id === 'phone_screen').label, 'Recruiter screen');
  assert.equal(admin.lists.status.find((v) => v.id === 'phone_screen').jobs, 1);
  admin = (await call(app, 'PATCH', '/api/admin/lookups/status/phone_screen', { move: 'up' })).json();
  assert.equal(admin.lists.status.at(-2).id, 'phone_screen');

  admin = (await call(app, 'PATCH', '/api/admin/lookups/status/phone_screen', { archived: true })).json();
  assert.equal(admin.lists.status.find((v) => v.id === 'phone_screen').archived, true);
  assert.equal((await call(app, 'GET', `/api/postings/${job}`)).json().status, 'phone_screen', 'the job keeps its archived status');
  assert.equal((await call(app, 'PATCH', `/api/postings/${job}`, { notes: 'still editable' })).statusCode, 200);
  assert.equal((await call(app, 'PATCH', `/api/postings/${job}`, { status: 'applied' })).statusCode, 200);
  const refused = await call(app, 'PATCH', `/api/postings/${job}`, { status: 'phone_screen' });
  assert.equal(refused.statusCode, 400);
  assert.match(refused.json().error, /not an available status/);
  await call(app, 'PATCH', '/api/admin/lookups/status/phone_screen', { archived: false });
  assert.equal((await call(app, 'PATCH', `/api/postings/${job}`, { status: 'phone_screen' })).statusCode, 200);
  await app.close();
  store.close();
});

test('admin: roles must point at an available value in the right group; a role holder cannot be archived', async () => {
  const { app, store } = await setup();
  const blocked = await call(app, 'PATCH', '/api/admin/lookups/stage/pipeline', { archived: true });
  assert.equal(blocked.statusCode, 400);
  assert.match(blocked.json().error, /promoted/);
  await call(app, 'POST', '/api/admin/lookups/stage', { label: 'Shortlist', group: 'active' });
  assert.equal((await call(app, 'PUT', '/api/admin/lookups/stage/roles', { role: 'promote', valueId: 'shortlist' })).json().roles.stage.promote, 'shortlist');
  assert.equal((await call(app, 'PATCH', '/api/admin/lookups/stage/pipeline', { archived: true })).statusCode, 200);
  assert.equal((await call(app, 'PUT', '/api/admin/lookups/stage/roles', { role: 'archive', valueId: 'shortlist' })).statusCode, 400);
  assert.equal((await call(app, 'POST', '/api/admin/lookups/track', { label: 'Contract', settings: { scorePrompt: 'score-fractional', terms: true } })).json().id, 'contract');
  assert.equal((await call(app, 'POST', '/api/admin/lookups/track', { label: 'X', settings: { scorePrompt: 'cover-letter' } })).statusCode, 400);
  assert.equal((await call(app, 'POST', '/api/admin/lookups/colors', { label: 'Red' })).statusCode, 400);
  assert.equal((await call(app, 'GET', '/api/postings?status=nonsense')).statusCode, 400);
  const spec = (await call(app, 'GET', '/api/openapi.json')).json();
  for (const p of ['/api/lookups', '/api/admin/lookups', '/api/admin/lookups/{list}', '/api/admin/lookups/{list}/{id}', '/api/admin/lookups/{list}/roles']) assert.ok(spec.paths[p], p);
  await app.close();
  store.close();
});
