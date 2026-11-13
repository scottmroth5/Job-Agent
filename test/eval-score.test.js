import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaude } from '@scottmroth5/agent-core';
import { pairwiseAccuracy, summarize } from '../evals/score/metrics.js';
import { runEval } from '../evals/score/run.js';
import { buildCases } from '../evals/score/build-cases.js';
import { openJobStore } from '../db/index.ts';
import { fakeConfig, fakeHttp } from './fixtures/fakes.js';
/** @import { ScoreCase } from '../evals/score/build-cases.js' */

// Synthetic cases only.
test('pairwiseAccuracy counts wins and half-credits ties', () => {
  const items = [
    { label: 'applied', score: 9 },
    { label: 'applied', score: 6 },
    { label: 'passed', score: 6 },
    { label: 'passed', score: 3 },
    { label: 'passed', score: null },
  ];
  // pairs: 9>6, 9>3, 6=6 (0.5), 6>3 => 3.5 / 4
  assert.equal(pairwiseAccuracy(items), 0.875);
  assert.equal(pairwiseAccuracy([{ label: 'applied', score: 5 }]), null);
});

test('summarize reports means, promotion shares and failures', () => {
  const s = summarize([
    { label: 'applied', score: 9 },
    { label: 'applied', score: 7 },
    { label: 'passed', score: 8 },
    { label: 'passed', score: 2 },
    { label: 'passed', score: null },
  ]);
  assert.deepEqual(
    { ...s, pairwiseAccuracy: Math.round(Number(s.pairwiseAccuracy) * 100) },
    { cases: 5, scored: 4, failures: 1, pairwiseAccuracy: 75, meanApplied: 8, meanPassed: 5, appliedPromoted: 0.5, passedPromoted: 0.5 },
  );
});

const KNOWLEDGE = 'Section 5: Job Targets. Engineering leadership. '.repeat(20);
const config = fakeConfig({ candidate: { name: 'Pat Example' }, search: { homeAreaLabel: 'the Anytown area', homeLocations: ['Anytown, ST'] } });

test('runEval scores each case per model with the production code and keeps a v1 baseline', async () => {
  const client = {
    messages: {
      create: async (/** @type {{ model: string, messages: Array<{ content: string }> }} */ params) => {
        const applied = params.messages[0].content.includes('APPLIED');
        const score = params.model === 'claude-haiku-4-5' ? (applied ? 8 : 4) : 6;
        return {
          id: 'm',
          model: params.model,
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify({ score, reason: 'r', roleType: 'Full time', locationConcern: 'none', strengths: [], watchOuts: [], topTalkingPoint: 't', suggestedStatus: 'pass' }) }],
          usage: { input_tokens: 100, output_tokens: 10 },
        };
      },
    },
  };
  const cases = /** @type {ScoreCase[]} */ ([
    { id: 1, label: 'applied', company: 'A', title: 'CTO', location: 'Remote', location_check: 'remote', jd_text: 'APPLIED job text', v1Score: 8 },
    { id: 2, label: 'passed', company: 'B', title: 'VP', location: 'Remote', location_check: 'remote', jd_text: 'other job text', v1Score: 8 },
    { id: 3, label: 'passed', company: 'C', title: 'VP', location: 'Faraway, ZZ', location_check: 'conflict', jd_text: 'x', v1Score: null },
  ]); // no url: runEval never reads it
  const out = await runEval({ cases, models: ['claude-haiku-4-5', 'claude-sonnet-5-5'], claude: createClaude({ client }), config, knowledge: KNOWLEDGE });
  assert.equal(out.perModel['claude-haiku-4-5'].summary.pairwiseAccuracy, 1);
  assert.equal(out.perModel['claude-sonnet-5-5'].summary.pairwiseAccuracy, 0.75); // 6=6 tie, 6>2 (conflict rule)
  assert.equal(out.perModel['claude-haiku-4-5'].results.find((r) => r.id === 3)?.source, 'v2-rule');
  assert.equal(out.v1.pairwiseAccuracy, 0.5);
  assert.ok(out.perModel['claude-haiku-4-5'].costUsd > 0);
});

test('buildCases uses pasted descriptions, refetches the rest, and skips cases with no text', async () => {
  const store = openJobStore(':memory:');
  const add = async (/** @type {{ url: string, status: string, jd: string | null }} */ o) =>
    (await store.db.prepare(`INSERT INTO postings (user_id, url, url_key, company, title, company_title_key, status, stage, jd_text, discovered_on, created_at, updated_at)
      VALUES (1, @url, @url, 'Co', 'CTO', @url, @status, 'archived', @jd, '2026-01-01', 'x', 'x') RETURNING id`).run(o)).id;
  const pasted = await add({ url: 'https://a.example.com/1', status: 'applied', jd: 'y'.repeat(600) });
  await add({ url: 'https://a.example.com/2', status: 'passed', jd: null }); // refetched
  await add({ url: 'https://a.example.com/3', status: 'passed', jd: null }); // fetch fails
  await add({ url: 'https://a.example.com/4', status: 'new', jd: 'y'.repeat(600) }); // not an outcome
  await store.db.prepare("INSERT INTO scores (user_id, posting_id, score, source, created_at) VALUES (1, ?, 7, 'v1-analysis', 'x')").run(pasted);
  const http = fakeHttp({
    get: async (url) => {
      if (url.endsWith('/2')) return /** @type {{ status: number, text: string, url: string }} */ ({ status: 200, text: `<p>${'Lead the engineering organization. '.repeat(40)}</p>` });
      throw Object.assign(new Error('gone'), { name: 'HttpError', status: 404 });
    },
    sleep: async () => {},
  });
  const { cases, skipped, fetched } = await buildCases({ db: store.db, http, config });
  assert.deepEqual(cases.map((c) => [c.label, c.v1Score]), [['applied', 7], ['passed', null]]);
  assert.equal(fetched, 1);
  assert.equal(skipped.noText, 1);
  store.close();
});
