// Settings (multi-user, phase 2): the signed-in user's account and their own Claude key. The key is checked with
// Anthropic's free model list, then sealed (tools/secret-box.js, bound to the user's id) before it is stored; it is never
// returned, logged, or shown to anyone, only whether one is set. The owner's AI uses ANTHROPIC_API_KEY instead.
import { budgetStatus } from '../agents/budget.js';
import { getUser, OWNER_ID, setClaudeKey } from '../db/users.js';
import { boxKey, seal } from '../tools/secret-box.js';
import { cleanConfig, MAX_PROFILE_CHARS, MIN_PROFILE_CHARS, PROFILE_SOURCES, profileVersions, saveUserConfig, saveUserProfile, scheduledForUser, setScheduledForUser, userConfig, userProfile } from '../agents/user-config.js';
import { docxName, prepDocx } from './word-docs.js';
import { fileTitle } from '../tools/text.js';
import { validateConfig } from '../tools/config.js';
import { deleteAccount, exportAccount } from '../agents/account-data.js';
import { ATTACHMENTS_DIR } from './attachments.js';
import { isTimeZone, localDay } from '../tools/dates.js';
import { DEMO_ABOUT_YOU, DEMO_CONFIG } from '../demo/sample-data.js';
import { documentText, MAX_DOC_BYTES } from '../tools/doc-text.js';
import { KNOWLEDGE_SECTIONS, knowledgeTemplate } from '../agents/knowledge-sections.js';

// What Settings needs to guide a knowledge doc: the sections (for its checklist) and a blank template.
const KNOWLEDGE_GUIDE = { knowledgeSections: KNOWLEDGE_SECTIONS, knowledgeTemplate: knowledgeTemplate() };

/** An upload's file name from X-Filename (URI-encoded by the page), for its type check only; never used as a path. */
export function uploadName(req) {
  const raw = String(req.headers['x-filename'] ?? '');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

const anyObject = { type: 'object', additionalProperties: true };
// Anthropic API keys: "sk-ant-" then letters, digits, dashes, and underscores.
const KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]{20,200}$/;

function account(db, uid) {
  const u = getUser(db, uid);
  const budget = budgetStatus(db, { uid });
  return {
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status,
    // A user who paused themselves can resume themselves; the owner's pause is the owner's to lift.
    // Calendar days follow their own zone; null means the app's (the owner always uses the app's).
    timeZone: uid === OWNER_ID ? null : (db.prepare('SELECT time_zone FROM users WHERE id = ?').pluck().get(uid) ?? null),
    appTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    pausedBySelf: u.status === 'paused' && db.prepare('SELECT decided_by FROM users WHERE id = ?').pluck().get(uid) === uid,
    owner: uid === OWNER_ID,
    // Where AI calls are paid from: 'env' (the owner's ANTHROPIC_API_KEY), 'owner' (the owner's key, with a cap), 'own'.
    ai: { paidBy: uid === OWNER_ID ? 'env' : u.ai_source, keySet: u.has_key, budget },
  };
}

/**
 * @param {object} o
 * @param {(apiKey: string) => Promise<boolean>} [o.checkKey]  tools/claude.js claudeKeyWorks (tests pass a fake)
 */
