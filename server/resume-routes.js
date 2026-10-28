// Settings > Resumes: upload (the raw file as the body, its name in X-Filename), list, label and match titles, default,
// replace the file, delete, and download your own. Files and text live in the resumes table (agents/resumes.js); a
// download is always an attachment with nosniff and a sandbox policy, like job attachments.
import { addResume, deleteResume, listResumes, replaceResumeFile, resumeFile, updateResume } from '../agents/resumes.js';
import { MAX_DOC_BYTES } from '../tools/doc-text.js';
import { uploadName } from './account-routes.js';
import { disposition } from './attachments.js';

const anyObject = { type: 'object', additionalProperties: true };
const uuidParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-f-]{36}$' } } };
const TYPES = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', text: 'text/plain; charset=utf-8' };

export function registerResumeRoutes(app, { db }) {
  const fileBody = (req, reply) => {
    if (Buffer.isBuffer(req.body) && req.body.length) return req.body;
    reply.code(400).send({ error: 'Send the file as the request body (application/octet-stream).' });
    return null;
  };

  app.get('/api/resumes', { schema: { summary: 'Your resumes, default first (without their files or text)', response: { 200: { type: 'array', items: anyObject } } } }, async () => listResumes(db));

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

  app.patch(
    '/api/resumes/:id',
    {
      schema: {
        summary: "A resume's label, the job titles it is for (comma separated words), and whether it is the default",
        params: uuidParams,
        body: { type: 'object', additionalProperties: false, properties: { label: { type: 'string' }, titles: { type: 'string' }, isDefault: { type: 'boolean' } } },
        response: { 200: anyObject },
      },
    },
    async (req) => updateResume(db, req.params.id, req.body),
  );

  app.post(
    '/api/resumes/:id/file',
    { bodyLimit: MAX_DOC_BYTES, schema: { summary: "Replace a resume's file (its label, titles, and default stay)", params: uuidParams, response: { 200: anyObject } } },
    async (req, reply) => {
      const bytes = fileBody(req, reply);
      if (!bytes) return reply;
      return replaceResumeFile(db, req.params.id, { bytes, filename: uploadName(req) });
    },
  );

  app.delete('/api/resumes/:id', { schema: { summary: 'Delete a resume', params: uuidParams } }, async (req, reply) => {
    deleteResume(db, req.params.id);
    return reply.code(204).send();
  });

  app.get('/api/resumes/:id/file', { schema: { summary: 'Download your resume file', params: uuidParams } }, async (req, reply) => {
    const r = resumeFile(db, req.params.id);
    if (!r) return reply.code(404).send({ error: 'Resume not found.' });
    return reply
      .type(TYPES[r.kind] ?? 'application/octet-stream')
      .header('Content-Disposition', disposition('attachment', r.filename))
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "sandbox; default-src 'none'")
      .header('Cache-Control', 'private, no-store')
      .send(r.file);
  });
}
