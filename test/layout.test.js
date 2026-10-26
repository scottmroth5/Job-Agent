// Arranging the Home tiles: the order rule (web/src/layout.js) and the saved order (server/layout.js, PUT /api/layout/home).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openJobStore } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { LAYOUT_AREAS } from '../server/layout.js';
import { arranged, moved } from '../web/src/layout.js';
import { repoPath } from '../tools/paths.js';

const HOME = LAYOUT_AREAS.home;

test('the order rule: saved first, new items in their default place, unknown and repeated ones dropped', () => {
  assert.deepEqual(arranged(HOME, null), HOME);
  assert.deepEqual(arranged(HOME, []), HOME);
  assert.deepEqual(arranged(HOME, ['funnel', 'jobs']), ['funnel', 'jobs', 'inbox', 'activity', 'admin', 'settings', 'help', 'add']);
  assert.deepEqual(arranged(HOME, ['gone', 'admin', 'admin']), ['admin', 'jobs', 'inbox', 'funnel', 'activity', 'settings', 'help', 'add']);
  assert.deepEqual(moved(['a', 'b', 'c'], 1, -1), ['b', 'a', 'c']);
  assert.deepEqual(moved(['a', 'b', 'c'], 2, 1), ['a', 'b', 'c'], 'the last stays last');
  assert.deepEqual(moved(['a', 'b', 'c'], 0, -1), ['a', 'b', 'c'], 'the first stays first');
});

test('the Home page and the server name the same tiles', () => {
  const jsx = readFileSync(repoPath('web', 'src', 'components', 'HomePage.jsx'), 'utf8');
  const keys = JSON.parse(/HOME_TILES = (\[[^\]]+\])/.exec(jsx)[1].replaceAll("'", '"'));
  assert.deepEqual(keys, HOME);
});

async function setup(authMode = 'none') {
  const store = openJobStore(':memory:');
  const app = await buildApp({ store, config: { search: { homeLocations: [] }, fractional: {} }, services: { createBrowser: async () => null }, authMode });
  return { store, app, done: async () => { await app.close(); store.close(); } };
}

test('API: the saved order comes back with the summary; an empty list resets it; bad orders are refused', async () => {
  const { app, done } = await setup();
  assert.equal((await app.inject('/api/summary')).json().layout.home, null, 'never arranged');
  const put = (order) => app.inject({ method: 'PUT', url: '/api/layout/home', payload: { order } });
  const saved = await put(['inbox', 'jobs']);
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.json().order, ['inbox', 'jobs']);
  assert.deepEqual((await app.inject('/api/summary')).json().layout.home, ['inbox', 'jobs']);
  for (const bad of [['jobs', 'jobs'], ['<script>'], ['jobs', 'inbox', 'funnel', 'activity', 'admin', 'settings', 'help', 'add', 'jobs'], [3]]) {
    assert.equal((await put(bad)).statusCode, 400, JSON.stringify(bad));
  }
  // Fastify strips properties the schema does not name (removeAdditional), so they never reach the handler.
  assert.deepEqual((await app.inject({ method: 'PUT', url: '/api/layout/home', payload: { order: ['jobs'], extra: 1 } })).json(), { order: ['jobs'] });
  assert.equal((await app.inject({ method: 'PUT', url: '/api/layout/other', payload: { order: [] } })).statusCode, 404);
  assert.equal((await put([])).json().order, null);
  assert.equal((await app.inject('/api/summary')).json().layout.home, null, 'reset to the default');
  await done();
});

test('API: the demo cannot arrange', async () => {
  const { app, done } = await setup('demo');
  assert.equal((await app.inject({ method: 'PUT', url: '/api/layout/home', payload: { order: ['inbox'] } })).statusCode, 403);
  await done();
});
