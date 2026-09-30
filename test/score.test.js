import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaude } from '@scottmroth5/agent-core';
import { openJobStore } from '../db/index.js';
import { sanitizeDashes, truncate } from '../tools/text.js';
import {
  buildScoreRequest,
  interpretResult,
  loadScorePrompt,
  ruleScore,
  scorePostings,
  selectPostings,
  estimateCost,
} from '../agents/discovery/score.js';

// Synthetic config and knowledge; no real data.
const config = {
  candidate: { name: 'Pat Example' },
  search: { homeAreaLabel: 'the Anytown area', homeLocations: ['Anytown, ST'], terms: ['x'], relevantTitleKeywords: ['x'] },
};
const KNOWLEDGE = 'Section 5: Job Targets. Senior engineering leadership roles. '.repeat(20);
const prompt = loadScorePrompt();

const result = (o = {}) => ({
  score: 8,
  reason: 'Strong match — scaled teams',
  roleType: 'Full time',
  locationConcern: 'none',
  strengths: ['Scaled a platform -- twice'],
  watchOuts: ['Domain is new'],
  topTalkingPoint: 'Platform growth',
  suggestedStatus: 'worth_pursuing',
  ...o,
});

/** Fake Anthropic client: answers every request with the next result (or throws it). */
function fakeClaude(replies) {
  const requests = [];
  const client = {
    messages: {
      create: async (params) => {
        requests.push(params);
        const r = typeof replies === 'function' ? replies(params) : replies.shift();
        if (r instanceof Error) throw r;
        return {
          id: 'msg',
          model: params.model,
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify(r) }],
          usage: { input_tokens: 1000, output_tokens: 200 },
        };
      },
    },
  };
  return { requests, claude: createClaude({ client }) };
}

function addPosting(db, o = {}) {
  const row = {
    url: `https://jobs.example.com/${Math.random()}`,
    company: 'Example Co',
    title: 'VP Engineering',
    location: 'Remote',
    location_check: 'remote',
    fetch_status: 'ok',
    fetched_text: 'Lead a team of forty engineers across platform and product.',
    stage: 'discovered',
    status: 'new',
    ...o,
  };
  return Number(
    db
      .prepare(`INSERT INTO postings (url, url_key, company, title, company_title_key, location, location_check, fetch_status,
        fetched_text, stage, status, discovered_on, created_at, updated_at)
        VALUES (@url, @url, @company, @title, @url, @location, @location_check, @fetch_status, @fetched_text, @stage, @status,
        '2026-09-30', 'x', 'x')`)
      .run(row).lastInsertRowid,
  );
}

test('sanitizeDashes and truncate', () => {
  assert.equal(sanitizeDashes('Led teams — at scale -- and more; well-known'), 'Led teams, at scale, and more; well-known');
  assert.equal(truncate('short', 10), 'short');
  const text = `${'a'.repeat(90)}.\n${'b'.repeat(40)}`;
  assert.equal(truncate(text, 100), `${'a'.repeat(90)}.\n[truncated]`, 'cuts at a line break near the end');
  assert.equal(truncate('x'.repeat(50), 20), `${'x'.repeat(20)}\n[truncated]`, 'hard cut when no boundary is near');
});

