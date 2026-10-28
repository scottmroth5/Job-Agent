// A job's cover letter, worked on in the job panel: its versions, a back-and-forth revision with Claude (nothing saved
// until the user keeps a draft), saving a version (a Claude revision or the user's own, pasted or from a file), making an
// older version current again, and Word or PDF downloads of any version. Every save is a new artifact, so nothing is
// overwritten, and the newest is the letter the panel, the report, and meeting prep use.
import { createJobTracer } from '../tools/trace.js';
import { OWNER_ID } from '../db/users.js';
import { reviseLetter, MAX_TURNS } from '../agents/hunt/revise-letter.js';
import { finishLetter, HUNT_MODEL } from '../agents/hunt/generate.js';
import { letterDocName, letterHtml, stripSalutationAndSignoff } from '../agents/hunt/letters.js';
import { pickResume, withResume } from '../agents/resumes.js';
import { ensureLetterFolder } from '../tools/google/drive.js';
import { documentText, MAX_DOC_BYTES } from '../tools/doc-text.js';
import { letterPdf } from '../tools/pdf-writer.js';
import { localDay } from '../tools/dates.js';
import { uploadName } from './account-routes.js';
import { letterDocx, docxName } from './word-docs.js';

export const REVISIONS_PER_DAY = 40;
const anyObject = { type: 'object', additionalProperties: true };
const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'integer', minimum: 1 } } };
const SOURCES = { v2: 'Written by Job Hunt', 'v2-revision': 'Revised with Claude', user: 'Your version', v1: 'From the old spreadsheet' };
const longDate = (d) => d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
const MAX_LETTER_CHARS = 8000;

