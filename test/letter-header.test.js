// Cover letter documents: no emoji or pictographs anywhere (Word shows a picture, a PDF a "?"), and the header's email,
// LinkedIn, website, and GitHub as clickable links in Word, PDF, and the Google Doc. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { withoutPictographs } from '../tools/text.js';
import { headerLines, hrefOf } from '../tools/letter-header.js';
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
  assert.deepEqual(headerLines(candidate), [
    [{ text: 'pat@example.com', url: 'mailto:pat@example.com' }, { text: '555-0100', url: null }],
    [{ text: 'https://www.linkedin.com/in/example/', url: 'https://www.linkedin.com/in/example/' }, { text: 'https://example.com/', url: 'https://example.com/' }, { text: 'github.com/example', url: 'https://github.com/example' }],
  ]);
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
