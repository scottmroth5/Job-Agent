import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createClaude } from '@scottmroth5/agent-core';
import { inboxMetrics } from '../evals/inbox/metrics.js';
import { runInboxEval } from '../evals/inbox/run.js';
import { loadInboxConfig } from '../agents/inbox/config.js';
import { EMAIL_TYPES } from '../agents/inbox/classify.js';

const data = JSON.parse(readFileSync(new URL('../evals/inbox/cases.json', import.meta.url), 'utf8'));

test('the eval cases are well formed', () => {
  const ids = new Set(data.applications.map((a) => a.id));
  assert.ok(data.cases.length >= 40);
  assert.equal(new Set(data.cases.map((c) => c.id)).size, data.cases.length);
  for (const c of data.cases) {
    assert.ok(EMAIL_TYPES.includes(c.expected.type), c.id);
    assert.ok(c.expected.applicationId === null || ids.has(c.expected.applicationId), c.id);
    assert.ok(c.email.from && c.email.subject && c.email.body, c.id);
  }
});

test('metrics: match and classification accuracy over classified emails, pre-filter rates over all', () => {
  const r = (expected, passed, predicted, rule = null) => ({ expected, passed, predicted, rule });
  const m = inboxMetrics([
    r({ applicationId: 1, type: 'confirmation' }, true, { applicationId: 1, type: 'confirmation', reviewStatus: 'auto' }, 'ats_subject'),
    r({ applicationId: 2, type: 'rejection' }, true, { applicationId: 3, type: 'rejection', reviewStatus: 'auto' }, 'model'),
    r({ applicationId: null, type: 'other' }, true, { applicationId: null, type: 'follow_up', reviewStatus: 'needs_review' }),
    r({ applicationId: null, type: 'recruiter_outreach' }, false, null),
    r({ applicationId: null, type: 'other' }, false, null),
  ]);
  assert.deepEqual([m.cases, m.classified, m.wrongLinks], [5, 3, 1]);
  assert.equal(m.matchAccuracy, 2 / 3);
  assert.equal(m.classificationAccuracy, 2 / 3);
  assert.equal(m.prefilterRecall, 2 / 3);
  assert.equal(m.prefilterDropRate, 1 / 2);
  assert.equal(m.reviewRate, 1 / 3);
  assert.equal(m.ruleMatchRate, 1 / 3);
});

test('the eval runs the real decision code with a fake model', async () => {
  // A "perfect" fake model that returns each case's expected answer, so only rules, the gate, and the
  // injection guard can make results differ from the labels.
  const byId = Object.fromEntries(data.cases.map((c) => [c.email.subject, c.expected]));
  const client = {
    messages: {
      create: async (params) => {
        const subject = /Subject: (.*)/.exec(params.messages[0].content)[1];
        const e = byId[subject];
        const reply = { application_id: e.applicationId == null ? null : String(e.applicationId), confidence: 0.95, type: e.type, summary: 'x', extracted: { company: null, role_title: null, contact_name: null, contact_email: null, interview_times: [], deadline: null } };
        return { id: 'x', model: params.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(reply) }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  };
  const results = await runInboxEval({ ...data, claude: createClaude({ client }), cfg: loadInboxConfig() });
  const m = inboxMetrics(results);
  assert.equal(m.classificationAccuracy, 1);
  assert.equal(m.wrongLinks, 0, 'rules never link a case to the wrong application');
  const injection = results.find((r) => r.id === 'c25');
  assert.deepEqual([injection.predicted.applicationId, injection.predicted.reviewStatus], [null, 'needs_review']);
});
