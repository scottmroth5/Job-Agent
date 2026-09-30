import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaude } from '@scottmroth5/agent-core';
import { openJobStore } from '../db/index.js';
import { getSetting } from '../db/settings.js';
import { ensureLetterFolder } from '../tools/google/drive.js';
import { generateForPostings, selectForHunt, buildLetterRequest, loadHuntPrompts, finishLetter, estimateHuntCost } from '../agents/hunt/generate.js';

// Synthetic config, knowledge and postings only.
const config = {
  candidate: { name: 'Pat Example', signoffName: 'Pat', contactLine: 'pat@example.com', linkedin: 'linkedin.com/in/example' },
  coverLetterChecks: [{ label: 'confident', text: '\\bi am confident\\b' }],
};
const KNOWLEDGE = 'Section 6: Cover Letter Rules. '.repeat(30);
const analysis = { score: 8, reason: 'Strong fit', roleType: 'Full time', locationConcern: 'none', strengths: ['Scale'], watchOuts: ['Domain'], topTalkingPoint: 'Platform growth', suggestedStatus: 'worth_pursuing' };

function fakeClaude(respond) {
  const requests = [];
  const client = {
    messages: {
      create: async (params) => {
        requests.push(params);
        const text = respond(params);
        if (text instanceof Error) throw text;
        return { id: 'm', model: params.model, stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 50 } };
      },
    },
  };
  return { requests, claude: createClaude({ client }) };
}

function fakeDrive({ failDocs = false } = {}) {
  const calls = { folders: 0, docs: [] };
  return {
    calls,
    getFile: async () => ({ trashed: false }),
    createFolder: async () => {
      calls.folders += 1;
      return 'folder-1';
    },
    createDocFromHtml: async (doc) => {
      if (failDocs) throw Object.assign(new Error('quota'), { name: 'GaxiosError' });
      calls.docs.push(doc);
      return { id: `doc-${calls.docs.length}`, url: `https://docs.example.com/${calls.docs.length}` };
    },
  };
}

function addPosting(db, { stage = 'pipeline', status = 'new', score = 8, title = 'VP Engineering' } = {}) {
  const url = `https://jobs.example.com/${Math.random()}`;
  const id = Number(
    db.prepare(`INSERT INTO postings (url, url_key, company, title, company_title_key, stage, status, fetched_text, discovered_on, created_at, updated_at)
      VALUES (?, ?, 'Example Co', ?, ?, ?, ?, 'Lead the platform team.', '2026-09-30', 'x', 'x')`).run(url, url, title, url, stage, status).lastInsertRowid,
  );
  if (score != null) {
    db.prepare("INSERT INTO scores (posting_id, score, analysis_json, source, created_at) VALUES (?, ?, ?, 'v2', 'x')").run(id, score, JSON.stringify({ ...analysis, score }));
  }
  return id;
}

const reply = (params) =>
  params.messages[0].content.includes('resume tailoring')
    ? 'HEADLINE TWEAK: Platform leader — scaled teams'
    : 'Dear Hiring Team,\n\nI am confident this is a fit -- truly.\n\nSecond paragraph.\n\nSincerely,\nPat Example';

test('finishLetter strips the greeting and sign-off, removes dashes, and flags rules', () => {
  const { body, flags } = finishLetter(reply({ messages: [{ content: '' }] }), config);
  assert.equal(body, 'I am confident this is a fit, truly.\n\nSecond paragraph.');
  assert.deepEqual(flags, ['confident']);
});

test('finishLetter flags letters over the word limit', () => {
  const long = Array.from({ length: 360 }, () => 'word').join(' ');
  assert.deepEqual(finishLetter(long, config).flags, ['360 words (limit 350)']);
});

