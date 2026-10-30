// Meeting prep. Synthetic people, jobs, and knowledge only; Claude and Google Drive are faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaude } from '@scottmroth5/agent-core';
import { openJobStore } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { buildPrepRequest, extractDocument, normalizePrepInput, prepDocName, prepHtml, PREP_MODEL } from '../agents/hunt/prep.js';
import { getPrompt } from '../agents/prompts.js';

const config = {
  candidate: { name: 'Pat Example', signoffName: 'Pat' },
  search: { homeAreaLabel: 'the Anytown area', homeLocations: ['Anytown, ST'] },
  fractional: { targetAnnual: [200000, 250000], weeksPerYear: 48 },
  coverLetterChecks: [],
};
const KNOWLEDGE = 'Section 1: Experience. Led platform teams. '.repeat(20);
const DOC = `# Call Prep: Alex Sample, Example Co\n*VP Engineering | recruiter screen*\n\n## The Meeting at a Glance\n- **Goal:** learn the scope\n\n| What they want | Your evidence |\n| --- | --- |\n| Scale | Grew a team ${'to 80 people '.repeat(10)}|\n`;

const posting = { id: 1, company: 'Example Co', title: 'VP Engineering', url: 'https://jobs.example.com/1', fetched_text: 'Lead the engineering team. '.repeat(10), notes: '- Recruiter: **Alex**' };
const input = normalizePrepInput({
  attendees: [{ name: '  Alex Sample ', role: 'Founder', organization: 'Sample Search', url: 'https://www.linkedin.com/in/alex-sample', about: 'Met at a meetup' }, { name: '' }],
  meetingAt: '2026-10-15T10:00',
  kind: 'Recruiter or search firm',
  format: 'Video',
  context: 'Intro call; ask about the team.',
});

test('input: people are trimmed and required, unsafe links dropped, unknown choices cleared, research on by default', () => {
  assert.deepEqual(input.attendees, [{ name: 'Alex Sample', role: 'Founder', organization: 'Sample Search', url: 'https://www.linkedin.com/in/alex-sample', about: 'Met at a meetup' }]);
  assert.equal(input.research, true);
  const odd = normalizePrepInput({ attendees: [{ name: 'B', url: 'javascript:alert(1)' }], kind: 'Party', format: 'Carrier pigeon', research: false });
  assert.deepEqual([odd.attendees[0].url, odd.kind, odd.format, odd.research, odd.meetingAt], ['', null, null, false, null]);
  assert.throws(() => normalizePrepInput({ attendees: [{ name: ' ' }] }), /at least one person/);
  assert.throws(() => normalizePrepInput({ attendees: [{ name: 'A' }], meetingAt: 'someday' }), /not valid/);
  assert.throws(() => normalizePrepInput({ attendees: Array.from({ length: 9 }, (_, i) => ({ name: `P${i}` })) }), /At most 8/);
});

test('request: Opus 5.5 with the knowledge as the system prompt, web research only when asked, everything in the prompt', () => {
  const prompt = getPrompt(null, 'meeting-prep');
  const req = buildPrepRequest(posting, input, { config, knowledge: KNOWLEDGE, prompt, analysis: { score: 8, reason: 'Strong', strengths: ['Scale'], watchOuts: [], topTalkingPoint: 'Growth' }, letter: 'Letter body', now: new Date(2026, 9, 12) });
  assert.equal(req.model, PREP_MODEL);
  assert.equal(req.system, KNOWLEDGE);
  assert.deepEqual(req.tools.map((t) => t.type), ['web_search_20260209', 'web_fetch_20260209']);
  assert.deepEqual([req.stream, req.fallbacks, req.betas], [true, 'default', ['server-side-fallback-2026-07-01']]);
  for (const part of ['Pat Example', 'Example Co', 'Alex Sample, Founder, Sample Search (https://www.linkedin.com/in/alex-sample)', 'Met at a meetup', 'Recruiter or search firm, video meeting, Thursday, October 15, 2026 at 10:00 AM', 'Intro call; ask about the team.', '- Recruiter: **Alex**', 'FIT SCORE: 8 of 10', 'Letter body', 'Lead the engineering team.', 'Research first', 'Monday, October 12, 2026']) {
    assert.ok(req.prompt.includes(part), `prompt includes ${part}`);
  }
  assert.ok(!/\{\{\w+\}\}/.test(req.prompt), 'every placeholder is filled');
  const quiet = buildPrepRequest(posting, { ...input, research: false }, { config, knowledge: KNOWLEDGE, prompt });
  assert.equal(quiet.tools, undefined);
  assert.ok(quiet.prompt.includes('Do not research online'));
});