test('buildScoreRequest fills every placeholder and applies model settings', () => {
  const posting = { company: 'Example Co', title: 'CTO', location: 'Newark, ST', location_check: 'remote', url: 'https://x', fetched_text: 'Build things.' };
  const haiku = buildScoreRequest(posting, { config, knowledge: KNOWLEDGE, model: 'claude-haiku-4-5', prompt });
  assert.equal(haiku.system, KNOWLEDGE);
  assert.equal(haiku.maxTokens, 1500);
  assert.equal(haiku.effort, undefined);
  assert.ok(!/\{\{/.test(haiku.prompt));
  assert.match(haiku.prompt, /fits Pat Example/);
  assert.match(haiku.prompt, /the Anytown area/);
  assert.match(haiku.prompt, /Location: Remote \(listed location: Newark, ST\)/, 'remote-checked jobs are shown as remote');
  assert.match(haiku.prompt, /Job content:\nBuild things\./);

  const sonnet = buildScoreRequest({ ...posting, location_check: 'remote_signal', fetched_text: '' }, { config, knowledge: KNOWLEDGE, model: 'claude-sonnet-5-5', prompt });
  assert.deepEqual([sonnet.effort, sonnet.maxTokens], ['low', 8000]);
  assert.match(sonnet.prompt, /LOCATION NOTE/);
  assert.match(sonnet.prompt, /No job content available/);
  assert.throws(() => buildScoreRequest(posting, { config, knowledge: KNOWLEDGE, model: 'claude-unknown', prompt }), /No scoring settings/);
});

test('interpretResult removes dashes and enforces location caps', () => {
  const clean = interpretResult(result(), { location_check: 'remote' });
  assert.equal(clean.reason, 'Strong match, scaled teams');
  assert.deepEqual(clean.analysis.strengths, ['Scaled a platform, twice']);
  assert.equal(interpretResult(result({ score: 9 }), { location_check: 'unverified' }).score, 7);
  assert.equal(interpretResult(result({ score: 9, locationConcern: 'conflict' }), { location_check: 'unknown' }).score, 2);
});

test('ruleScore explains a conflict without an AI call', () => {
  const r = ruleScore({ location: 'Faraway, ZZ' }, config);
  assert.equal(r.score, 2);
  assert.match(r.reason, /Faraway, ZZ.*the Anytown area.*without an AI call/);
});

test('scorePostings stores scores, applies the rule, promotes 8+, and skips scored postings', async () => {
  const store = openJobStore(':memory:');
  const high = addPosting(store.db);
  const low = addPosting(store.db);
  const conflict = addPosting(store.db, { location: 'Faraway, ZZ', location_check: 'conflict' });
  addPosting(store.db, { status: 'passed' }); // never scored
  addPosting(store.db, { fetch_status: null }); // v1 history, not selected by default
  const { claude, requests } = fakeClaude((params) => (params.messages[0].content.includes('Lead a team') ? result({ score: requests.length === 1 ? 9 : 5 }) : result()));

  const summary = await scorePostings({ store, config, claude, knowledge: KNOWLEDGE, model: 'claude-haiku-4-5', options: { concurrency: 1 } });
  assert.equal(summary.selected, 3);
  assert.equal(summary.scored, 3);
  assert.equal(summary.ruleScored, 1);
  assert.equal(requests.length, 2, 'the conflict posting made no Claude call');
  assert.deepEqual(summary.promoted, [high]);

  const rows = store.db.prepare('SELECT posting_id, score, source, model, prompt_version FROM scores ORDER BY posting_id').all();
  assert.deepEqual(rows.map((r) => [r.posting_id, r.score, r.source]), [[high, 9, 'v2'], [low, 5, 'v2'], [conflict, 2, 'v2-rule']]);
  assert.equal(rows[0].model, 'claude-haiku-4-5');
  assert.equal(rows[0].prompt_version, prompt.version);
  assert.equal(store.db.prepare('SELECT stage FROM postings WHERE id = ?').pluck().get(high), 'pipeline');
  assert.equal(store.db.prepare('SELECT stage FROM postings WHERE id = ?').pluck().get(low), 'discovered');
  assert.equal(JSON.parse(store.db.prepare('SELECT analysis_json FROM scores WHERE posting_id = ?').pluck().get(high)).topTalkingPoint, 'Platform growth');

  assert.equal(selectPostings(store.db).length, 0, 'a second run scores nothing');
  assert.equal(selectPostings(store.db, { allUnscored: true }).length, 1, '--all-unscored includes v1 history');
  store.close();
});

test('scorePostings leaves failures unscored and stops after repeated failures', async () => {
  const store = openJobStore(':memory:');
  for (let i = 0; i < 4; i++) addPosting(store.db);
  const { claude } = fakeClaude(() => Object.assign(new Error('bad key'), { name: 'AuthenticationError' }));
  const summary = await scorePostings({
    store, config, claude, knowledge: KNOWLEDGE, model: 'claude-haiku-4-5',
    options: { concurrency: 1, maxConsecutiveFailures: 2 },
  });
  assert.equal(summary.scored, 0);
  assert.equal(summary.failures.length, 2);
  assert.equal(summary.aborted, true);
  assert.match(summary.failures[0].error, /AuthenticationError/);
  assert.equal(store.db.prepare('SELECT COUNT(*) FROM scores').pluck().get(), 0);
  store.close();
});

test('scorePostings refuses to run without usable knowledge', async () => {
  const store = openJobStore(':memory:');
  await assert.rejects(scorePostings({ store, config, claude: {}, knowledge: 'too short', model: 'claude-haiku-4-5' }), /Candidate Knowledge/);
  store.close();
});

test('estimateCost skips rule-scored postings and knows only listed models', () => {
  const postings = [{ location_check: 'remote', fetched_text: 'x'.repeat(4000) }, { location_check: 'conflict' }];
  const usd = estimateCost(postings, { model: 'claude-haiku-4-5', knowledgeChars: 10000, templateChars: 2000 });
  assert.ok(usd > 0.004 && usd < 0.01, String(usd));
  assert.equal(estimateCost(postings, { model: 'other', knowledgeChars: 1, templateChars: 1 }), null);
});