test('buildLetterRequest fills the approved prompt with executive positioning and Sonnet settings', () => {
  const req = buildLetterRequest({ company: 'Example Co', title: 'CTO', fetched_text: 'Build it.', notes: null }, analysis, { config, knowledge: KNOWLEDGE, prompts: loadHuntPrompts() });
  assert.equal(req.model, 'claude-sonnet-5-5');
  assert.deepEqual([req.effort, req.maxTokens], ['medium', 12000]);
  assert.match(req.prompt, /for Pat Example applying for CTO at Example Co/);
  assert.match(req.prompt, /executive \(CTO, VP, Director\)/);
  assert.match(req.prompt, /TOP TALKING POINT: Platform growth/);
  assert.ok(!/\{\{/.test(req.prompt));
});

test('generateForPostings writes tweaks and a letter Doc for promoted jobs only, once', async () => {
  const store = openJobStore(':memory:');
  const eligible = addPosting(store.db);
  addPosting(store.db, { score: 6 }); // below the promotion threshold
  addPosting(store.db, { status: 'passed' });
  addPosting(store.db, { stage: 'discovered' });
  addPosting(store.db, { score: null }); // no v2 score
  const { claude, requests } = fakeClaude(reply);
  const drive = fakeDrive();

  const summary = await generateForPostings({ store, config, claude, knowledge: KNOWLEDGE, drive, now: new Date(2026, 8, 30) });
  assert.deepEqual([summary.selected, summary.tweaks, summary.letters, summary.docs], [1, 1, 1, 1]);
  assert.equal(requests.length, 2);
  assert.deepEqual(summary.flagged, [{ id: eligible, flags: ['confident'] }]);
  assert.equal(drive.calls.docs[0].name, 'Example_Co_VP_Engineering_CoverLetter_2026-09-30');
  assert.match(drive.calls.docs[0].html, /September 30, 2026/);
  assert.equal(drive.calls.docs[0].folderId, 'folder-1');

  const arts = store.db.prepare('SELECT kind, content, doc_id, doc_url, flags_json, model FROM artifacts ORDER BY id').all();
  assert.equal(arts[0].kind, 'resume_tweaks');
  assert.equal(arts[0].content, 'HEADLINE TWEAK: Platform leader, scaled teams');
  assert.deepEqual([arts[1].kind, arts[1].doc_id, arts[1].flags_json, arts[1].model], ['cover_letter', 'doc-1', '["confident"]', 'claude-sonnet-5-5']);

  assert.equal(selectForHunt(store.db).length, 0, 'a second run has nothing to do');
  store.close();
});

test('a failed Doc save keeps the letter and the next run retries only the Doc', async () => {
  const store = openJobStore(':memory:');
  addPosting(store.db);
  const first = fakeClaude(reply);
  const s1 = await generateForPostings({ store, config, claude: first.claude, knowledge: KNOWLEDGE, drive: fakeDrive({ failDocs: true }) });
  assert.equal(s1.letters, 1);
  assert.equal(s1.docFailures.length, 1);

  const second = fakeClaude(reply);
  const s2 = await generateForPostings({ store, config, claude: second.claude, knowledge: KNOWLEDGE, drive: fakeDrive() });
  assert.deepEqual([s2.tweaks, s2.letters, s2.docs], [0, 0, 1]);
  assert.equal(second.requests.length, 0, 'no new Claude calls');
  assert.equal(store.db.prepare("SELECT COUNT(*) FROM artifacts WHERE kind = 'cover_letter'").pluck().get(), 1);
  store.close();
});

test('--ids targets any posting, and repeated failures stop the run', async () => {
  const store = openJobStore(':memory:');
  const ids = [addPosting(store.db, { stage: 'discovered', score: 5 }), addPosting(store.db), addPosting(store.db), addPosting(store.db)];
  assert.equal(selectForHunt(store.db, { ids: [ids[0]] }).length, 1);
  const { claude } = fakeClaude(() => Object.assign(new Error('overloaded'), { name: 'InternalServerError' }));
  const s = await generateForPostings({ store, config, claude, knowledge: KNOWLEDGE, drive: fakeDrive(), options: { maxConsecutiveFailures: 2 } });
  assert.equal(s.failures.length, 2);
  assert.equal(s.aborted, true);
  store.close();
});

test('ensureLetterFolder creates the folder once and remembers it', async () => {
  const store = openJobStore(':memory:');
  const drive = fakeDrive();
  assert.equal(await ensureLetterFolder(drive, store.db), 'folder-1');
  assert.equal(await ensureLetterFolder(drive, store.db), 'folder-1');
  assert.equal(drive.calls.folders, 1);
  assert.equal(getSetting(store.db, 'drive.coverLetterFolderId'), 'folder-1');
  const trashed = { ...fakeDrive(), getFile: async () => ({ trashed: true }), createFolder: async () => 'folder-2' };
  assert.equal(await ensureLetterFolder(trashed, store.db), 'folder-2');
  store.close();
});

test('estimateHuntCost counts only the calls still needed', () => {
  const both = estimateHuntCost([{ has_tweaks: 0, has_letter: 0, fetched_text: 'x'.repeat(4000) }], 10000);
  const one = estimateHuntCost([{ has_tweaks: 1, has_letter: 0, fetched_text: 'x'.repeat(4000) }], 10000);
  assert.ok(Math.abs(both - 2 * one) < 1e-9 && one > 0.02 && one < 0.05, `${one}`);
});
