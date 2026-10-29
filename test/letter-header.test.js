// Cover letter documents: no emoji or pictographs anywhere (Word shows a picture, a PDF a "?"), and the header's email,
// LinkedIn, website, and GitHub as clickable links in Word, PDF, and the Google Doc. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { withoutPictographs } from '../tools/text.js';
import { fromCandidate, headerLines, hrefOf } from '../tools/letter-header.js';
import { openJobStore } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { addUser } from '../db/users.js';
import { runAsUser } from '../db/scope.js';
import { letterHeader, saveLetterHeader } from '../agents/letter-header.js';
import { documentText } from '../tools/doc-text.js';
import { letterPdf, winAnsi } from '../tools/pdf-writer.js';
import { letterDocx } from '../server/word-docs.js';
import { letterHtml } from '../agents/hunt/letters.js';
import { validateConfig } from '../tools/config.js';

const candidate = { name: 'Pat Example', signoffName: 'Pat', contactLine: 'pat@example.com | 555-0100', linkedin: 'https://www.linkedin.com/in/example/', website: 'https://example.com/', github: 'github.com/example' };
const letter = { candidate, company: 'Example Co', title: '🧪 Vice President, Engineering 🚀', date: 'October 29, 2026', body: 'First paragraph ✨ here.\n\nSecond paragraph.' };

test('pictographs come out; accents, curly quotes, and dashes stay', () => {
  assert.equal(withoutPictographs('🧪 Vice President, Engineering'), 'Vice President, Engineering');
  assert.equal(withoutPictographs('Lead 👩‍💻 the team 🇺🇸 now 1️⃣'), 'Lead the team now 1');
  assert.equal(withoutPictographs('Café “quoted” — José'), 'Café “quoted” — José');
  assert.equal(withoutPictographs(null), null);
  assert.equal(winAnsi('🧪 VP'), 'VP', 'the PDF encoder drops them instead of printing "?"');
});

test('header parts: an email links as mailto, web addresses as https, the rest is text', () => {
  assert.equal(hrefOf('pat@example.com'), 'mailto:pat@example.com');
  assert.equal(hrefOf('github.com/example'), 'https://github.com/example');
  assert.equal(hrefOf('https://example.com/'), 'https://example.com/');
  for (const plain of ['555-0100', 'Anytown, ST', 'localhost', 'a@b', '']) assert.equal(hrefOf(plain), null, plain);
  // Older settings: the contact line's parts sorted out; links as many to a line as fit (the long LinkedIn one alone).
  assert.deepEqual(headerLines(candidate), [
    [{ text: 'pat@example.com', url: 'mailto:pat@example.com' }, { text: '555-0100', url: null }],
    [{ text: 'https://www.linkedin.com/in/example/', url: 'https://www.linkedin.com/in/example/' }, { text: 'https://example.com/', url: 'https://example.com/' }],
    [{ text: 'github.com/example', url: 'https://github.com/example' }],
  ]);
  const long = { email: 'pat@example.com', phone: '555.010.0100', location: '', links: ['https://www.linkedin.com/in/pat-example-healthcare-technology-leader/', 'https://example.com', 'https://github.com/example'] };
  assert.deepEqual(headerLines(long).map((l) => l.map((p) => p.text)), [['pat@example.com', '555.010.0100'], [long.links[0]], ['https://example.com', 'https://github.com/example']]);
  assert.deepEqual(fromCandidate({ name: 'Pat', contactLine: 'Anytown, ST | pat@example.com | (555) 010-0100', linkedin: 'linkedin.com/in/pat' }), {
    name: 'Pat', signoffName: '', email: 'pat@example.com', phone: '(555) 010-0100', location: 'Anytown, ST', links: ['linkedin.com/in/pat'],
  });
  assert.deepEqual(headerLines({ name: 'X' }), [], 'no contact details, no lines');
  assert.deepEqual(validateConfig({ candidate: { name: 'X', website: 3 } }).filter((p) => p.includes('website')), ['candidate.website must be a string']);
});

