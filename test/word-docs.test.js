// Word downloads of cover letters and meeting preps (server/word-docs.js, server/document-routes.js). Made-up jobs and
// text; the .docx files are opened and their text checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import JSZip from 'jszip';
import { openJobStore } from '../db/index.js';
import { addUser, OWNER_ID } from '../db/users.js';
import { buildApp } from '../server/app.js';
import { authSettings } from '../server/auth.js';
import { SESSION_COOKIE, sessionKey, sign } from '../server/session.js';
import { letterDocx, prepDocx, docxName } from '../server/word-docs.js';

const SITE = 'http://localhost:5178';
const documentXml = async (buffer) => (await JSZip.loadAsync(buffer)).file('word/document.xml').async('string');
const textOf = (xml) => [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(' ');

test('the letter has the Google Doc layout; text stays text', async () => {
  const buffer = await letterDocx({ candidate: { name: 'Pat Example', signoffName: 'Pat', contactLine: 'Anytown, ST', linkedin: '' }, company: 'Example Co', title: 'VP Engineering', date: 'October 26, 2026', body: 'First paragraph <b>not bold</b>.\n\nSecond\nparagraph.' });
  assert.equal(buffer.subarray(0, 2).toString(), 'PK', 'a zip, as .docx files are');
  const text = textOf(await documentXml(buffer));
  for (const s of ['Pat Example', 'Anytown, ST', 'October 26, 2026', 'Re: VP Engineering at Example Co', 'Dear Example Co Hiring Team,', 'Second paragraph.', 'Sincerely,', 'Pat']) assert.ok(text.includes(s), s);
  assert.ok(text.includes('&lt;b&gt;not bold&lt;/b&gt;'), 'markup is escaped as text');
  assert.equal(docxName('Example Co/VP:Engineering "Lead"'), 'Example Co VP Engineering Lead.docx');
  assert.equal(docxName(''), 'Document.docx');
});

test('the prep keeps headings, bullets, and bold', async () => {
  const xml = await documentXml(await prepDocx('# Prep for Example Co\n\n## Who\n- **Sam**, hiring manager\n  - joined 2024\n\nPlain line.'));
  assert.match(xml, /Heading1/);
  assert.match(xml, /<w:b\/>/);
  assert.match(xml, /<w:numPr>|w:ilvl/);
  for (const s of ['Prep for Example Co', 'Sam', 'hiring manager', 'joined 2024', 'Plain line.']) assert.ok(textOf(xml).includes(s), s);
});

test('downloads: your own letter and prep; nobody else\'s', async () => {
  const secret = randomBytes(48).toString('base64');
  const settings = authSettings({ AUTH_MODE: 'google', PUBLIC_URL: SITE, GOOGLE_WEB_CLIENT_ID: 'c', GOOGLE_WEB_CLIENT_SECRET: 's', AUTH_ALLOWED_EMAILS: 'owner@example.com', SESSION_SECRET: secret });
  const store = openJobStore(':memory:', { fallbackUid: null });
  const app = await buildApp({ store, config: { candidate: { name: 'Owner Example', signoffName: 'Owner' }, search: { homeLocations: [] }, fractional: {} }, authMode: 'google', auth: { settings }, services: { createBrowser: async () => null, log: { info() {}, warn() {}, error() {} } } });
  const as = (email) => ({ cookie: `${SESSION_COOKIE}=${sign({ email, exp: Date.now() + 3_600_000, v: 1 }, sessionKey(secret))}` });
  addUser(store.raw, { email: 'b@example.com' });
  const job = Number(store.raw.prepare("INSERT INTO postings (user_id, url_key, company, title, company_title_key, discovered_on, created_at, updated_at) VALUES (?, 'k', 'Example Co', 'VP Engineering', 'k', '2026-10-01', 'x', 'x')").run(OWNER_ID).lastInsertRowid);
  store.raw.prepare("INSERT INTO artifacts (user_id, posting_id, kind, content, source, created_at) VALUES (?, ?, 'cover_letter', 'The letter body.', 'v2', '2026-10-26T15:00:00Z')").run(OWNER_ID, job);
  store.raw.prepare("INSERT INTO meeting_preps (user_id, id, posting_id, attendees_json, content, model, created_at) VALUES (?, 'p1', ?, '[{\"name\":\"Sam\"}]', '# Prep', 'm', 'x')").run(OWNER_ID, job);

  const letter = await app.inject({ url: `/api/postings/${job}/letter.docx`, headers: as('owner@example.com') });
  assert.equal(letter.statusCode, 200);
  assert.match(letter.headers['content-type'], /wordprocessingml/);
  assert.match(letter.headers['content-disposition'], /^attachment; filename="Owner Example VP Engineering at Example Co Cover Letter\.docx"$/);
  assert.ok(textOf(await documentXml(letter.rawPayload)).includes('Owner Example'), "the owner's own name, from their settings");
  assert.equal((await app.inject({ url: '/api/meeting-preps/p1/docx', headers: as('owner@example.com') })).statusCode, 200);

  assert.equal((await app.inject({ url: `/api/postings/${job}/letter.docx`, headers: as('b@example.com') })).statusCode, 404, "another user's letter");
  assert.equal((await app.inject({ url: '/api/meeting-preps/p1/docx', headers: as('b@example.com') })).statusCode, 404, "another user's prep");
  await app.close();
  store.close();
});
