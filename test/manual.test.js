import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaude } from '@scottmroth5/agent-core';
import { openJobStore } from '../db/index.js';
import { addPosting, validateManualInput, isRealCompany } from '../agents/manual.js';

// Synthetic config, knowledge, and postings only.
const config = {
  candidate: { name: 'Pat Example', signoffName: 'Pat' },
  search: { homeAreaLabel: 'the Anytown area', homeLocations: ['Anytown, ST'] },
  fractional: { targetAnnual: [200000, 250000] },
  coverLetterChecks: [],
};
const KNOWLEDGE = 'Section 5: Job Targets. Engineering leadership. '.repeat(20);
const DESCRIPTION = 'We are hiring a fractional CTO to lead our platform team for ten to fifteen hours a week. '.repeat(3);

function fakeClaude(score) {
  const labels = [];
  const client = {
    messages: {
      create: async (params) => {
        const isScore = Boolean(params.output_config?.format);
        labels.push(isScore ? 'score' : 'writing');
        const data = { score, fit: 'High', reason: 'r', whyItFits: 'w', caveats: '', rate: { min: null, max: null, unit: 'unknown' }, hoursPerWeek: { min: null, max: null }, roleType: 'Fractional', locationConcern: 'none', strengths: [], watchOuts: [], topTalkingPoint: 't', suggestedStatus: 'worth_pursuing' };
        return { id: 'm', model: params.model, stop_reason: 'end_turn', content: [{ type: 'text', text: isScore ? JSON.stringify(data) : 'Body paragraph.' }], usage: { input_tokens: 10, output_tokens: 5 } };
      },
    },
  };
  return { labels, claude: createClaude({ client }) };
}

const drive = { getFile: async () => ({}), createFolder: async () => 'f', createDocFromHtml: async () => ({ id: 'd', url: 'https://docs.example.com/d' }) };
const noHttp = { get: async () => { throw new Error('no network in tests'); }, sleep: async () => {} };
const ctx = (store, claude, http = noHttp) => ({ store, config, http, browser: null, claude, knowledge: KNOWLEDGE, drive, run: null, steps: [] });

test('validateManualInput explains what is missing', () => {
  assert.throws(() => validateManualInput({}), /link to the posting, a pasted description/);
  assert.throws(() => validateManualInput({ url: 'ftp://x' }), /must start with http/);
  assert.throws(() => validateManualInput({ description: DESCRIPTION }), /enter the job title and company/);
  assert.throws(() => validateManualInput({ url: 'https://x.example.com', description: 'short' }), /very short/);
  assert.doesNotThrow(() => validateManualInput({ url: 'https://jobs.example.com/1' }));
});

test('a pasted fractional job is saved, scored, promoted, and gets materials; adding it again finds it', async () => {
  const store = openJobStore(':memory:');
  const { claude, labels } = fakeClaude(8);
  const steps = [];
  const input = { url: 'https://jobs.example.com/fcto', title: 'Fractional CTO', company: 'Example Co', description: DESCRIPTION, rateText: '$150 - $200 / hr', hoursText: '10 - 15 hrs', notes: 'Referred by a friend' };
  const result = await addPosting(input, { ...ctx(store, claude), onStep: (m) => steps.push(m) });

  assert.equal(result.created, true);
  assert.deepEqual([result.score, result.promoted], [8, true]);
  assert.deepEqual(labels, ['score', 'writing', 'writing']);
  const row = store.db.prepare('SELECT source, track, stage, jd_text IS NOT NULL AS pasted, rate_unit, hours_max, notes FROM postings WHERE id = ?').get(result.id);
  assert.deepEqual(row, { source: 'manual', track: 'fractional', stage: 'pipeline', pasted: 1, rate_unit: 'hour', hours_max: 15, notes: 'Referred by a friend' });
  assert.ok(steps.some((s) => /Scored 8 of 10, moved to your pipeline/.test(s)));
  assert.ok(steps.some((s) => /Cover letter saved as a Google Doc/.test(s)));

  const againSteps = [];
  const again = await addPosting({ url: 'https://jobs.example.com/fcto/' }, { ...ctx(store, claude), onStep: (m) => againSteps.push(m) });
  assert.deepEqual([again.id, again.created, again.matchedBy], [result.id, false, 'link']);
  assert.deepEqual(
    (({ title, company, stage, status, track, score, source }) => ({ title, company, stage, status, track, score, source }))(again.existing),
    { title: 'Fractional CTO', company: 'Example Co', stage: 'pipeline', status: 'new', track: 'fractional', score: 8, source: 'manual' },
  );
  assert.match(againSteps[0], /^Already saved: "Fractional CTO" at Example Co \(found by you on \d{4}-\d{2}-\d{2}, Pipeline, new, score 8\)$/);
  store.close();
});

test('a low score writes no materials unless asked; an explicit track wins', async () => {
  const store = openJobStore(':memory:');
  const { claude, labels } = fakeClaude(5);
  const r1 = await addPosting({ title: 'VP Engineering', company: 'Example Co', description: DESCRIPTION, track: 'fulltime' }, ctx(store, claude));
  assert.deepEqual([r1.promoted, r1.materials], [false, null]);
  assert.equal(store.db.prepare('SELECT track FROM postings WHERE id = ?').pluck().get(r1.id), 'fulltime');

  const r2 = await addPosting({ title: 'CTO', company: 'Other Co', description: DESCRIPTION, writeMaterials: true }, ctx(store, claude));
  assert.equal(r2.materials.letters, 1);
  assert.equal(store.db.prepare('SELECT stage FROM postings WHERE id = ?').pluck().get(r2.id), 'pipeline');
  assert.equal(labels.filter((l) => l === 'writing').length, 2);
  store.close();
});

test('company + title matching ignores placeholder companies like Unknown', async () => {
  const store = openJobStore(':memory:');
  const { claude } = fakeClaude(5);
  const first = await addPosting({ url: 'https://jobs.example.com/a', title: 'Fractional CTO', company: 'Unknown', description: DESCRIPTION }, ctx(store, claude));
  const second = await addPosting({ url: 'https://jobs.example.com/b', title: 'Fractional CTO', company: 'Unknown', description: DESCRIPTION }, ctx(store, claude));
  assert.ok(first.created && second.created && first.id !== second.id, 'different links with an unknown company are different jobs');
  const real = await addPosting({ title: 'VP Engineering', company: 'Example Co', description: DESCRIPTION }, ctx(store, claude));
  const again = await addPosting({ title: 'VP, Engineering', company: 'example co.', description: DESCRIPTION }, ctx(store, claude));
  assert.deepEqual([again.created, again.id, again.matchedBy], [false, real.id, 'company and title']);
  assert.ok(!isRealCompany('Unknown') && !isRealCompany('(unknown)') && !isRealCompany('See posting') && isRealCompany('Example Co'));
  store.close();
});

test('a link that cannot be read and has no title fails with a clear message', async () => {
  const store = openJobStore(':memory:');
  const { claude } = fakeClaude(5);
  await assert.rejects(addPosting({ url: 'https://jobs.example.com/unknown' }, ctx(store, claude)), /Couldn't read the job title or company/);
  assert.equal(store.db.prepare('SELECT COUNT(*) FROM postings').pluck().get(), 0);
  store.close();
});
