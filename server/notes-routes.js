// A job's notes, one entry at a time: add, edit, delete (agents/notes.js keeps postings.notes in step).
import { addNote, deleteNote, listNotes, updateNote, MAX_NOTE_CHARS } from '../agents/notes.js';

const anyObject = { type: 'object', additionalProperties: true };
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };
const noteParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-f-]{36}$' } } };
const body = { type: 'object', required: ['body'], additionalProperties: false, properties: { body: { type: 'string', maxLength: MAX_NOTE_CHARS } } };

export function registerNoteRoutes(app, { db }) {
  app.get('/api/postings/:id/notes', { schema: { summary: "A job's notes, newest first", params: idParams, response: { 200: { type: 'array', items: anyObject } } } }, async (req) =>
    listNotes(db, req.params.id),
  );

  app.post('/api/postings/:id/notes', { schema: { summary: 'Add a note to a job (Markdown)', params: idParams, body, response: { 201: anyObject } } }, async (req, reply) => {
    if (!db.prepare('SELECT 1 FROM postings WHERE id = ? AND user_id = @uid').get(req.params.id)) return reply.code(404).send({ error: 'Job not found' });
    return reply.code(201).send(addNote(db, req.params.id, req.body.body, { source: 'user' }));
  });

  app.patch('/api/notes/:id', { schema: { summary: "Edit a note's text (its created date stays)", params: noteParams, body, response: { 200: anyObject } } }, async (req, reply) => {
    const note = updateNote(db, req.params.id, req.body.body);
    return note ?? reply.code(404).send({ error: 'Note not found' });
  });

  app.delete('/api/notes/:id', { schema: { summary: 'Delete a note', params: noteParams } }, async (req, reply) =>
    deleteNote(db, req.params.id) ? reply.code(204).send() : reply.code(404).send({ error: 'Note not found' }),
  );
}
