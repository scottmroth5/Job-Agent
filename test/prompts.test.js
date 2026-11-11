import { asEngine } from '../db/engine/index.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaude } from '@scottmroth5/agent-core';
import { openJobStore } from '../db/index.ts';
import { PROMPTS, getPrompt, defaultPrompt, savePrompt, restorePrompt, listVersions, validateTemplate, placeholdersIn } from '../agents/prompts.ts';
import { scorePostings } from '../agents/discovery/score.ts';
import { fakeConfig } from './fixtures/fakes.js';

test('every default prompt passes its own validation', () => {
  for (const name of Object.keys(PROMPTS)) assert.deepEqual(validateTemplate(name, defaultPrompt(name).template), [], name);
});

test('validation rejects unknown, missing, spaced and unmatched placeholders', async () => {
  const base = defaultPrompt('cover-letter').template;
  assert.match(validateTemplate('cover-letter', `${base} {{salary}}`).join(' '), /Unknown placeholder: \{\{salary\}\}/);
  assert.match(validateTemplate('cover-letter', base.replaceAll('{{analysis}}', '')).join(' '), /Required placeholder is missing: \{\{analysis\}\}/);
  assert.match(validateTemplate('cover-letter', `${base} {{ company }}`).join(' '), /must not contain spaces/);
  assert.match(validateTemplate('cover-letter', `${base} {{oops`).join(' '), /unmatched/);
  assert.match(validateTemplate('score', '').join(' '), /empty/);
  assert.deepEqual(placeholdersIn('{{a}} {{b}} {{a}}'), ['a', 'b']);
  await assert.rejects(async () => await getPrompt(null, 'nope'), /Unknown prompt/);
});

test('save, history and restore; version hashes match the default when unchanged', async () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  const original = await getPrompt(db, 'score');
  assert.equal(original.source, 'default');
  assert.equal((await getPrompt(null, 'score')).version, original.version);

  const edited = `${original.template}\nKeep the reason under 25 words.`;
  const saved = await savePrompt(db, 'score', { template: edited, note: 'shorter reasons' });
  assert.deepEqual([saved.source, saved.note], ['custom', 'shorter reasons']);
  assert.notEqual(saved.version, original.version);
  assert.equal((await savePrompt(db, 'score', { template: edited })).versionId, saved.versionId, 'saving the same text adds no version');

  const second = await savePrompt(db, 'score', { template: `${edited}\nBe concise.` });
  const versions = await listVersions(db, 'score');
  assert.deepEqual(versions.map((v) => v.active), [true, false]);

  assert.equal((await restorePrompt(db, 'score', saved.versionId)).template, edited);
  assert.deepEqual((await listVersions(db, 'score')).map((v) => v.active), [false, true]);
  const back = await restorePrompt(db, 'score', null);
  assert.deepEqual([back.source, back.version], ['default', original.version]);
  assert.equal((await listVersions(db, 'score')).length, 2, 'history is kept after restoring the default');
  assert.equal(Number(second.versionId) > Number(saved.versionId), true);

  /** @typedef {Error & { statusCode?: number }} HttpError */
  await assert.rejects(async () => await savePrompt(db, 'score', { template: 'no placeholders' }), (/** @type {HttpError} */ e) => e.statusCode === 400 && /Required placeholders/.test(e.message));
  await assert.rejects(async () => await restorePrompt(db, 'score', 9999), (/** @type {HttpError} */ e) => e.statusCode === 404);
  store.close();
});

test('scoring uses the active edited prompt and records its version', async () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  const marker = 'EDITED-PROMPT-MARKER';
  const custom = await savePrompt(db, 'score', { template: `${(await getPrompt(db, 'score')).template}\n${marker}` });
  await asEngine(db).prepare(`INSERT INTO postings (user_id, url, url_key, company, title, company_title_key, fetch_status, fetched_text, location, location_check, discovered_on, created_at, updated_at)
    VALUES (1, 'u', 'u', 'Example Co', 'CTO', 'k', 'ok', 'Lead the team.', 'Remote', 'remote', '2026-09-30', 'x', 'x')`).run();
  /** @type {string[]} */
  const seen = [];
  const client = {
    messages: {
      create: async (/** @type {{ model: string, messages: Array<{ content: string }> }} */ params) => {
        seen.push(params.messages[0].content);
        const data = { score: 6, reason: 'r', roleType: 'Full time', locationConcern: 'none', strengths: [], watchOuts: [], topTalkingPoint: 't', suggestedStatus: 'pass' };
        return { id: 'm', model: params.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(data) }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  };
  const config = fakeConfig({ candidate: { name: 'Pat Example' }, search: { homeAreaLabel: 'the Anytown area', homeLocations: [] } });
  await scorePostings({ store, config, claude: createClaude({ client }), knowledge: 'Section 5. '.repeat(60), model: 'claude-haiku-4-5' });
  assert.ok(seen[0].includes(marker));
  assert.equal(await asEngine(db).prepare('SELECT prompt_version FROM scores').pluck().get(), custom.version);
  store.close();
});
