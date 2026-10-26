// Build a draft (Settings > About you): the user's materials in, a draft About you and starting search out, on their own
// AI (agents/draft-profile.js). Nothing is saved: the user reviews the draft and saves what they keep. The files are
// read in memory and dropped; the request body is never logged.
import { draftProfile, MAX_FILE_BYTES, MAX_FILES } from '../agents/draft-profile.js';
import { createJobTracer } from '../tools/trace.js';
import { OWNER_ID } from '../db/users.js';

export const DRAFTS_PER_DAY = 10;
const anyObject = { type: 'object', additionalProperties: true };

export function registerDraftRoutes(app, { store, services }) {
  const drafts = new Map(); // uid -> [timestamps in the last day]
  app.post(
    '/api/account/draft',
    {
      // Base64 files are a third larger than the files themselves.
      bodyLimit: Math.ceil(MAX_FILES * MAX_FILE_BYTES * 1.4) + 200_000,
      schema: {
        summary: 'Draft your About you and a starting search from your resume, LinkedIn profile, and other materials (nothing is saved)',
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            files: { type: 'array', maxItems: MAX_FILES, items: { type: 'object', required: ['name', 'type', 'data'], additionalProperties: false, properties: { name: { type: 'string', maxLength: 200 }, type: { type: 'string', maxLength: 100 }, data: { type: 'string' } } } },
            texts: { type: 'array', maxItems: 6, items: { type: 'object', required: ['text'], additionalProperties: false, properties: { label: { type: 'string', maxLength: 80 }, text: { type: 'string', maxLength: 30000 } } } },
            notes: { type: 'string', maxLength: 4000 },
          },
        },
        response: { 200: anyObject },
      },
    },
    async (req) => {
      if (!services.claude) throw Object.assign(new Error('AI is not available here.'), { statusCode: 503 });
      const uid = req.uid ?? OWNER_ID;
      const day = Date.now() - 24 * 3600 * 1000;
      const recent = (drafts.get(uid) ?? []).filter((t) => t > day);
      if (recent.length >= DRAFTS_PER_DAY) throw Object.assign(new Error('That is a lot of drafts for one day. Edit the last one, or try again tomorrow.'), { statusCode: 429 });
      drafts.set(uid, [...recent, Date.now()]);
      const run = createJobTracer({ store, logger: { info() {}, warn() {}, error() {}, log() {} } }).startRun('draft-profile', { files: req.body.files?.length ?? 0 });
      try {
        const draft = await draftProfile({ claude: services.claude, input: req.body, trace: run });
        run.finish('ok', { questions: draft.questions.length });
        return draft;
      } catch (err) {
        run.finish('failed', { error: err.name });
        throw err;
      }
    },
  );
}
