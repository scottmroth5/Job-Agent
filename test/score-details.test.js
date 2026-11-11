// The job panel's score details (server/queries.ts scoreDetails, agents/prompts.ts describeVersion): when and how the
// current score was made, which prompt, and when a re-score would change it. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openJobStore } from '../db/index.ts';
import { getPosting } from '../server/queries.ts';
import { defaultPrompt, describeVersion, getPrompt, savePrompt, versionOf } from '../agents/prompts.ts';
/** @import { Database } from '../tools/types.ts' */

/** @typedef {NonNullable<NonNullable<Awaited<ReturnType<typeof getPosting>>>['scoreDetails']>} Details */
/** @typedef {NonNullable<Details['prompt']>} PromptDetails */
/**
 * The score details of a job the test has scored (null otherwise, which the test then fails on).
 * @param {Database} db
 * @param {number} id
 */
const detailsOf = async (db, id) => /** @type {Details} */ ((await getPosting(db, id))?.scoreDetails);
/** Its prompt, for a score made with one. */
const promptOf = (/** @type {Details} */ d) => /** @type {PromptDetails} */ (d.prompt);

function setup() {
  const store = openJobStore(':memory:');
  const { db } = store;
  const job = (/** @type {Record<string, string | null>} */ o = {}) =>
    Number(
      db.prepare(`INSERT INTO postings (user_id, url_key, company, title, company_title_key, source, track, discovered_on, stage, status, fetched_text, created_at, updated_at)
          VALUES (1, @k, 'Example Co', 'CTO', @k, 'LinkedIn', @track, '2026-10-01', 'pipeline', 'new', @text, 'x', 'x')`)
        .run({ k: `k${Math.random()}`, track: 'fulltime', text: 'The full posting.', ...o }).lastInsertRowid,
    );
  const score = async (/** @type {number} */ id, /** @type {Record<string, string | number | null>} */ o = {}) =>
    db.prepare(`INSERT INTO scores (user_id, posting_id, score, reason, analysis_json, source, model, prompt_version, created_at)
        VALUES (1, @id, @score, 'r', @analysis, @source, @model, @version, @at)`)
      .run({ id, score: 8, analysis: '{}', source: 'v2', model: 'claude-sonnet-5-5', version: (await getPrompt(db, 'score')).version, at: '2026-10-02T12:00:00Z', ...o });
  return { store, db, job, score };
}

test('a score from the posting text with the default prompt, then the prompt is edited', async () => {
  const { store, db, job, score } = setup();
  const id = job();
  await score(id);
  let d = await detailsOf(db, id);
  assert.deepEqual({ at: d.at, model: d.model, from: d.from, kind: promptOf(d).kind, current: promptOf(d).current }, { at: '2026-10-02T12:00:00Z', model: 'claude-sonnet-5-5', from: 'text', kind: 'default', current: true });
  await savePrompt(db, 'score', { template: `${defaultPrompt('score').template}\nWeigh healthcare higher.`, note: 'Healthcare' });
  d = await detailsOf(db, id);
  assert.equal(promptOf(d).kind, 'default');
  assert.equal(promptOf(d).current, false, 'the prompt changed after this score');
  store.close();
});

test("a score with the user's edit names it; an unknown version is an earlier one; 'default' rows say nothing", async () => {
  const { store, db, job, score } = setup();
  const edited = `${defaultPrompt('score').template}\nWeigh healthcare higher.`;
  await savePrompt(db, 'score', { template: edited, note: 'Healthcare' });
  const id = job();
  await score(id, { version: versionOf('score', edited) });
  const p = promptOf(await detailsOf(db, id));
  assert.deepEqual({ kind: p.kind, note: p.note, current: p.current }, { kind: 'edit', note: 'Healthcare', current: true });
  assert.ok(p.editedAt);
  assert.equal((await describeVersion(db, 'score', 'abcdef0123'))?.kind, 'earlier');
  assert.equal(await describeVersion(db, 'score', 'default'), null);
  store.close();
});

test('a title-only score is capped, says what it would be, and flags a description added since; rules and v1 are named', async () => {
  const { store, db, job, score } = setup();
  const capped = job({ text: null });
  await score(capped, { score: 5, analysis: JSON.stringify({ uncappedScore: 8 }) });
  let d = await detailsOf(db, capped);
  assert.deepEqual({ from: d.from, uncapped: d.uncappedScore, since: d.textSinceScore }, { from: 'title', uncapped: 8, since: false });
  db.prepare("UPDATE postings SET jd_text = 'Pasted later.' WHERE id = ?").run(capped);
  assert.equal((await detailsOf(db, capped)).textSinceScore, true);

  const ruled = job();
  await score(ruled, { score: 1, source: 'v2-rule', model: null, version: null });
  d = await detailsOf(db, ruled);
  assert.deepEqual({ from: d.from, prompt: d.prompt }, { from: 'rule', prompt: null });
  const old = job();
  await score(old, { source: 'v1-analysis', model: null, version: null });
  assert.equal((await detailsOf(db, old)).from, 'v1');
  assert.equal((await getPosting(db, job()))?.scoreDetails, null, 'not scored yet');
  store.close();
});