test('document: commentary before the last research step is dropped, citation pieces join, dashes become commas', () => {
  const content = [
    { type: 'text', text: "I'll look up Alex first." },
    { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'x' } },
    { type: 'web_search_tool_result', tool_use_id: 's1', content: [] },
    { type: 'text', text: 'Filtering those results.' },
    { type: 'code_execution_tool_result', tool_use_id: 'c1', content: {} },
    { type: 'thinking', thinking: '' },
    { type: 'text', text: 'Now I have what I need.\n\n# Call Prep: Alex\n\nAlex founded ' },
    { type: 'text', text: 'Sample Search in 2011', citations: [{ url: 'https://example.com' }] },
    { type: 'text', text: ' — a boutique firm.' },
  ];
  assert.equal(extractDocument(content), '# Call Prep: Alex\n\nAlex founded Sample Search in 2011, a boutique firm.');
  assert.equal(extractDocument([{ type: 'text', text: '# Title\n\n| a | b |\n| --- | --- |' }]), '# Title\n\n| a | b |\n| --- | --- |', 'table rules survive');
});

test('Google Doc: a readable name and bordered tables', () => {
  assert.equal(prepDocName('Pat Example', 'Example Co, Inc.', [{ name: 'Alex Sample' }]), 'Pat Example Meeting Prep with Alex Sample at Example Co, Inc.');
  assert.equal(prepDocName('Pat Example', 'X', [{ name: 'A B' }, { name: 'C' }, { name: 'D' }]), 'Pat Example Meeting Prep with A B and 2 more at X');
  const html = prepHtml(DOC);
  assert.match(html, /<table border="1"/);
  assert.match(html, /<h1>Call Prep: Alex Sample, Example Co<\/h1>/);
});

function fakeServices({ docFails = false } = {}) {
  const requests = [];
  const answer = async (params) => {
    requests.push(params);
    return {
      id: 'm',
      model: params.model,
      stop_reason: 'end_turn',
      content: [
        { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'q' } },
        { type: 'web_search_tool_result', tool_use_id: 's1', content: [] },
        { type: 'text', text: DOC },
      ],
      usage: { input_tokens: 20000, output_tokens: 6000, server_tool_use: { web_search_requests: 4 } },
    };
  };
  const api = { create: answer, stream: (p) => ({ finalMessage: () => answer(p) }) };
  const docs = [];
  return {
    requests,
    docs,
    services: {
      claude: createClaude({ client: { messages: api, beta: { messages: api } } }),
      knowledge: async () => KNOWLEDGE,
      drive: {
        getFile: async () => ({}),
        createFolder: async (name) => `folder:${name}`,
        createDocFromHtml: async (d) => {
          if (docFails) throw new Error('Drive is down');
          docs.push(d);
          return { id: 'doc1', url: 'https://docs.example.com/doc1' };
        },
      },
      http: { get: async () => { throw new Error('no network in tests'); }, sleep: async () => {} },
      createBrowser: async () => null,
    },
  };
}