test('the PDF has link areas for the email, LinkedIn, website, and GitHub, and no "?" for the emoji', () => {
  const pdf = letterPdf(letter).toString('latin1');
  const uris = [...pdf.matchAll(/\/URI \(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(uris, ['mailto:pat@example.com', 'https://www.linkedin.com/in/example/', 'https://example.com/', 'https://github.com/example']);
  assert.match(pdf, /\/Annots \[/);
  assert.ok(pdf.includes('(Re: Vice President, Engineering at Example Co)'), 'the title without its emoji');
  assert.ok(!pdf.includes('?'), 'nothing printed as "?"');
});

// The text of one part of a .docx (a zip), read without a zip library: stored or deflated entries only.
function docxPart(buf, name) {
  for (let i = 0; i < buf.length - 30; i++) {
    if (buf.readUInt32LE(i) !== 0x04034b50) continue;
    const method = buf.readUInt16LE(i + 8);
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extra = buf.readUInt16LE(i + 28);
    if (buf.toString('utf8', i + 30, i + 30 + nameLen) !== name) continue;
    const data = buf.subarray(i + 30 + nameLen + extra, i + 30 + nameLen + extra + size);
    return (method === 8 ? inflateRawSync(data) : data).toString('utf8');
  }
  return null;
}

test('the Word letter links the header and has no emoji', async () => {
  const docx = await letterDocx(letter);
  const xml = docxPart(docx, 'word/document.xml');
  const rels = docxPart(docx, 'word/_rels/document.xml.rels');
  assert.ok(xml && rels, 'read the document and its links');
  assert.equal((xml.match(/<w:hyperlink /g) ?? []).length, 4);
  for (const url of ['mailto:pat@example.com', 'https://www.linkedin.com/in/example/', 'https://example.com/', 'https://github.com/example']) assert.ok(rels.includes(`Target="${url}"`), url);
  assert.ok(xml.includes('Re: Vice President, Engineering at Example Co'));
  assert.ok(!/[\u{1F300}-\u{1FAFF}✨]/u.test(xml), 'no emoji in the document');
});

test('the Google Doc HTML links the header and has no emoji', () => {
  const html = letterHtml(letter);
  assert.ok(html.includes('<a href="mailto:pat@example.com">pat@example.com</a> | 555-0100'));
  assert.ok(html.includes('<a href="https://github.com/example">github.com/example</a>'));
  assert.ok(html.includes('Re: Vice President, Engineering at Example Co') && html.includes('First paragraph here.'));
});

test('the header setting: from the settings until saved, checked on save, and each user has their own', () => {
  const { db, raw } = openJobStore(':memory:');
  const config = { candidate };
  assert.deepEqual(letterHeader(db, config), { ...fromCandidate(candidate), saved: false });
  assert.throws(() => saveLetterHeader(db, { name: '' }), /Enter your name/);
  assert.throws(() => saveLetterHeader(db, { name: 'Pat', email: 'not-an-email' }), /email address/);
  assert.throws(() => saveLetterHeader(db, { name: 'Pat', links: ['just words'] }), /not a web address/);
  const saved = saveLetterHeader(db, { name: ' Pat M. Example ', email: 'pat@example.com', phone: '555-0100', links: ['example.com', '', 'github.com/example'] });
  assert.deepEqual(saved, { name: 'Pat M. Example', signoffName: '', email: 'pat@example.com', phone: '555-0100', location: '', links: ['example.com', 'github.com/example'], saved: true });
  assert.equal(letterHeader(db, config).name, 'Pat M. Example');
  const b = addUser(raw, { email: 'b@example.com', name: 'Sam' });
  assert.equal(runAsUser(b, () => letterHeader(db, { candidate: { name: 'Sam' } }).saved), false, "another user's is their own");
});

test('the routes save the header, and a letter downloaded after uses it', async () => {
  const store = openJobStore(':memory:');
  const { db } = store;
  const id = Number(
    db.prepare(`INSERT INTO postings (user_id, url, url_key, company, title, company_title_key, stage, status, discovered_on, created_at, updated_at)
      VALUES (1, 'https://jobs.example.com/1', 'k1', 'Example Co', 'VP Engineering', 'k1', 'pipeline', 'new', '2026-10-01', 'x', 'x')`).run().lastInsertRowid,
  );
  db.prepare("INSERT INTO artifacts (user_id, posting_id, kind, content, source, created_at) VALUES (1, ?, 'cover_letter', 'The body of the letter, long enough to read.', 'v2', '2026-10-02T12:00:00Z')").run(id);
  const app = await buildApp({ store, config: { candidate, search: { homeLocations: [] }, fractional: {} }, services: { createBrowser: async () => null } });
  assert.equal((await app.inject('/api/letter-header')).json().saved, false);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/letter-header', payload: { name: 'Pat', links: ['nope nope'] } })).statusCode, 400);
  const put = await app.inject({ method: 'PUT', url: '/api/letter-header', payload: { name: 'Pat M. Example', signoffName: 'Pat', email: 'pat.m@example.com', phone: '555-0199', links: ['https://patexample.example.com'] } });
  assert.equal(put.json().saved, true);
  const pdf = (await app.inject(`/api/postings/${id}/letter.pdf`)).rawPayload;
  const text = (await documentText(pdf, 'l.pdf')).text;
  // The text reader drops the spaces around "|", so compare without spaces.
  assert.ok(text.includes('Pat M. Example') && text.split(' ').join('').includes('pat.m@example.com|555-0199'), text.slice(0, 200));
  assert.match(text, /^https:\/\/patexample\.example\.com$/m, 'the link line');
  assert.ok(!text.includes('pat@example.com'), 'the saved header, not the settings');
  assert.deepEqual([...pdf.toString('latin1').matchAll(/\/URI \(([^)]*)\)/g)].map((m) => m[1]), ['mailto:pat.m@example.com', 'https://patexample.example.com/']);
  await app.close();
  store.close();
});
