// Resumes (agents/resumes.js, server/resume-routes.js): upload, label and match titles, default, replace, delete,
// download your own only, and the right one reaching each job's letter and tweaks. Synthetic files and data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createClaude } from '@scottmroth5/agent-core';
import { openJobStore } from '../db/index.js';
import { addUser } from '../db/users.js';
import { runAsUser } from '../db/scope.js';
import { addResume, deleteResume, listResumes, MAX_RESUMES, pickResume, replaceResumeFile, updateResume, withResume } from '../agents/resumes.js';
import { generateForPostings } from '../agents/hunt/generate.js';
import { exportAccount } from '../agents/account-data.js';
import { buildApp } from '../server/app.js';
import { authSettings } from '../server/auth.js';
import { SESSION_COOKIE, sessionKey, sign } from '../server/session.js';

const SITE = 'http://localhost:5178';
const text = (who, extra = '') => Buffer.from(`${who} resume. Led platform teams at Example Co. ${extra}`.padEnd(120, '.'));

test('the first upload is the default; titles pick per job, else the default; deleting the default promotes another', async () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  assert.equal(pickResume(db, 'VP Engineering'), null, 'no resumes: writing uses the background alone');
  const general = await addResume(db, { bytes: text('General'), filename: 'General.txt' });
  assert.deepEqual([general.label, general.isDefault, general.kind], ['General', true, 'text']);
  const exec = await addResume(db, { bytes: text('Executive'), filename: 'exec.md' });
  updateResume(db, exec.id, { label: 'Executive', titles: 'VP, Head of,  Chief ,\nCTO' });
  assert.equal(listResumes(db).find((r) => r.id === exec.id).titles, 'VP, Head of, Chief, CTO');

  assert.equal(pickResume(db, 'VP of Engineering').label, 'Executive');
  assert.equal(pickResume(db, 'Head of Platform').label, 'Executive');
  assert.equal(pickResume(db, 'Senior Engineering Manager').label, 'General', 'no match: the default');
  assert.equal(pickResume(db, 'Heading Coach').label, 'General', 'whole words only');
  assert.match(withResume('Background.', pickResume(db, 'CTO')), /^Background\.\n\n## Resume to work from: Executive\n[\s\S]*Executive resume/);
  assert.equal(withResume('Background.', null), 'Background.');

  updateResume(db, exec.id, { isDefault: true });
  assert.deepEqual(listResumes(db).map((r) => [r.label, r.isDefault]), [['Executive', true], ['General', false]], 'one default');
  const replaced = await replaceResumeFile(db, exec.id, { bytes: text('Executive v2'), filename: 'exec-2026.txt' });
  assert.deepEqual([replaced.label, replaced.filename, replaced.isDefault], ['Executive', 'exec-2026.txt', true]);
  assert.match(pickResume(db, 'CTO').text, /Executive v2/);
  deleteResume(db, exec.id);
  assert.deepEqual(listResumes(db).map((r) => [r.label, r.isDefault]), [['General', true]]);
  store.close();
});

test('limits: at most MAX_RESUMES, and only readable documents', async () => {
  const store = openJobStore(':memory:');
  await assert.rejects(addResume(store.db, { bytes: text('Old'), filename: 'old.doc' }), /\.docx or PDF/);
  for (let i = 0; i < MAX_RESUMES; i++) await addResume(store.db, { bytes: text(`R${i}`), filename: `r${i}.txt` });
  await assert.rejects(addResume(store.db, { bytes: text('One more'), filename: 'x.txt' }), /at most 10/);
  store.close();
});

function fakeClaude() {
  const systems = [];
  const client = {
    messages: {
      create: async (params) => {
        systems.push(JSON.stringify(params.system));
        return { id: 'm', model: params.model, stop_reason: 'end_turn', content: [{ type: 'text', text: 'A short paragraph about the role.' }], usage: { input_tokens: 10, output_tokens: 5 } };
      },
    },
  };
  return { systems, claude: createClaude({ client }) };
}

