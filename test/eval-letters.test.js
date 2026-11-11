// The letter fact check eval's scoring (evals/letters/metrics.js) and its synthetic cases. No model is called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { judgeLetter, letterMetrics } from '../evals/letters/metrics.js';
import { estimateLetterEval } from '../evals/letters/run.js';
import { KINDS } from '../agents/hunt/verify-letter.ts';
/** @import { JsonRow } from './fixtures/fakes.js' */

const cases = JSON.parse(readFileSync(new URL('../evals/letters/cases.json', import.meta.url), 'utf8'));
const flag = (/** @type {string} */ claim, verdict = 'contradicted') => ({ claim, kind: 'other', verdict, evidence: '' });

test('a planted error is found only by a flagged claim that mentions it; other flags are extra', () => {
  const expect = { kind: 'credential', mentions: ['pmp'] };
  assert.deepEqual(judgeLetter(expect, [flag('certified PMP', 'unsupported'), flag('led 32 engineers', 'supported')]), { found: true, flags: 1, extra: 0 });
  assert.deepEqual(judgeLetter(expect, [{ ...flag('certified PMP'), verdict: 'supported' }]), { found: false, flags: 0, extra: 0 });
  assert.deepEqual(judgeLetter(expect, [flag('VP title')]), { found: false, flags: 1, extra: 1 });
  assert.deepEqual(judgeLetter(null, [flag('anything', 'unsupported')]), { found: null, flags: 1, extra: 1 });
});

test('totals: recall by kind, clean letters flagged, cost, and failures', () => {
  const m = letterMetrics([
    { id: 'a', expect: { kind: 'number', mentions: ['120'] }, claims: [flag('led 120 engineers')], costUsd: 0.02, ms: 1000 },
    { id: 'b', expect: { kind: 'number', mentions: ['5 million'] }, claims: [], error: 'Error', costUsd: 0, ms: 500 },
    { id: 'c', expect: null, claims: [flag('led 32', 'supported')], costUsd: 0.02, ms: 1500 },
    { id: 'd', expect: null, claims: [flag('a degree', 'unsupported')], costUsd: 0.02, ms: 1000 },
  ]);
  assert.deepEqual([m.planted, m.found, m.recall, m.missed, m.failed], [2, 1, 0.5, ['b'], 1]);
  assert.deepEqual(m.byKind, { number: { planted: 2, found: 1 } });
  assert.deepEqual([m.clean, m.cleanFlagged, m.falseFlagRate], [2, ['d'], 0.5]);
  assert.equal(m.costPerLetter, 0.015);
});

test('the cases: every letter names a posting, every planted kind is real, each kind has two or more, and all addresses are examples', async () => {
  /** @type {Record<string, number>} */
  const kinds = {};
  for (const l of cases.letters) {
    assert.ok(cases.postings[l.posting], l.id);
    if (l.expect) {
      assert.ok(KINDS.includes(l.expect.kind) && l.expect.mentions.length, l.id);
      kinds[l.expect.kind] = (kinds[l.expect.kind] ?? 0) + 1;
    }
  }
  for (const k of ['title', 'employer', 'number', 'credential', 'date']) assert.ok(kinds[k] >= 2, k);
  assert.ok(cases.letters.filter((/** @type {JsonRow} */ l) => !l.expect).length >= 4, 'clean letters');
  for (const email of JSON.stringify(cases).match(/[\w.]+@[\w-]+(?:\.[\w-]+)+/g) ?? []) assert.match(email, /@example\.com$/);
  const est = await estimateLetterEval(cases, ['claude-haiku-4-5', 'claude-sonnet-5-5']);
  const [sonnet, haiku] = [est['claude-sonnet-5-5'], est['claude-haiku-4-5']];
  assert.ok(sonnet != null && haiku != null && sonnet > haiku && sonnet < 1);
});
