// Dated note entries. Synthetic jobs only.
import { createSqliteEngine } from '../db/engine/sqlite.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { openJobStore, loadMigrations } from '../db/index.ts';
import { buildApp } from '../server/app.ts';
import { addNote, adoptNotesText, deleteNote, listNotes, notesForPrompt, updateNote } from '../agents/notes.ts';
import { fakeConfig, fakeServices } from './fixtures/fakes.js';
/** @import { Note } from '../agents/notes.ts' */
/** @import { Db } from '../tools/types.ts' */

const config = fakeConfig({ candidate: { name: 'Pat Example' }, search: { homeLocations: [] }, fractional: {}, coverLetterChecks: [] });

/**
 * Used before 013 (no user_id yet) and after it (the owner's job).
 * @param {Db} db
 * @param {string | null} [notes]
 */
async function job(db, notes = null) {
  const owned = Boolean(await db.prepare("SELECT 1 FROM pragma_table_info('postings') WHERE name = 'user_id'").get());
  return Number(
    (await db.prepare(`INSERT INTO postings (${owned ? 'user_id, ' : ''}url_key, company, title, company_title_key, discovered_on, stage, status, notes, created_at, updated_at)
      VALUES (${owned ? '1, ' : ''}?, 'Example Co', 'CTO', ?, '2026-10-01', 'pipeline', 'new', ?, 'x', 'x')`).run(`k${Math.random()}`, `example|cto${Math.random()}`, notes)).id,
  );
}
const cache = async (/** @type {Db} */ db, /** @type {number} */ id) => await db.prepare('SELECT notes FROM postings WHERE id = ?').pluck().get(id);

test('migration: each job with notes text gets one "earlier" note; jobs without notes get none', async () => {
  // Apply every migration before 012, add jobs, then 012, as on a real database.
  const all = loadMigrations();
  const raw = new Database(':memory:');
  raw.exec('CREATE TABLE runs (id INTEGER PRIMARY KEY)');
  for (const m of all.filter((m) => m.id < '012')) (typeof m.up === 'string' ? raw.exec(m.up) : m.up(raw));
  const q = createSqliteEngine(raw, { fallbackUid: null, strictTx: false });
  const withNotes = await job(q, 'Referred by a friend\nRemoved 2026-10-01: duplicate of #3.');
  const blank = await job(q, '   ');
  const none = await job(q, null);
  /** @type {(db: import('better-sqlite3').Database) => void} */ (all.find((m) => m.id === '012-posting-notes')?.up)(raw); // a code migration
  // Read straight from the table: 012 ran before user_id existed, so today's (scoped) notes functions do not apply here.
  const notesOf = async (/** @type {number} */ id) => await q.prepare('SELECT source, body FROM posting_notes WHERE posting_id = ?').all(id);
  assert.deepEqual(await notesOf(withNotes), [{ source: 'earlier', body: 'Referred by a friend\nRemoved 2026-10-01: duplicate of #3.' }]);
  assert.equal((await notesOf(blank)).length + (await notesOf(none)).length, 0);
  raw.close();
});

test('add, edit, and delete keep their dates and keep postings.notes in step (oldest first)', async () => {
  const { db } = openJobStore(':memory:');
  const id = await job(db);
  const first = await addNote(db, id, '  First call went well  ', { now: new Date('2026-10-10T15:00:00Z') });
  const second = await addNote(db, id, 'Second round **Tuesday**', { now: new Date('2026-10-12T15:00:00Z') });
  assert.equal(first.body, 'First call went well', 'trimmed');
  assert.deepEqual((await listNotes(db, id)).map((n) => n.id), [second.id, first.id], 'newest first');
  assert.equal(await cache(db, id), 'First call went well\nSecond round **Tuesday**');

  const edited = await updateNote(db, first.id, 'First call went very well', { now: new Date('2026-10-14T09:00:00Z') });
  assert.deepEqual([edited?.createdAt, edited?.updatedAt], ['2026-10-10T15:00:00.000Z', '2026-10-14T09:00:00.000Z']);
  assert.equal((await updateNote(db, first.id, 'First call went very well', { now: new Date('2026-10-20T09:00:00Z') }))?.updatedAt, '2026-10-14T09:00:00.000Z', 'no change, no new date');
  assert.equal(await cache(db, id), 'First call went very well\nSecond round **Tuesday**');

  assert.equal(await deleteNote(db, second.id), true);
  assert.equal(await cache(db, id), 'First call went very well');
  assert.equal(await deleteNote(db, first.id), true);
  assert.equal(await cache(db, id), null);
  assert.equal(await deleteNote(db, first.id), false);
  assert.equal(await updateNote(db, first.id, 'x'), null);
  await assert.rejects(async () => await addNote(db, id, '   '), /needs some text/);
});

