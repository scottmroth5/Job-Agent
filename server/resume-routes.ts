// Settings > Resumes: upload (the raw file as the body, its name in X-Filename), list, label and match titles, default,
// replace the file, delete, and download your own. Files and text live in the resumes table (agents/resumes.ts); a
// download is always an attachment with nosniff and a sandbox policy, like job attachments.
import { addResume, deleteResume, listResumes, replaceResumeFile, resumeFile, updateResume } from '../agents/resumes.ts';
import { MAX_DOC_BYTES } from '../tools/doc-text.ts';
import { uploadName } from './account-routes.ts';
import { disposition } from './attachments.ts';
import { resumeDocx, resumePdf } from '../tools/resume-format.ts';
import type { Db } from '../tools/types.ts';
import type { App, FastifyReply, FastifyRequest } from './types.ts';

const anyObject = { type: 'object', additionalProperties: true };
const uuidParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-f-]{36}$' } } };
const TYPES: Record<string, string> = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', text: 'text/plain; charset=utf-8' };

export function registerResumeRoutes(app: App, { db }: { db: Db }) {
  const fileBody = (req: FastifyRequest, reply: FastifyReply) => {
    if (Buffer.isBuffer(req.body) && req.body.length) return req.body;
    reply.code(400).send({ error: 'Send the file as the request body (application/octet-stream).' });
    return null;
  };

  app.get('/api/resumes', { schema: { summary: 'Your resumes, default first (without their files or text)', response: { 200: { type: 'array', items: anyObject } } } }, async () => await listResumes(db));

  app.post(
    '/api/resumes',
    {
      bodyLimit: MAX_DOC_BYTES,
      schema: { summary: 'Upload a resume: the raw file (PDF, Word .docx, or text) as the body, its name in X-Filename', response: { 201: anyObject } },
    },
    async (req, reply) => {
      const bytes = fileBody(req, reply);
      if (!bytes) return reply;
      return reply.code(201).send(await addResume(db, { bytes, filename: uploadName(req) }));
    },
  );

  app.patch<{ Params: { id: string }; Body: { label?: string; titles?: string; isDefault?: boolean } }>(
    '/api/resumes/:id',
    {
      schema: {
        summary: "A resume's label, the job titles it is for (comma separated words), and whether it is the default",
        params: uuidParams,
        body: { type: 'object', additionalProperties: false, properties: { label: { type: 'string' }, titles: { type: 'string' }, isDefault: { type: 'boolean' } } },
        response: { 200: anyObject },
      },
    },
    async (req) => await updateResume(db, req.params.id, req.body),
  );

  app.post<{ Params: { id: string } }>(
    '/api/resumes/:id/file',
    { bodyLimit: MAX_DOC_BYTES, schema: { summary: "Replace a resume's file (its label, titles, and default stay)", params: uuidParams, response: { 200: anyObject } } },
    async (req, reply) => {
      const bytes = fileBody(req, reply);
      if (!bytes) return reply;
      return replaceResumeFile(db, req.params.id, { bytes, filename: uploadName(req) });
    },
  );

  app.delete<{ Params: { id: string } }>('/api/resumes/:id', { schema: { summary: 'Delete a resume', params: uuidParams } }, async (req, reply) => {
    await deleteResume(db, req.params.id);
    return reply.code(204).send();
  });

  // format: original (the file as uploaded), text, docx, or pdf (both laid out from its text by tools/resume-format.ts).
  app.get<{ Params: { id: string }; Querystring: { format?: 'original' | 'text' | 'docx' | 'pdf' } }>(
    '/api/resumes/:id/file',
    {
      schema: {
        summary: 'Download your resume: the original file, or its text as plain text, Word, or PDF',
        params: uuidParams,
        querystring: { type: 'object', properties: { format: { type: 'string', enum: ['original', 'text', 'docx', 'pdf'] } } },
      },
    },
    async (req, reply) => {
    const r = await resumeFile(db, req.params.id);
    if (!r) return reply.code(404).send({ error: 'Resume not found.' });
    const format = req.query.format ?? 'original';
    const base = r.filename.replace(/\.[A-Za-z0-9]{1,5}$/, '') || 'resume';
    const out =
      format === 'text' ? { kind: 'text', name: `${base}.txt`, body: Buffer.from(r.text, 'utf8') }
      : format === 'docx' ? { kind: 'docx', name: `${base}.docx`, body: await resumeDocx(r.text) }
      : format === 'pdf' ? { kind: 'pdf', name: `${base}.pdf`, body: resumePdf(r.text) }
      : { kind: r.kind, name: r.filename, body: r.file };
    return reply
      .type(TYPES[out.kind] ?? 'application/octet-stream')
      .header('Content-Disposition', disposition('attachment', out.name))
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "sandbox; default-src 'none'")
      .header('Cache-Control', 'private, no-store')
      .send(out.body);
    },
  );
}