test("each job's letter and tweaks are written from its resume, and the artifacts record which", async () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  const exec = await addResume(db, { bytes: text('EXEC-MARKER'), filename: 'exec.txt' });
  updateResume(db, exec.id, { titles: 'VP' });
  await addResume(db, { bytes: text('IC-MARKER'), filename: 'ic.txt' });
  const job = (title) => {
    const url = `https://jobs.example.com/${Math.random()}`;
    const id = Number(
      db.prepare(`INSERT INTO postings (user_id, url, url_key, company, title, company_title_key, stage, status, fetched_text, discovered_on, created_at, updated_at)
        VALUES (1, ?, ?, 'Example Co', ?, ?, 'pipeline', 'new', 'Lead the platform team.', '2026-09-30', 'x', 'x')`).run(url, url, title, url).lastInsertRowid,
    );
    db.prepare("INSERT INTO scores (user_id, posting_id, score, analysis_json, source, created_at) VALUES (1, ?, 8, ?, 'v2', 'x')").run(id, JSON.stringify({ score: 8, reason: 'r', strengths: [], watchOuts: [] }));
    return id;
  };
  const vp = job('VP Engineering');
  const { systems, claude } = fakeClaude();
  await generateForPostings({ store, config: { candidate: { name: 'Pat Example' }, coverLetterChecks: [] }, claude, knowledge: 'Background text.', options: { ids: [vp] } });
  assert.equal(systems.length, 2, 'tweaks and a letter');
  for (const s of systems) assert.ok(s.includes('EXEC-MARKER') && !s.includes('IC-MARKER') && s.includes('Background text.'));
  const used = db.prepare('SELECT DISTINCT resume_id FROM artifacts WHERE posting_id = ? AND user_id = @uid').pluck().all(vp);
  assert.deepEqual(used, [exec.id]);
  store.close();
});

test('routes: upload, edit, download with safe headers, and another user sees none of it; export has text, not the file', async () => {
  const secret = randomBytes(48).toString('base64');
  const settings = authSettings({ AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'c', GOOGLE_WEB_CLIENT_SECRET: 's', AUTH_ALLOWED_EMAILS: 'owner@example.com', SESSION_SECRET: secret });
  const store = openJobStore(':memory:', { fallbackUid: null });
  const b = addUser(store.raw, { email: 'b@example.com' });
  const app = await buildApp({ store, config: { search: { homeLocations: [] }, fractional: {} }, authMode: 'google', auth: { settings }, services: { createBrowser: async () => null, log: { info() {}, warn() {}, error() {} } } });
  const as = (email) => ({ cookie: `${SESSION_COOKIE}=${sign({ email, exp: Date.now() + 3_600_000, v: 1 }, sessionKey(secret))}`, origin: SITE });
  const owner = as('owner@example.com');
  const other = as('b@example.com');

  const up = await app.inject({ method: 'POST', url: '/api/resumes', headers: { ...owner, 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent('Pat résumé.txt') }, payload: text('Pat') });
  assert.equal(up.statusCode, 201);
  const id = up.json().id;
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/resumes/${id}`, headers: owner, payload: { label: 'Main', titles: 'VP' } })).json().label, 'Main');

  const file = await app.inject({ url: `/api/resumes/${id}/file`, headers: owner });
  assert.equal(file.statusCode, 200);
  assert.match(file.headers['content-disposition'], /^attachment; filename="Pat r_sum_.txt"; filename\*=UTF-8''Pat%20r%C3%A9sum%C3%A9\.txt$/);
  assert.equal(file.headers['x-content-type-options'], 'nosniff');
  assert.match(file.headers['content-security-policy'], /sandbox/);
  assert.equal(file.rawPayload.toString(), text('Pat').toString());

  assert.deepEqual((await app.inject({ url: '/api/resumes', headers: other })).json(), []);
  for (const [method, url] of [['GET', `/api/resumes/${id}/file`], ['PATCH', `/api/resumes/${id}`], ['DELETE', `/api/resumes/${id}`]]) {
    assert.equal((await app.inject({ method, url, headers: other, ...(method === 'PATCH' ? { payload: { label: 'x' } } : {}) })).statusCode, 404, `${method} as another user`);
  }
  const exported = runAsUser(1, () => exportAccount(store.raw, 1));
  const row = exported.tables?.resumes?.[0] ?? exported.resumes?.[0];
  assert.ok(row && row.text && row.file === undefined, 'export: the text, never the file blob');
  assert.equal(runAsUser(b, () => listResumes(store.db)).length, 0);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/resumes/${id}`, headers: owner })).statusCode, 204);
  await app.close();
  store.close();
});
