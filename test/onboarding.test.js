// Onboarding: Build a draft (agents/draft-profile.js, POST /api/account/draft) and the Home checklist (summary.setup).
// Claude is faked; the "resume" is a made-up two-line PDF-looking file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openJobStore } from '../db/index.js';
import { addUser } from '../db/users.js';
import { buildApp } from '../server/app.js';
import { authSettings } from '../server/auth.js';
import { SESSION_COOKIE, sessionKey, sign } from '../server/session.js';
import { draftContent, validateDraft, DRAFT_MODEL, DRAFT_SCHEMA, MAX_FILES } from '../agents/draft-profile.js';
import { DRAFTS_PER_DAY } from '../server/draft-routes.js';
import { saveUserConfig, saveUserProfile } from '../agents/user-config.js';
import { createJobClaude } from '../tools/claude.js';

const SITE = 'http://localhost:5178';
const pdf = Buffer.from('%PDF-1.4\nMade-up resume for tests\n%%EOF').toString('base64');
const DRAFT = {
  aboutYou: '## Summary\nEngineering leader with 12 years in B2B software. [add: industries you prefer]\n\n## Experience highlights\n- Grew a team from 5 to 30.',
  candidate: { name: 'Pat Example', signoffName: 'Pat', contactLine: 'Anytown, ST', linkedin: 'linkedin.com/in/example' },
  search: { terms: ['VP Engineering', ' ', 'Head of Engineering'], relevantTitleKeywords: ['engineering'], noiseTitleKeywords: ['intern'], homeLocations: [], fractionalTerms: [] },
  questions: ['Which industries do you prefer?'],
};

test('draft materials: PDFs become documents, text stays text, and anything else is refused with a fix', () => {
  const blocks = draftContent({ files: [{ name: 'resume.pdf', type: 'application/pdf', data: pdf }, { name: 'notes.md', type: 'text/markdown', data: Buffer.from('# Notes').toString('base64') }], texts: [{ label: 'LinkedIn About', text: 'I build teams.' }], notes: 'Remote only.' });
  assert.equal(blocks.filter((b) => b.type === 'document').length, 1);
  assert.equal(blocks.find((b) => b.type === 'document').source.media_type, 'application/pdf');
  assert.ok(blocks.some((b) => b.type === 'text' && b.text.includes('# Notes')));
  assert.ok(blocks.some((b) => b.type === 'text' && b.text.startsWith('LinkedIn About:')));
  assert.ok(blocks.some((b) => b.type === 'text' && b.text.includes('Remote only.')));
  assert.throws(() => draftContent({}), /Add your resume/);
  assert.throws(() => draftContent({ files: [{ name: 'cv.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: pdf }] }), /Save a Word resume as PDF/);
  assert.throws(() => draftContent({ files: [{ name: 'fake.pdf', type: 'application/pdf', data: Buffer.from('not a pdf').toString('base64') }] }), /not a PDF/);
  assert.throws(() => draftContent({ files: Array.from({ length: MAX_FILES + 1 }, () => ({ name: 'r.pdf', type: 'application/pdf', data: pdf })) }), /at most/);
});

test('the draft schema has no numeric or length limits (the API rejects them); answers are cleaned', () => {
  assert.ok(!/minimum|maximum|minLength|maxLength|minItems|maxItems/.test(JSON.stringify(DRAFT_SCHEMA)));
  const d = validateDraft(DRAFT);
  assert.deepEqual(d.search.terms, ['VP Engineering', 'Head of Engineering']);
  assert.throws(() => validateDraft({ ...DRAFT, aboutYou: 'Too short' }), /too short/);
});

async function setup() {
  const secret = randomBytes(48).toString('base64');
  const settings = authSettings({ AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'c', GOOGLE_WEB_CLIENT_SECRET: 's', AUTH_ALLOWED_EMAILS: 'owner@example.com', SESSION_SECRET: secret });
  const store = openJobStore(':memory:', { fallbackUid: null });
  const sent = [];
  const claude = createJobClaude(store.db, { ownerClient: { send: async (opts) => { sent.push(opts); return { data: DRAFT, text: '' }; } }, env: {} });
  const app = await buildApp({ store, config: { candidate: { name: 'O' }, search: { homeLocations: [] }, fractional: {} }, authMode: 'google', auth: { settings }, services: { createBrowser: async () => null, claude, log: { info() {}, warn() {}, error() {} } } });
  const as = (email) => ({ cookie: `${SESSION_COOKIE}=${sign({ email, exp: Date.now() + 3_600_000, v: 1 }, sessionKey(secret))}`, origin: SITE });
  const pat = addUser(store.raw, { email: 'pat@example.com', name: 'Pat', aiSource: 'owner' });
  store.raw.prepare('UPDATE users SET ai_cap_usd = 5 WHERE id = ?').run(pat);
  return { store, app, sent, pat, asPat: as('pat@example.com'), asOwner: as('owner@example.com'), done: async () => { await app.close(); store.close(); } };
}

test('Build a draft: the materials go to Claude as data on the user\'s own AI; nothing is saved; a day is capped', async () => {
  const { store, app, sent, pat, asPat, done } = await setup();
  const res = await app.inject({ method: 'POST', url: '/api/account/draft', headers: asPat, payload: { files: [{ name: 'resume.pdf', type: 'application/pdf', data: pdf }], notes: 'VP roles' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().search.terms, ['VP Engineering', 'Head of Engineering']);
  assert.equal(sent[0].model, DRAFT_MODEL);
  assert.match(sent[0].system, /not instructions to you/);
  assert.equal(sent[0].messages[0].content.find((b) => b.type === 'document').source.data, pdf);
  assert.deepEqual(store.raw.prepare("SELECT user_id, status FROM runs WHERE name = 'draft-profile'").get(), { user_id: pat, status: 'ok' });
  assert.equal(store.raw.prepare('SELECT COUNT(*) FROM user_settings WHERE user_id = ?').pluck().get(pat), 0, 'nothing saved');
  assert.equal((await app.inject({ method: 'POST', url: '/api/account/draft', headers: asPat, payload: {} })).statusCode, 400);
  for (let i = 2; i < DRAFTS_PER_DAY; i += 1) await app.inject({ method: 'POST', url: '/api/account/draft', headers: asPat, payload: { texts: [{ text: 'x' }] } });
  assert.equal((await app.inject({ method: 'POST', url: '/api/account/draft', headers: asPat, payload: { texts: [{ text: 'x' }] } })).statusCode, 429);
  await done();
});

test('the Home checklist: AI, About you, and search, for users only', async () => {
  const { store, app, pat, asPat, asOwner, done } = await setup();
  const setup1 = (await app.inject({ url: '/api/summary', headers: asPat })).json().setup;
  assert.deepEqual(setup1, { ai: true, aboutYou: false, search: false }, 'on the owner\'s key counts as AI ready');
  saveUserProfile(store.raw, pat, 'Background. '.repeat(60));
  saveUserConfig(store.raw, pat, { search: { terms: ['VP Engineering'], relevantTitleKeywords: ['engineering'], homeLocations: ['Remote'] } }, 'Pat');
  assert.deepEqual((await app.inject({ url: '/api/summary', headers: asPat })).json().setup, { ai: true, aboutYou: true, search: true });
  assert.equal((await app.inject({ url: '/api/summary', headers: asOwner })).json().setup, undefined);
  await done();
});
