// The cover letter fact check in the job panel and after generation (server/letter-routes.js, agents/letter-checks.js,
// agents/hunt/generate.js). Synthetic data; Claude is a stand-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openJobStore } from '../db/index.ts';
import { buildApp } from '../server/app.js';
import { generateForPostings } from '../agents/hunt/generate.js';
import { CHECKS_PER_DAY } from '../server/letter-routes.js';

const config = { candidate: { name: 'Pat Example' }, coverLetterChecks: [], search: { homeLocations: [] }, fractional: {} };
const LETTER = `When I read that Example Co is building a care platform, I recognized the stage you are in.\n\nI grew a platform team from 6 to 45 engineers as VP of Engineering, and I hold a PMP.\n\nI would welcome a conversation.`;
const CLAIMS = [
  { claim: 'grew a team from 6 to 45 engineers', kind: 'number', verdict: 'supported', evidence: 'grew the team from 6 to 45' },
  { claim: 'VP of Engineering', kind: 'title', verdict: 'contradicted', evidence: 'Director of Engineering' },
  { claim: 'holds a PMP', kind: 'credential', verdict: 'unsupported', evidence: '' },
];

async function setup({ fail = false } = {}) {
  const store = openJobStore(':memory:');
  const { db } = store;
  const id = Number(
    db.prepare(`INSERT INTO postings (user_id, url, url_key, company, title, company_title_key, stage, status, fetched_text, discovered_on, created_at, updated_at)
      VALUES (1, 'https://jobs.example.com/1', 'k1', 'Example Co', 'VP Engineering', 'k1', 'pipeline', 'new', 'Lead the platform team.', '2026-10-01', 'x', 'x')`).run().lastInsertRowid,
  );
  const v1 = Number(db.prepare("INSERT INTO artifacts (user_id, posting_id, kind, content, source, created_at) VALUES (1, ?, 'cover_letter', ?, 'v2', '2026-10-02T12:00:00Z')").run(id, LETTER).lastInsertRowid);
  const sent = [];
  const claude = {
    send: async (opts) => {
      sent.push(opts);
      if (fail) throw Object.assign(new Error('refused'), { name: 'BudgetError' });
      return { data: { claims: CLAIMS }, text: '' };
    },
  };
  const app = await buildApp({ store, config, services: { createBrowser: async () => null, claude, knowledge: async () => 'Background. '.repeat(60), log: { info() {}, warn() {}, error() {} } } });
  return { store, db, app, id, v1, sent };
}
const post = (app, url, payload) => app.inject({ method: 'POST', url, payload });

test('checking a version saves its claims, versions carry the check, and claims are dismissed one at a time', async () => {
  const { app, id, v1, sent } = await setup();
  let r = await app.inject({ method: 'GET', url: `/api/postings/${id}/letters` });
  assert.equal(r.json()[0].check, null, 'not checked yet');

  r = await post(app, `/api/postings/${id}/letters/${v1}/check`);
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().status, 'checked');
  assert.equal(r.json().claims.length, 3);
  assert.equal(sent[0].label, 'letter-check');
  assert.ok(sent[0].prompt.includes('PMP') && sent[0].system.startsWith('Background.'));

  r = await post(app, `/api/postings/${id}/letters/${v1}/claims/2/dismiss`);
  assert.equal(r.json().claims[2].dismissed, true);
  assert.equal((await post(app, `/api/postings/${id}/letters/${v1}/claims/7/dismiss`)).statusCode, 404);
  r = await app.inject({ method: 'GET', url: `/api/postings/${id}/letters` });
  assert.equal(r.json()[0].check.claims[2].dismissed, true);
  await app.close();
});

test('a failed check answers "failed", keeps the letter, and restoring a version copies its check', async () => {
  const failing = await setup({ fail: true });
  const r = await post(failing.app, `/api/postings/${failing.id}/letters/${failing.v1}/check`);
  assert.equal(r.statusCode, 200);
  assert.deepEqual([r.json().status, r.json().claims], ['failed', []]);
  assert.equal(failing.db.prepare('SELECT content FROM artifacts WHERE id = ? AND user_id = @uid').pluck().get(failing.v1), LETTER);
  await failing.app.close();

  const { app, id, v1 } = await setup();
  await post(app, `/api/postings/${id}/letters/${v1}/check`);
  const restored = await post(app, `/api/postings/${id}/letter/restore`, { versionId: v1 });
  const [current] = restored.json().versions;
  assert.notEqual(current.id, v1);
  assert.equal(current.check.status, 'checked');
  await app.close();
});

// Another user's versions: test/user-isolation.test.js calls every route, these included, as a second user.
test('an unknown version is not found, and checks stop at the daily limit', async () => {
  const { app, id, v1 } = await setup();
  assert.equal((await post(app, `/api/postings/${id}/letters/999/check`)).statusCode, 404);
  for (let i = 0; i < CHECKS_PER_DAY; i += 1) await post(app, `/api/postings/${id}/letters/${v1}/check`);
  assert.equal((await post(app, `/api/postings/${id}/letters/${v1}/check`)).statusCode, 429);
  await app.close();
});

test('writing a letter checks it, and a failed check still keeps the letter', async () => {
  for (const fail of [false, true]) {
    const store = openJobStore(':memory:');
    const { db } = store;
    const id = Number(
      db.prepare(`INSERT INTO postings (user_id, url, url_key, company, title, company_title_key, stage, status, fetched_text, discovered_on, created_at, updated_at)
        VALUES (1, 'https://jobs.example.com/1', 'k1', 'Example Co', 'VP Engineering', 'k1', 'pipeline', 'new', 'Lead the platform team.', '2026-10-01', 'x', 'x')`).run().lastInsertRowid,
    );
    db.prepare("INSERT INTO scores (user_id, posting_id, score, analysis_json, source, created_at) VALUES (1, ?, 8, ?, 'v2', 'x')").run(id, JSON.stringify({ score: 8, reason: 'Fit', strengths: [], watchOuts: [], topTalkingPoint: 'Growth' }));
    const claude = {
      send: async (opts) => {
        if (opts.label === 'letter-check') {
          if (fail) throw new Error('down');
          return { data: { claims: CLAIMS }, text: '' };
        }
        return { text: LETTER };
      },
    };
    const lines = [];
    const run = { id: null, log: (level, msg) => lines.push(msg) };
    const s = await generateForPostings({ store, config, claude, knowledge: 'Background. '.repeat(60), drive: null, run, options: { ids: [id] } });
    assert.equal(s.letters, 1);
    assert.equal(s.failures.length, 0);
    const status = db.prepare("SELECT c.status FROM letter_checks c JOIN artifacts a ON a.id = c.artifact_id WHERE a.posting_id = ? AND c.user_id = @uid").pluck().get(id);
    assert.equal(status, fail ? 'failed' : 'checked');
    assert.deepEqual([s.checked, s.claimFlags], fail ? [0, 0] : [1, 2]);
    assert.ok(lines.every((l) => !l.includes('PMP')), 'logs hold counts only');
    store.close();
  }
});