export function registerLetterRoutes(app, { store, config, services }) {
  const { db } = store;
  const revisions = new Map(); // uid -> timestamps in the last day
  const job = (id) => db.prepare('SELECT * FROM postings WHERE id = ? AND user_id = @uid').get(id);
  const versions = (postingId) =>
    db
      .prepare(`SELECT a.id, a.content, a.source, a.flags_json, a.doc_url, a.created_at, r.label AS resume FROM artifacts a
          LEFT JOIN resumes r ON r.id = a.resume_id AND r.user_id = a.user_id
          WHERE a.posting_id = ? AND a.user_id = @uid AND a.kind = 'cover_letter' ORDER BY a.id DESC`)
      .all(postingId)
      .map((v, i, all) => ({
        id: v.id,
        number: all.length - i,
        current: i === 0,
        source: v.source,
        how: SOURCES[v.source] ?? 'Saved',
        createdAt: v.created_at,
        flags: v.flags_json ? JSON.parse(v.flags_json) : [],
        docUrl: v.doc_url,
        resume: v.resume,
        content: v.content,
      }));
  const latestAnalysis = (postingId) => {
    const a = db.prepare("SELECT analysis_json FROM scores WHERE posting_id = ? AND user_id = @uid AND source IN ('v2', 'v2-rule') ORDER BY id DESC LIMIT 1").pluck().get(postingId);
    return a ? JSON.parse(a) : null;
  };

  // A new version: the job's row supplies user_id, so another user's job gets nothing. The owner's letters also get a
  // Google Doc, as the pipeline's do; a Doc failure keeps the version and says so.
  const saveVersion = async (posting, { content, source, flags, model = null, resumeId = null }) => {
    const now = new Date();
    const id = Number(
      db
        .prepare(`INSERT INTO artifacts (user_id, posting_id, kind, content, flags_json, source, model, prompt_version, created_at, resume_id)
            SELECT user_id, id, 'cover_letter', ?, ?, ?, ?, NULL, ?, ? FROM postings WHERE id = ? AND user_id = @uid`)
        .run(content, flags.length ? JSON.stringify(flags) : null, source, model, now.toISOString(), resumeId, posting.id).lastInsertRowid,
    );
    let docError = null;
    const drive = services.drive;
    if (drive) {
      try {
        const folderId = await ensureLetterFolder(drive, db);
        const name = letterDocName(posting.company, posting.title, localDay(now));
        const doc = await drive.createDocFromHtml({ name, folderId, html: letterHtml({ candidate: config.candidate, company: posting.company, title: posting.title, date: longDate(now), body: content }) });
        db.prepare('UPDATE artifacts SET doc_id = ?, doc_url = ?, doc_name = ? WHERE id = ? AND user_id = @uid').run(doc.id, doc.url, name, id);
      } catch {
        docError = 'Saved here; the Google Doc could not be made.';
      }
    }
    return { id, docError };
  };

  app.get('/api/postings/:id/letters', { schema: { summary: "A job's cover letter versions, newest (current) first", params: idParams, response: { 200: { type: 'array', items: anyObject } } } }, async (req, reply) =>
    job(req.params.id) ? versions(req.params.id) : reply.code(404).send({ error: 'Job not found' }),
  );

  app.post(
    '/api/postings/:id/letter/revise',
    {
      schema: {
        summary: 'Ask Claude to revise the letter draft (nothing is saved): returns the revised letter and what changed',
        params: idParams,
        body: {
          type: 'object',
          required: ['letter', 'feedback'],
          additionalProperties: false,
          properties: {
            letter: { type: 'string', maxLength: MAX_LETTER_CHARS },
            feedback: { type: 'string', minLength: 3, maxLength: 2000 },
            history: {
              type: 'array',
              maxItems: MAX_TURNS,
              items: { type: 'object', required: ['feedback', 'changes'], additionalProperties: false, properties: { feedback: { type: 'string', maxLength: 2000 }, changes: { type: 'string', maxLength: 1000 } } },
            },
          },
        },
        response: { 200: anyObject },
      },
    },
    async (req, reply) => {
      if (!services.claude) return reply.code(503).send({ error: 'AI is not available here.' });
      const posting = job(req.params.id);
      if (!posting) return reply.code(404).send({ error: 'Job not found' });
      const uid = req.uid ?? OWNER_ID;
      const day = Date.now() - 24 * 3600 * 1000;
      const recent = (revisions.get(uid) ?? []).filter((t) => t > day);
      if (recent.length >= REVISIONS_PER_DAY) return reply.code(429).send({ error: 'That is a lot of revisions for one day. Save the version you like, or try again tomorrow.' });
      revisions.set(uid, [...recent, Date.now()]);
      const resume = pickResume(db, posting.title);
      const background = withResume(await services.knowledge(), resume);
      const run = createJobTracer({ store, logger: { info() {}, warn() {}, error() {}, log() {} } }).startRun('letter-revise', { posting: posting.id });
      try {
        const r = await reviseLetter({ claude: services.claude, background, posting, analysis: latestAnalysis(posting.id), letter: req.body.letter, feedback: req.body.feedback, history: req.body.history ?? [], config, trace: run });
        run.finish('ok', { flags: r.flags.length });
        return { ...r, resume: resume?.label ?? null };
      } catch (err) {
        run.finish('failed', { error: err.name });
        throw err;
      }
    },
  );

  app.post(
    '/api/postings/:id/letter',
    {
      schema: {
        summary: 'Save a cover letter version: a Claude revision you kept, or your own text; it becomes the current letter',
        params: idParams,
        body: { type: 'object', required: ['content', 'source'], additionalProperties: false, properties: { content: { type: 'string', minLength: 1, maxLength: MAX_LETTER_CHARS }, source: { type: 'string', enum: ['revision', 'user'] } } },
        response: { 200: anyObject },
      },
    },
    async (req, reply) => {
      const posting = job(req.params.id);
      if (!posting) return reply.code(404).send({ error: 'Job not found' });
      // Your own text keeps its wording; only a greeting or sign-off is taken off, since the layout adds those. A kept
      // revision was already cleaned. Both get the letter checks.
      const names = [config.candidate?.name, config.candidate?.signoffName];
      const content = (req.body.source === 'user' ? stripSalutationAndSignoff(req.body.content, names) : req.body.content).trim();
      if (content.length < 100) return reply.code(400).send({ error: 'That is too short for a cover letter.' });
      const flags = finishLetter(content, config).flags;
      const resume = pickResume(db, posting.title);
      const saved = await saveVersion(posting, { content, flags, source: req.body.source === 'revision' ? 'v2-revision' : 'user', model: req.body.source === 'revision' ? HUNT_MODEL : null, resumeId: resume?.id ?? null });
      return { versions: versions(posting.id), docError: saved.docError };
    },
  );

  app.post(
    '/api/postings/:id/letter/restore',
    {
      schema: { summary: 'Make an earlier cover letter version current again (saved as a new version)', params: idParams, body: { type: 'object', required: ['versionId'], additionalProperties: false, properties: { versionId: { type: 'integer', minimum: 1 } } }, response: { 200: anyObject } },
    },
    async (req, reply) => {
      const posting = job(req.params.id);
      const old = posting && db.prepare("SELECT content, source, flags_json, resume_id FROM artifacts WHERE id = ? AND posting_id = ? AND user_id = @uid AND kind = 'cover_letter'").get(req.body.versionId, posting.id);
      if (!old) return reply.code(404).send({ error: 'Version not found' });
      const saved = await saveVersion(posting, { content: old.content, source: old.source, flags: old.flags_json ? JSON.parse(old.flags_json) : [], resumeId: old.resume_id });
      return { versions: versions(posting.id), docError: saved.docError };
    },
  );

  app.post(
    '/api/postings/:id/letter/from-file',
    { bodyLimit: MAX_DOC_BYTES, schema: { summary: "A file's text for your own letter version (the raw file as the body, its name in X-Filename); nothing is saved", params: idParams, response: { 200: anyObject } } },
    async (req, reply) => {
      if (!job(req.params.id)) return reply.code(404).send({ error: 'Job not found' });
      if (!Buffer.isBuffer(req.body)) return reply.code(400).send({ error: 'Send the file as the request body (application/octet-stream).' });
      const { text } = await documentText(req.body, uploadName(req));
      return { text: text.slice(0, MAX_LETTER_CHARS) };
    },
  );

  // Word or PDF of the current letter, or of any version (?version=<id>), in the Google Doc's layout.
  const download = (format) => async (req, reply) => {
    const posting = job(req.params.id);
    const version = req.query.version
      ? posting && db.prepare("SELECT content, created_at FROM artifacts WHERE id = ? AND posting_id = ? AND user_id = @uid AND kind = 'cover_letter'").get(req.query.version, posting.id)
      : posting && db.prepare("SELECT content, created_at FROM artifacts WHERE posting_id = ? AND user_id = @uid AND kind = 'cover_letter' ORDER BY id DESC LIMIT 1").get(posting.id);
    if (!version?.content) return reply.code(404).send({ error: 'No cover letter for this job yet.' });
    const written = new Date(version.created_at);
    const letter = { candidate: config.candidate, company: posting.company, title: posting.title, date: longDate(written), body: version.content };
    const name = letterDocName(posting.company, posting.title, localDay(written));
    const [type, body, file] =
      format === 'pdf'
        ? ['application/pdf', letterPdf(letter), `${docxName(name).replace(/\.docx$/, '')}.pdf`]
        : ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', await letterDocx(letter), docxName(name)];
    return reply.header('Content-Type', type).header('Content-Disposition', `attachment; filename="${file}"`).header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-store').send(body);
  };
  const versionQuery = { type: 'object', properties: { version: { type: 'integer', minimum: 1 } } };
  app.get('/api/postings/:id/letter.pdf', { schema: { summary: "The job's cover letter (current, or ?version=) as a PDF", params: idParams, querystring: versionQuery } }, download('pdf'));
  app.get('/api/postings/:id/letter.docx', { schema: { summary: "The job's cover letter (current, or ?version=) as a Word document", params: idParams, querystring: versionQuery } }, download('docx'));
  return { download };
}
