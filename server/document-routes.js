// Word downloads of a meeting prep (server/word-docs.js), for whoever's job it is. A cover letter's Word and PDF
// downloads are in server/letter-routes.js, with its versions.
import { prepDocx, docxName } from './word-docs.js';
import { prepDocName } from '../agents/hunt/prep.js';
import { localDay } from '../tools/dates.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function registerDocumentRoutes(app, { db, config }) {
  const send = (reply, name, buffer) =>
    reply.header('Content-Type', DOCX).header('Content-Disposition', `attachment; filename="${docxName(name)}"`).header('Cache-Control', 'no-store').send(buffer);

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
