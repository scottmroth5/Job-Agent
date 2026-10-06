// Files attached to jobs. Uploads arrive as the raw file body (application/octet-stream) with the name in an
// X-Filename header, so no multipart dependency is needed. Each file is stored under its random ID, never its
// name, so a name cannot reach outside the folder. Downloads are sent with nosniff and a sandbox policy; only
// PDFs and images open in the browser, everything else downloads.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { repoPath } from '../tools/paths.js';

export const ATTACHMENTS_DIR = repoPath('data', 'attachments');
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const INLINE_TYPES = /^(application\/pdf|image\/(png|jpeg|gif|webp))$/;
const anyObject = { type: 'object', additionalProperties: true };

/** A display name safe for headers and lists: no paths, no control characters, at most 200 characters. */
export function cleanFilename(name) {
  const base = String(name ?? '')
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f\u007f"]/g, '')
    .trim()
    .slice(0, 200);
  return base && base !== '.' && base !== '..' ? base : 'file';
}

/** A MIME type that looks like one, else application/octet-stream. */
export const cleanType = (t) => (/^[a-z0-9][\w.+-]*\/[\w.+-]+$/i.test(String(t ?? '').trim()) ? String(t).trim().toLowerCase() : 'application/octet-stream');

const toRow = (r) => ({ id: r.id, postingId: r.posting_id, filename: r.filename, contentType: r.content_type, sizeBytes: r.size_bytes, createdAt: r.created_at });

export function listAttachments(db, postingId) {
  return db.prepare('SELECT * FROM attachments WHERE posting_id = ? ORDER BY created_at, id').all(postingId).map(toRow);
}

/** Content-Disposition with an ASCII fallback and the full name in UTF-8 (RFC 6266 / 5987). */
function disposition(kind, filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function registerAttachmentRoutes(app, { db, dir = ATTACHMENTS_DIR, maxBytes = MAX_ATTACHMENT_BYTES }) {
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: maxBytes }, (req, body, done) => done(null, body));
  const fileOf = (a) => join(dir, String(a.posting_id), a.id);
  const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };
  const uuidParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9a-f-]{36}$' } } };

  app.get('/api/postings/:id/attachments', { schema: { summary: "A job's attachments", params: idParams, response: { 200: { type: 'array', items: anyObject } } } }, async (req) =>
    listAttachments(db, req.params.id),
  );

  app.post(
    '/api/postings/:id/attachments',
    {
      bodyLimit: maxBytes,
      schema: {
        summary: 'Attach a file to a job: the raw file as the body (application/octet-stream), its name in X-Filename (URI-encoded), its type in X-File-Type',
        params: idParams,
        response: { 201: anyObject },
      },
    },
    async (req, reply) => {
      const postingId = req.params.id;
      if (!db.prepare('SELECT 1 FROM postings WHERE id = ?').get(postingId)) return reply.code(404).send({ error: 'Job not found' });
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: 'Send the file as the request body (application/octet-stream).' });
      let name;
      try {
        name = decodeURIComponent(String(req.headers['x-filename'] ?? ''));
      } catch {
        name = String(req.headers['x-filename'] ?? '');
      }
      const row = {
        id: randomUUID(),
        posting_id: postingId,
        filename: cleanFilename(name),
        content_type: cleanType(req.headers['x-file-type']),
        size_bytes: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
        created_at: new Date().toISOString(),
      };
      mkdirSync(join(dir, String(postingId)), { recursive: true });
      writeFileSync(fileOf(row), body, { mode: 0o600 });
      try {
        db.prepare(`INSERT INTO attachments (id, posting_id, filename, content_type, size_bytes, sha256, created_at)
          VALUES (@id, @posting_id, @filename, @content_type, @size_bytes, @sha256, @created_at)`).run(row);
      } catch (err) {
        unlinkSync(fileOf(row));
        throw err;
      }
      return reply.code(201).send(toRow(row));
    },
  );

  app.get('/api/attachments/:id/file', { schema: { summary: 'Download an attachment', params: uuidParams } }, async (req, reply) => {
    const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
    if (!a || !existsSync(fileOf(a))) return reply.code(404).send({ error: 'Attachment not found' });
    const inline = INLINE_TYPES.test(a.content_type) && req.query?.download === undefined;
    return reply
      .header('Content-Type', a.content_type)
      .header('Content-Disposition', disposition(inline ? 'inline' : 'attachment', a.filename))
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'")
      .header('Cache-Control', 'private, no-store')
      .send(readFileSync(fileOf(a)));
  });

  app.delete('/api/attachments/:id', { schema: { summary: 'Delete an attachment and its file', params: uuidParams } }, async (req, reply) => {
    const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
    if (!a) return reply.code(404).send({ error: 'Attachment not found' });
    db.prepare('DELETE FROM attachments WHERE id = ?').run(a.id);
    if (existsSync(fileOf(a))) unlinkSync(fileOf(a));
    return reply.code(204).send();
  });
}