export function registerAccountRoutes(app, { db, checkKey, notices = {}, attachmentsDir = ATTACHMENTS_DIR, demo = false }) {
  // Phase 6: take your data with you, pause yourself, or delete your account. Deleting needs your address typed.
  app.get('/api/account/export', { schema: { summary: 'Download everything that is yours, as JSON', response: { 200: anyObject } } }, async (req, reply) =>
    reply
      .header('Content-Disposition', `attachment; filename="job-hunt-export-${localDay()}.json"`)
      .header('Cache-Control', 'no-store')
      .send(exportAccount(db, req.uid ?? OWNER_ID)),
  );
  app.post(
    '/api/account/delete',
    {
      schema: {
        summary: 'Delete your account and everything in it (type your address to confirm)',
        body: { type: 'object', required: ['confirmEmail'], additionalProperties: false, properties: { confirmEmail: { type: 'string' } } },
        response: { 200: anyObject },
      },
    },
    async (req) => {
      const uid = req.uid ?? OWNER_ID;
      if (uid === OWNER_ID) throw Object.assign(new Error("The owner's account cannot be deleted."), { statusCode: 400 });
      const user = getUser(db, uid);
      if (req.body.confirmEmail.trim().toLowerCase() !== user.email) throw Object.assign(new Error(`Type ${user.email} to confirm.`), { statusCode: 400 });
      const counts = deleteAccount(db, uid, { attachmentsDir });
      await notices.accountDeleted?.(user, { byOwner: false });
      return { deleted: true, jobs: counts.postings ?? 0 };
    },
  );
  app.put(
    '/api/account/timezone',
    {
      schema: {
        summary: 'Set the time zone your calendar days follow (null for the app zone)',
        body: { type: 'object', required: ['timeZone'], additionalProperties: false, properties: { timeZone: { type: ['string', 'null'], maxLength: 64 } } },
        response: { 200: anyObject },
      },
    },
    async (req) => {
      const uid = req.uid ?? OWNER_ID;
      if (uid === OWNER_ID) throw Object.assign(new Error('Your time zone is TZ in the server settings.'), { statusCode: 400 });
      const zone = req.body.timeZone;
      if (zone !== null && !isTimeZone(zone)) throw Object.assign(new Error('That is not a time zone this server knows.'), { statusCode: 400 });
      db.prepare('UPDATE users SET time_zone = ?, updated_at = ? WHERE id = ?').run(zone, new Date().toISOString(), uid);
      return account(db, uid);
    },
  );
  app.post('/api/account/pause', { schema: { summary: 'Pause your own account (you can resume it yourself)', response: { 200: anyObject } } }, async (req) => {
    const uid = req.uid ?? OWNER_ID;
    if (uid === OWNER_ID) throw Object.assign(new Error('The owner cannot be paused.'), { statusCode: 400 });
    db.prepare("UPDATE users SET status = 'paused', decided_at = ?, decided_by = ?, updated_at = ? WHERE id = ? AND status = 'active'").run(new Date().toISOString(), uid, new Date().toISOString(), uid);
    return account(db, uid);
  });
  app.post('/api/account/resume', { schema: { summary: 'Resume your account, when you paused it yourself', response: { 200: anyObject } } }, async (req) => {
    const uid = req.uid ?? OWNER_ID;
    const row = db.prepare('SELECT status, decided_by FROM users WHERE id = ?').get(uid);
    if (row?.status !== 'paused') throw Object.assign(new Error('Your account is not paused.'), { statusCode: 400 });
    if (row.decided_by !== uid) throw Object.assign(new Error('The owner paused your account, so only they can resume it.'), { statusCode: 403 });
    db.prepare("UPDATE users SET status = 'active', decided_at = ?, updated_at = ? WHERE id = ?").run(new Date().toISOString(), new Date().toISOString(), uid);
    return account(db, uid);
  });

  app.get('/api/account', { schema: { summary: 'Your account: who you are and how your AI is paid for', response: { 200: anyObject } } }, async (req) =>
    account(db, req.uid ?? OWNER_ID),
  );

  app.put(
    '/api/account/claude-key',
    {
      schema: {
        summary: 'Save your own Claude API key (checked with Anthropic, then stored encrypted)',
        body: { type: 'object', required: ['key'], additionalProperties: false, properties: { key: { type: 'string' } } },
        response: { 200: anyObject },
      },
    },
    async (req) => {
      const uid = req.uid ?? OWNER_ID;
      if (uid === OWNER_ID) throw Object.assign(new Error('Your AI uses ANTHROPIC_API_KEY in the server settings.'), { statusCode: 400 });
      const apiKey = req.body.key.trim();
      if (!KEY_PATTERN.test(apiKey)) throw Object.assign(new Error('That does not look like an Anthropic API key (it starts with sk-ant-).'), { statusCode: 400 });
      let key;
      try {
        key = boxKey();
      } catch {
        throw Object.assign(new Error('The server is not set up to store keys yet. Ask the owner.'), { statusCode: 503 });
      }
      let works = false;
      try {
        works = await checkKey(apiKey);
      } catch {
        throw Object.assign(new Error('Could not reach Anthropic to check the key. Try again shortly.'), { statusCode: 502 });
      }
      if (!works) throw Object.assign(new Error('Anthropic did not accept this key.'), { statusCode: 400 });
      setClaudeKey(db, uid, seal(apiKey, uid, key));
      return account(db, uid);
    },
  );

  // Phase 3: each user's own search settings, background, and schedule. The owner's live in their settings file and
  // Google Doc, so these answer the owner with where to change them instead.
  // The demo shows the sample candidate's About you and search (demo/sample-data.js), read-only, so visitors see what
  // scoring works from; nothing is read from or saved to the database.
  const search = (uid) => {
    if (demo) {
      const config = cleanConfig(DEMO_CONFIG, DEMO_CONFIG.candidate.name);
      return { owner: false, demo: true, config, problems: validateConfig(config), profile: DEMO_ABOUT_YOU, profileChars: { min: MIN_PROFILE_CHARS, max: MAX_PROFILE_CHARS }, ...KNOWLEDGE_GUIDE, scheduled: false };
    }
    if (uid === OWNER_ID) {
      // The owner's search settings stay in their settings file; their knowledge doc lives here, like everyone's.
      return { owner: true, profile: userProfile(db, uid), profileChars: { min: MIN_PROFILE_CHARS, max: MAX_PROFILE_CHARS }, ...KNOWLEDGE_GUIDE };
    }
    const u = getUser(db, uid);
    const config = userConfig(db, uid, u.name);
    const profile = userProfile(db, uid);
    return {
      owner: false,
      config,
      problems: validateConfig(config),
      profile,
      profileChars: { min: MIN_PROFILE_CHARS, max: MAX_PROFILE_CHARS }, ...KNOWLEDGE_GUIDE,
      scheduled: scheduledForUser(db, uid),
    };
  };
  app.get('/api/account/search', { schema: { summary: 'Your search settings, background, and schedule choice', response: { 200: anyObject } } }, async (req) => search(req.uid ?? OWNER_ID));
  app.put(
    '/api/account/search',
    {
      schema: {
        summary: 'Save your search settings (plain text fields only)',
        body: { type: 'object', additionalProperties: false, properties: { candidate: anyObject, search: anyObject, fractional: anyObject } },
        response: { 200: anyObject },
      },
    },
    async (req) => {
      const uid = req.uid ?? OWNER_ID;
      saveUserConfig(db, uid, req.body, getUser(db, uid)?.name ?? '');
      return search(uid);
    },
  );
  app.put(
    '/api/account/profile',
    {
      schema: {
        summary: 'Save your background: the facts about you that scoring and writing use',
        body: { type: 'object', required: ['text'], additionalProperties: false, properties: { text: { type: 'string' }, source: { type: 'string', enum: PROFILE_SOURCES } } },
        response: { 200: anyObject },
      },
    },
    async (req) => {
      const uid = req.uid ?? OWNER_ID;
      saveUserProfile(db, uid, req.body.text, { source: req.body.source });
      return search(uid);
    },
  );

  // Knowledge doc versions (every save keeps the one before) and Word downloads of the current one or any version.
  // The demo has no saved versions; its download is the sample candidate's knowledge doc.
  const versionsOf = (uid) => (demo ? [{ text: DEMO_ABOUT_YOU, savedAt: null, source: 'sample' }] : profileVersions(db, uid));
  const versionParams = { type: 'object', required: ['n'], properties: { n: { type: 'integer', minimum: 1 } } };
  app.get('/api/account/profile/versions', { schema: { summary: 'Your knowledge doc versions, newest (current) first, without their text', response: { 200: { type: 'array', items: anyObject } } } }, async (req) =>
    versionsOf(req.uid ?? OWNER_ID).map((v, i, all) => ({ n: all.length - i, current: i === 0, savedAt: v.savedAt, source: v.source, chars: v.text.length })),
  );
  const versionAt = (uid, n) => {
    const all = versionsOf(uid);
    return all.at(all.length - n) ?? null;
  };
  app.get('/api/account/profile/versions/:n', { schema: { summary: 'One knowledge doc version with its text', params: versionParams, response: { 200: anyObject } } }, async (req, reply) => {
    const v = versionAt(req.uid ?? OWNER_ID, req.params.n);
    return v ? { n: req.params.n, ...v } : reply.code(404).send({ error: 'Version not found' });
  });
  app.post('/api/account/profile/versions/:n/restore', { schema: { summary: 'Make an earlier knowledge doc version current again (saved as a new version)', params: versionParams, response: { 200: anyObject } } }, async (req, reply) => {
    const uid = req.uid ?? OWNER_ID;
    const v = versionAt(uid, req.params.n);
    if (!v) return reply.code(404).send({ error: 'Version not found' });
    saveUserProfile(db, uid, v.text, { source: 'restore' });
    return search(uid);
  });
  app.get(
    '/api/account/profile.docx',
    { schema: { summary: 'Your knowledge doc (current, or ?version=) as a Word document', querystring: { type: 'object', properties: { version: { type: 'integer', minimum: 1 } } } } },
    async (req, reply) => {
      const uid = req.uid ?? OWNER_ID;
      const text = req.query.version ? versionAt(uid, req.query.version)?.text : demo ? DEMO_ABOUT_YOU : userProfile(db, uid);
      if (!text) return reply.code(404).send({ error: 'No knowledge doc yet.' });
      const name = demo ? DEMO_CONFIG.candidate.name : getUser(db, uid)?.name;
      const file = docxName(fileTitle(name, 'Knowledge Doc', req.query.version && `v${req.query.version}`));
      return reply
        .header('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
        .header('Content-Disposition', `attachment; filename="${file}"`)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'no-store')
        .send(await prepDocx(text));
    },
  );
  // A document's text for About you: it fills the box for review and is not saved (Save does that). PDF, .docx, or text.
  app.post(
    '/api/account/profile/from-file',
    {
      bodyLimit: MAX_DOC_BYTES,
      schema: {
        summary: 'Read a document (the raw file as the body, its name in X-Filename) and return its text for About you; nothing is saved',
        response: { 200: anyObject },
      },
    },
    async (req, reply) => {
      if (!Buffer.isBuffer(req.body)) return reply.code(400).send({ error: 'Send the file as the request body (application/octet-stream).' });
      const { kind, text } = await documentText(req.body, uploadName(req));
      return { kind, text: text.slice(0, MAX_PROFILE_CHARS) };
    },
  );

  app.put(
    '/api/account/schedule',
    {
      schema: {
        summary: "Run your pipeline on the app's schedule too",
        body: { type: 'object', required: ['on'], additionalProperties: false, properties: { on: { type: 'boolean' } } },
        response: { 200: anyObject },
      },
    },
    async (req) => {
      const uid = req.uid ?? OWNER_ID;
      if (uid === OWNER_ID) throw Object.assign(new Error('Your schedule is set in the server settings (SCHEDULE_PIPELINE).'), { statusCode: 400 });
      setScheduledForUser(db, uid, req.body.on);
      return search(uid);
    },
  );

  app.delete('/api/account/claude-key', { schema: { summary: 'Remove your saved Claude API key', response: { 200: anyObject } } }, async (req) => {
    const uid = req.uid ?? OWNER_ID;
    setClaudeKey(db, uid, null);
    return account(db, uid);
  });
}
