// Word downloads of a meeting prep (server/word-docs.ts), for whoever's job it is. A cover letter's Word and PDF
// downloads are in server/letter-routes.ts, with its versions.
import { prepDocx, docxName } from './word-docs.ts';
import { prepDocName } from '../agents/hunt/prep.ts';
import { letterHeader } from '../agents/letter-header.ts';
import type { Db } from '../tools/types.ts';
import type { UserConfig } from '../agents/user-config.ts';
import type { App, FastifyReply } from './types.ts';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function registerDocumentRoutes(app: App, { db, config }: { db: Db; config: UserConfig }) {
  const send = (reply: FastifyReply, name: string, buffer: Buffer) =>
    reply.header('Content-Type', DOCX).header('Content-Disposition', `attachment; filename="${docxName(name)}"`).header('Cache-Control', 'no-store').send(buffer);

  app.get<{ Params: { id: string } }>(
    '/api/meeting-preps/:id/docx',
    { schema: { summary: 'A meeting prep as a Word document', params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 64 } } } } },
    async (req, reply) => {
      const prep = await db.prepare('SELECT m.content, m.attendees_json, m.meeting_at, m.created_at, p.company FROM meeting_preps m JOIN postings p ON p.id = m.posting_id AND p.user_id = m.user_id WHERE m.id = ? AND m.user_id = @uid').get(req.params.id) as { content: string; attendees_json: string; meeting_at: string | null; created_at: string; company: string } | undefined;
      if (!prep) return reply.code(404).send({ error: 'Meeting prep not found.' });
      let attendees: Array<{ name: string }> = [];
      try {
        attendees = JSON.parse(prep.attendees_json);
      } catch {
        attendees = [];
      }
      const buffer = await prepDocx(prep.content);
      return send(reply, prepDocName((await letterHeader(db, config)).name, prep.company, attendees), buffer);
    },
  );
}