async function setup(opts) {
  const store = openJobStore(':memory:');
  const id = Number(
    store.db.prepare(`INSERT INTO postings (user_id, url, url_key, company, title, company_title_key, source, stage, status, track, fetched_text, notes, location, discovered_on, created_at, updated_at)
      VALUES (1, 'https://jobs.example.com/1', 'k1', 'Example Co', 'VP Engineering', 'example|vp engineering', 'LinkedIn', 'pipeline', 'applied', 'fulltime', ?, ?, 'Remote', '2026-10-01', 'x', 'x')`)
      .run(posting.fetched_text, posting.notes).lastInsertRowid,
  );
  const fake = fakeServices(opts);
  const app = await buildApp({ store, config, services: fake.services });
  return { store, app, id, fake };
}

async function finish(app, taskId) {
  for (let i = 0; i < 200; i++) {
    const t = (await app.inject(`/api/tasks/${taskId}`)).json();
    if (t.status !== 'running') return t;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('task did not finish');
}

test('API: a prep runs as a task, is saved with its cost and Google Doc, listed on the job, readable, and deletable', async () => {
  const { app, store, id, fake } = await setup();
  const body = { attendees: [{ name: 'Alex Sample', role: 'Founder' }], meetingAt: '2026-10-15T10:00', kind: 'Recruiter or search firm', format: 'Video', context: 'Intro call' };
  const res = await app.inject({ method: 'POST', url: `/api/postings/${id}/meeting-prep`, payload: body });
  assert.equal(res.statusCode, 202);
  const task = await finish(app, res.json().taskId);
  assert.equal(task.status, 'done', JSON.stringify(task));
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].model, 'claude-opus-5-5');

  const list = (await app.inject(`/api/postings/${id}`)).json().meetingPreps;
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].attendees[0].name, list[0].kind, list[0].docUrl, list[0].webSearches], ['Alex Sample', 'Recruiter or search firm', 'https://docs.example.com/doc1', 4]);
  // 20000*4 + 6000*20 = 200000 per million = $0.20, plus 4 searches at $0.01
  assert.ok(Math.abs(list[0].costUsd - 0.24) < 1e-9);
  assert.equal(fake.docs[0].folderId, 'folder:Job Agent Meeting Prep');
  assert.equal(fake.docs[0].name, 'Pat Example Meeting Prep with Alex Sample at Example Co');

  const one = (await app.inject(`/api/meeting-preps/${list[0].id}`)).json();
  assert.ok(one.content.startsWith('# Call Prep: Alex Sample'));
  assert.equal(one.context, 'Intro call');

  const log = (await app.inject(`/api/tasks/${res.json().taskId}/log`)).json().lines.map((l) => l.text).join('\n');
  assert.ok(!log.includes('Alex') && !log.includes('Call Prep'), 'task output has counts only, no names or text');

  assert.equal((await app.inject({ method: 'DELETE', url: `/api/meeting-preps/${list[0].id}` })).statusCode, 204);
  assert.equal((await app.inject(`/api/meeting-preps/${list[0].id}`)).statusCode, 404);
  await app.close();
  store.close();
});

test('API: refusals for no people, unknown jobs, and bad choices; a failed Google Doc still keeps the prep', async () => {
  const { app, store, id } = await setup({ docFails: true });
  assert.equal((await app.inject({ method: 'POST', url: `/api/postings/${id}/meeting-prep`, payload: { attendees: [] } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: `/api/postings/${id}/meeting-prep`, payload: { attendees: [{ name: ' ' }] } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/postings/999/meeting-prep', payload: { attendees: [{ name: 'A' }] } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: `/api/postings/${id}/meeting-prep`, payload: { attendees: [{ name: 'A' }], kind: 'Party' } })).statusCode, 400);

  const res = await app.inject({ method: 'POST', url: `/api/postings/${id}/meeting-prep`, payload: { attendees: [{ name: 'A' }], research: false } });
  const task = await finish(app, res.json().taskId);
  assert.equal(task.status, 'done');
  const list = (await app.inject(`/api/postings/${id}`)).json().meetingPreps;
  assert.deepEqual([list.length, list[0].docUrl, list[0].research], [1, null, false]);
  await app.close();
  store.close();
});
