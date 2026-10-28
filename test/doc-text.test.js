// Text from uploaded documents (tools/doc-text.js): PDF, Word .docx, and plain text are read with no AI call; other
// files get a message saying what to upload. Synthetic files only, made here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Document, Packer, Paragraph } from 'docx';
import { documentText, tidy, MAX_DOC_BYTES } from '../tools/doc-text.js';

/** A minimal one-page PDF with real text, built by hand with its byte offsets. */
export function tinyPdf(lines) {
  const content = ['BT', '/F1 12 Tf', '72 720 Td', '14 TL', ...lines.map((l) => `(${l.replace(/[()\\]/g, '')}) Tj T*`), 'ET'].join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const LINES = ['Pat Example', 'VP Engineering at Example Co, 2020 to now', 'Grew a team from 6 to 45 engineers while releases stayed weekly.'];

test('a PDF, a Word .docx, and a text file each give their text', async () => {
  const pdf = await documentText(tinyPdf(LINES), 'resume.pdf');
  assert.equal(pdf.kind, 'pdf');
  for (const line of LINES) assert.ok(pdf.text.includes(line), line);

  const docx = await Packer.toBuffer(new Document({ sections: [{ children: LINES.map((t) => new Paragraph(t)) }] }));
  assert.deepEqual(await documentText(docx, 'Resume.DOCX'), { kind: 'docx', text: LINES.join('\n\n') });

  assert.equal((await documentText(Buffer.from(`${LINES.join('\r\n')}\r\n\r\n\r\n`), 'about.md')).text, LINES.join('\n'));
});

test('old .doc, other files, empty, too large, and textless files are refused with what to do instead', async () => {
  const refuse = async (bytes, name, re) => assert.rejects(documentText(bytes, name), (e) => e.statusCode === 400 && re.test(e.message), name);
  await refuse(Buffer.from('x'.repeat(80)), 'resume.doc', /\.docx or PDF/);
  await refuse(Buffer.from('x'.repeat(80)), 'resume.exe', /PDF, a Word \.docx, or a text file/);
  await refuse(Buffer.from('PK not really a zip'.padEnd(80, '.')), 'resume.docx', /could not be read/);
  await refuse(Buffer.alloc(0), 'a.txt', /empty/);
  await refuse(Buffer.alloc(MAX_DOC_BYTES + 1, 97), 'a.txt', /under 5 MB/);
  await refuse(Buffer.from('short'), 'a.txt', /No text/);
  await refuse(tinyPdf([]), 'scan.pdf', /selectable text/);
});

test('tidy: Windows line ends, trailing spaces, and runs of blank lines', () => {
  assert.equal(tidy('a  \r\nb\r\n\r\n\r\n\r\nc\n'), 'a\nb\n\nc');
});
