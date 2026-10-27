// The job panel's score details (server/queries.js scoreDetails, agents/prompts.js describeVersion): when and how the
// current score was made, which prompt, and when a re-score would change it. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openJobStore } from '../db/index.js';
import { getPosting } from '../server/queries.js';
import { defaultPrompt, describeVersion, getPrompt, savePrompt, versionOf } from '../agents/prompts.js';

function setup() {
  const store = openJobStore(':memory:');
  const { db } = store;
  const job = (o = {}) =>
    Number(
      db.prepare(`INSERT INTO postings (user_id, url_key, company, title, company_title_key, source, track, discovered_on, stage, status, fetched_text, created_at, updated_at)
          VALUES (1, @k, 'Example Co', 'CTO', @k, 'LinkedIn', @track, '2026-10-01', 'pipeline', 'new', @text, 'x', 'x')`)
        .run({ k: `k${Math.random()}`, track: 'fulltime', text: 'The full posting.', ...o }).lastInsertRowid,
    );
  const score = (id, o = {}) =>
    db.prepare(`INSERT INTO scores (user_id, posting_id, score, reason, analysis_json, source, model, prompt_version, created_at)
        VALUES (1, @id, @score, 'r', @analysis, @source, @model, @version, @at)`)
      .run({ id, score: 8, analysis: '{}', source: 'v2', model: 'claude-sonnet-5-5', version: getPrompt(db, 'score').version, at: '2026-10-02T12:00:00Z', ...o });
  return { store, db, job, score };
}

test('a score from the posting text with the default prompt, then the prompt is edited', () => {
  const { store, db, job, score } = setup();
  const id = job();
  score(id);
  let d = getPosting(db, id).scoreDetails;
  assert.deepEqual({ at: d.at, model: d.model, from: d.from, kind: d.prompt.kind, current: d.prompt.current }, { at: '2026-10-02T12:00:00Z', model: 'claude-sonnet-5-5', from: 'text', kind: 'default', current: true });
  savePrompt(db, 'score', { template: `${defaultPrompt('score').template}\nWeigh healthcare higher.`, note: 'Healthcare' });
  d = getPosting(db, id).scoreDetails;
  assert.equal(d.prompt.kind, 'default');
  assert.equal(d.prompt.current, false, 'the prompt changed after this score');
  store.close();
});

test("a score with the user's edit names it; an unknown version is an earlier one; 'default' rows say nothing", () => {
  const { store, db, job, score } = setup();
  const edited = `${defaultPrompt('score').template}\nWeigh healthcare higher.`;
  savePrompt(db, 'score', { template: edited, note: 'Healthcare' });
  const id = job();
  score(id, { version: versionOf('score', edited) });
  const p = getPosting(db, id).scoreDetails.prompt;
  assert.deepEqual({ kind: p.kind, note: p.note, current: p.current }, { kind: 'edit', note: 'Healthcare', current: true });
  assert.ok(p.editedAt);
  assert.equal(describeVersion(db, 'score', 'abcdef0123').kind, 'earlier');
  assert.equal(describeVersion(db, 'score', 'default'), null);
  store.close();
});

test('a title-only score is capped, says what it would be, and flags a description added since; rules and v1 are named', () => {
  const { store, db, job, score } = setup();
  const capped = job({ text: null });
  score(capped, { score: 5, analysis: JSON.stringify({ uncappedScore: 8 }) });
  let d = getPosting(db, capped).scoreDetails;
  assert.deepEqual({ from: d.from, uncapped: d.uncappedScore, since: d.textSinceScore }, { from: 'title', uncapped: 8, since: false });
  db.prepare("UPDATE postings SET jd_text = 'Pasted later.' WHERE id = ?").run(capped);
  assert.equal(getPosting(db, capped).scoreDetails.textSinceScore, true);

  const ruled = job();
  score(ruled, { score: 1, source: 'v2-rule', model: null, version: null });
  d = getPosting(db, ruled).scoreDetails;
  assert.deepEqual({ from: d.from, prompt: d.prompt }, { from: 'rule', prompt: null });
  const old = job();
  score(old, { source: 'v1-analysis', model: null, version: null });
  assert.equal(getPosting(db, old).scoreDetails.from, 'v1');
  assert.equal(getPosting(db, job()).scoreDetails, null, 'not scored yet');
  store.close();
});
