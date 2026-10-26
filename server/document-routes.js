// Word downloads of a job's cover letter and of a meeting prep (server/word-docs.js), for whoever's job it is. Users
// without Google Docs send their letters from these; the owner can download them too.
import { letterDocx, prepDocx, docxName } from './word-docs.js';
import { letterDocName } from '../agents/hunt/letters.js';
import { prepDocName } from '../agents/hunt/prep.js';
import { localDay } from '../tools/dates.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const longDate = (d) => d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

export function registerDocumentRoutes(app, { db, config }) {
  const send = (reply, name, buffer) =>
    reply.header('Content-Type', DOCX).header('Content-Disposition', `attachment; filename="${docxName(name)}"`).header('Cache-Control', 'no-store').send(buffer);

  app.get(
    '/api/postings/:id/letter.docx',
    { schema: { summary: "The job's latest cover letter as a Word document", params: { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } } } },
    async (req, reply) => {
      const posting = db.prepare('SELECT id, company, title FROM postings WHERE id = ? AND user_id = @uid').get(req.params.id);
      const letter = posting
        ? db.prepare("SELECT content, created_at FROM artifacts WHERE posting_id = ? AND user_id = @uid AND kind = 'cover_letter' ORDER BY id DESC LIMIT 1").get(posting.id)
        : null;
      if (!letter?.content) return reply.code(404).send({ error: 'No cover letter for this job yet.' });
      const written = new Date(letter.created_at);
      const buffer = await letterDocx({ candidate: config.candidate, company: posting.company, title: posting.title, date: longDate(written), body: letter.content });
      return send(reply, letterDocName(posting.company, posting.title, localDay(written)), buffer);
    },
  );

  app.get(
    '/api/meeting-preps/:id/docx',
    { schema: { summary: 'A meeting prep as a Word document', params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 64 } } } } },
    async (req, reply) => {
      const prep = db.prepare('SELECT m.content, m.attendees_json, m.meeting_at, m.created_at, p.company FROM meeting_preps m JOIN postings p ON p.id = m.posting_id AND p.user_id = m.user_id WHERE m.id = ? AND m.user_id = @uid').get(req.params.id);
      if (!prep) return reply.code(404).send({ error: 'Meeting prep not found.' });
      let attendees = [];
      try {
        attendees = JSON.parse(prep.attendees_json);
      } catch {
        attendees = [];
      }
      const buffer = await prepDocx(prep.content);
      return send(reply, prepDocName(prep.company, attendees, localDay(new Date(prep.meeting_at ?? prep.created_at))), buffer);
    },
  );
}
