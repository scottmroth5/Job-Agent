// Cost estimates and the restore script's passphrase check: every model the app can run has a price (a missing one
// would count as $0 against --max-usd), the scoring eval's estimate leaves out what scoring never sends to a model,
// and backup:restore says when the passphrase is missing. Synthetic cases only; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODEL_SETTINGS, estimateCost } from '../agents/discovery/score.ts';
import { VERIFY_SETTINGS } from '../agents/hunt/verify-letter.ts';
import { estimateLetterEval } from '../evals/letters/run.js';
import { estimateEval } from '../evals/score/run.js';
import { unpriced } from '../evals/estimate.js';
import { repoPath } from '../tools/paths.ts';
import { fakeConfig } from './fixtures/fakes.js';
/** @import { ScoreCase } from '../evals/score/build-cases.js' */

/** @param {number} id @param {string} url @returns {ScoreCase} */
const posting = (id, url) => ({ id, label: 'applied', company: 'Example Co', title: 'VP of Engineering', location: null, url, location_check: 'ok', jd_text: 'x'.repeat(4000), v1Score: null });

test('every scoring model has a price', () => {
  for (const model of Object.keys(MODEL_SETTINGS)) {
    const usd = estimateCost([posting(1, 'https://jobs.example.com/1')], { model, knowledgeChars: 10000, templateChars: 3000, config: fakeConfig({ search: {} }) });
    assert.equal(typeof usd, 'number', model);
  }
});

test('every fact check model has a price in the letter eval', async () => {
  const cases = JSON.parse(readFileSync(repoPath('evals', 'letters', 'cases.json'), 'utf8'));
  const estimate = await estimateLetterEval(cases, Object.keys(VERIFY_SETTINGS));
  assert.deepEqual(unpriced(estimate), []);
});

test('unpriced names the models without a price', () => {
  assert.deepEqual(unpriced({ a: 0.5, b: null, c: 0 }), ['b']);
  assert.deepEqual(unpriced({}), []);
});

test('the scoring eval estimate leaves out cases on a skipped site, as scoring does', async () => {
  const cases = [posting(1, 'https://jobs.example.com/1'), posting(2, 'https://skipped.example.com/2')];
  const model = 'claude-haiku-4-5';
  const all = (await estimateEval(cases, [model], 10000, fakeConfig({ search: {} })))[model];
  const skipping = (await estimateEval(cases, [model], 10000, fakeConfig({ search: { excludedSites: ['skipped.example.com'] } })))[model];
  assert.ok(all != null && skipping != null && skipping > 0 && skipping < all, `${skipping} < ${all}`);
});

test('backup:restore without JOB_BACKUP_PASSPHRASE says so, before reading any backup', () => {
  const env = { ...process.env };
  delete env.JOB_BACKUP_PASSPHRASE;
  const out = join(mkdtempSync(join(tmpdir(), 'ja-restore-')), 'job-agent.db');
  const r = spawnSync(process.execPath, [repoPath('scripts', 'backup-restore.js'), '--file', 'latest', '--out', out], { env, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /JOB_BACKUP_PASSPHRASE is not set/);
});