test('notes written as text before (or by an insert) become an entry before a new one is added', async () => {
  const { db } = openJobStore(':memory:');
  const id = await job(db, 'Typed long ago');
  await addNote(db, id, 'New note', { now: new Date('2026-10-16T12:00:00Z') });
  assert.deepEqual((await listNotes(db, id)).map((n) => [n.source, n.body]), [['user', 'New note'], ['earlier', 'Typed long ago']]);
  assert.equal(await cache(db, id), 'Typed long ago\nNew note');
});

test('for prompts: oldest first with dates, earlier and Job Agent notes labeled', () => {
  // Only the fields the prompt text uses.
  const text = notesForPrompt(/** @type {Note[]} */ ([
    { body: 'Latest', source: 'user', createdAt: '2026-10-15T15:00:00.000Z', updatedAt: '2026-10-16T15:00:00.000Z' },
    { body: 'Archived copy', source: 'agent', createdAt: '2026-10-12T15:00:00.000Z', updatedAt: '2026-10-12T15:00:00.000Z' },
    { body: 'Old', source: 'earlier', createdAt: '2026-10-11T15:00:00.000Z', updatedAt: '2026-10-11T15:00:00.000Z' },
  ]));
  assert.equal(text, [
    'Earlier note (before October 11, 2026):\nOld',
    'Note from October 12, 2026, added by Job Agent:\nArchived copy',
    'Note from October 15, 2026, edited October 16, 2026:\nLatest',
  ].join('\n\n'));
});

test('API: notes on the job, add, edit, delete; PATCH notes and duplicate marking add entries', async () => {
  const store = openJobStore(':memory:');
  const id = await job(store.db);
  const other = await job(store.db);
  const app = await buildApp({ store, config, services: fakeServices({ createBrowser: async () => null }) });

  const added = await app.inject({ method: 'POST', url: `/api/postings/${id}/notes`, payload: { body: 'Called **Alex**' } });
  assert.equal(added.statusCode, 201);
  const note = added.json();
  assert.equal(note.createdAt, note.updatedAt);
  assert.equal((await app.inject({ method: 'POST', url: `/api/postings/${id}/notes`, payload: { body: ' ' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/postings/999/notes', payload: { body: 'x' } })).statusCode, 404);

  const edited = (await app.inject({ method: 'PATCH', url: `/api/notes/${note.id}`, payload: { body: 'Called **Alex** twice' } })).json();
  assert.equal(edited.body, 'Called **Alex** twice');
  assert.equal(edited.createdAt, note.createdAt);

  await app.inject({ method: 'PATCH', url: `/api/postings/${id}`, payload: { notes: 'From the old notes field' } });
  await app.inject({ method: 'PATCH', url: `/api/postings/${id}`, payload: { duplicateOf: other } });
  const detail = (await app.inject(`/api/postings/${id}`)).json();
  assert.deepEqual(detail.noteEntries.map((/** @type {{ source: string }} */ n) => n.source), ['agent', 'user', 'user']);
  assert.match(detail.noteEntries[0].body, new RegExp(`^Duplicate of #${other}, CTO at Example Co`));
  assert.ok(detail.notes.startsWith('Called **Alex** twice\nFrom the old notes field\nDuplicate of'), detail.notes);

  assert.equal((await app.inject({ method: 'DELETE', url: `/api/notes/${note.id}` })).statusCode, 204);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/notes/${note.id}` })).statusCode, 404);
  assert.equal((await app.inject(`/api/postings/${id}/notes`)).json().length, 2);
  await app.close();
  store.close();
});
