// Dated note entries. Synthetic jobs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { openJobStore, loadMigrations } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { addNote, adoptNotesText, deleteNote, listNotes, notesForPrompt, updateNote } from '../agents/notes.js';

const config = { candidate: { name: 'Pat Example' }, search: { homeLocations: [] }, fractional: {}, coverLetterChecks: [] };

// Used before 013 (no user_id yet) and after it (the owner's job).
function job(db, notes = null) {
  const owned = Boolean(db.prepare("SELECT 1 FROM pragma_table_info('postings') WHERE name = 'user_id'").get());
  return Number(
    db.prepare(`INSERT INTO postings (${owned ? 'user_id, ' : ''}url_key, company, title, company_title_key, discovered_on, stage, status, notes, created_at, updated_at)
      VALUES (${owned ? '1, ' : ''}?, 'Example Co', 'CTO', ?, '2026-10-01', 'pipeline', 'new', ?, 'x', 'x')`).run(`k${Math.random()}`, `example|cto${Math.random()}`, notes).lastInsertRowid,
  );
}
const cache = (db, id) => db.prepare('SELECT notes FROM postings WHERE id = ?').pluck().get(id);

test('migration: each job with notes text gets one "earlier" note; jobs without notes get none', () => {
  // Apply every migration before 012, add jobs, then 012, as on a real database.
  const all = loadMigrations();
  const raw = new Database(':memory:');
  raw.exec('CREATE TABLE runs (id INTEGER PRIMARY KEY)');
  for (const m of all.filter((m) => m.id < '012')) (typeof m.up === 'string' ? raw.exec(m.up) : m.up(raw));
  const withNotes = job(raw, 'Referred by a friend\nRemoved 2026-10-01: duplicate of #3.');
  const blank = job(raw, '   ');
  const none = job(raw, null);
  all.find((m) => m.id === '012-posting-notes').up(raw);
  // Read straight from the table: 012 ran before user_id existed, so today's (scoped) notes functions do not apply here.
  const notesOf = (id) => raw.prepare('SELECT source, body FROM posting_notes WHERE posting_id = ?').all(id);
  assert.deepEqual(notesOf(withNotes), [{ source: 'earlier', body: 'Referred by a friend\nRemoved 2026-10-01: duplicate of #3.' }]);
  assert.equal(notesOf(blank).length + notesOf(none).length, 0);
  raw.close();
});

test('add, edit, and delete keep their dates and keep postings.notes in step (oldest first)', () => {
  const { db } = openJobStore(':memory:');
  const id = job(db);
  const first = addNote(db, id, '  First call went well  ', { now: new Date('2026-10-10T15:00:00Z') });
  const second = addNote(db, id, 'Second round **Tuesday**', { now: new Date('2026-10-12T15:00:00Z') });
  assert.equal(first.body, 'First call went well', 'trimmed');
  assert.deepEqual(listNotes(db, id).map((n) => n.id), [second.id, first.id], 'newest first');
  assert.equal(cache(db, id), 'First call went well\nSecond round **Tuesday**');

  const edited = updateNote(db, first.id, 'First call went very well', { now: new Date('2026-10-14T09:00:00Z') });
  assert.deepEqual([edited.createdAt, edited.updatedAt], ['2026-10-10T15:00:00.000Z', '2026-10-14T09:00:00.000Z']);
  assert.equal(updateNote(db, first.id, 'First call went very well', { now: new Date('2026-10-20T09:00:00Z') }).updatedAt, '2026-10-14T09:00:00.000Z', 'no change, no new date');
  assert.equal(cache(db, id), 'First call went very well\nSecond round **Tuesday**');

  assert.equal(deleteNote(db, second.id), true);
  assert.equal(cache(db, id), 'First call went very well');
  assert.equal(deleteNote(db, first.id), true);
  assert.equal(cache(db, id), null);
  assert.equal(deleteNote(db, first.id), false);
  assert.equal(updateNote(db, first.id, 'x'), null);
  assert.throws(() => addNote(db, id, '   '), /needs some text/);
});

test('notes written as text before (or by an insert) become an entry before a new one is added', () => {
  const { db } = openJobStore(':memory:');
  const id = job(db, 'Typed long ago');
  addNote(db, id, 'New note', { now: new Date('2026-10-16T12:00:00Z') });
  assert.deepEqual(listNotes(db, id).map((n) => [n.source, n.body]), [['user', 'New note'], ['earlier', 'Typed long ago']]);
  assert.equal(cache(db, id), 'Typed long ago\nNew note');
});

test('for prompts: oldest first with dates, earlier and Job Agent notes labeled', () => {
  const text = notesForPrompt([
    { body: 'Latest', source: 'user', createdAt: '2026-10-15T15:00:00.000Z', updatedAt: '2026-10-16T15:00:00.000Z' },
    { body: 'Archived copy', source: 'agent', createdAt: '2026-10-12T15:00:00.000Z', updatedAt: '2026-10-12T15:00:00.000Z' },
    { body: 'Old', source: 'earlier', createdAt: '2026-10-11T15:00:00.000Z', updatedAt: '2026-10-11T15:00:00.000Z' },
  ]);
  assert.equal(text, [
    'Earlier note (before October 11, 2026):\nOld',
    'Note from October 12, 2026, added by Job Agent:\nArchived copy',
    'Note from October 15, 2026, edited October 16, 2026:\nLatest',
  ].join('\n\n'));
});

test('API: notes on the job, add, edit, delete; PATCH notes and duplicate marking add entries', async () => {
  const store = openJobStore(':memory:');
  const id = job(store.db);
  const other = job(store.db);
  const app = await buildApp({ store, config, services: { createBrowser: async () => null } });

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
  assert.deepEqual(detail.noteEntries.map((n) => n.source), ['agent', 'user', 'user']);
  assert.match(detail.noteEntries[0].body, new RegExp(`^Duplicate of #${other}, CTO at Example Co`));
  assert.ok(detail.notes.startsWith('Called **Alex** twice\nFrom the old notes field\nDuplicate of'), detail.notes);

  assert.equal((await app.inject({ method: 'DELETE', url: `/api/notes/${note.id}` })).statusCode, 204);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/notes/${note.id}` })).statusCode, 404);
  assert.equal((await app.inject(`/api/postings/${id}/notes`)).json().length, 2);
  await app.close();
  store.close();
});
