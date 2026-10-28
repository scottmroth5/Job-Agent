// Resume downloads as the user prefers (tools/resume-format.js, server/resume-routes.js): the original file, plain text,
// Word, or PDF laid out from the text. Synthetic resumes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumeBlocks, resumeDocx, resumePdf } from '../tools/resume-format.js';
import { documentText } from '../tools/doc-text.js';
import { openJobStore } from '../db/index.js';
import { addResume } from '../agents/resumes.js';
import { buildApp } from '../server/app.js';
import { DEMO_RESUMES } from '../demo/sample-data.js';

const RESUME = `Pat Example
Anytown, ST | pat@example.com | 555-0100

SUMMARY
Engineering leader with 12 years in software, known for steady releases and calm incidents.

EXPERIENCE
Director of Engineering, an example company, Anytown, ST (2019 to present)
- Grew the team from 10 to 30 engineers; attrition under 10%.
- Cut major incidents by 60% with on-call and reviews, including "quoted" words and a dash – here.

EDUCATION
BS Computer Science, Example University`;

test('blocks: name, contact, headings, roles, bullets, and paragraphs', () => {
  assert.deepEqual(
    resumeBlocks(RESUME).map((b) => b.type),
    ['name', 'contact', 'heading', 'para', 'heading', 'role', 'bullet', 'bullet', 'heading', 'para'],
  );
  assert.equal(resumeBlocks('# Pat\n## Skills\n* Hiring')[1].type, 'heading', 'Markdown headings and bullets work too');
});

test('the PDF and Word versions hold every line of the text, and long resumes page', async () => {
  const pdf = resumePdf(RESUME);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  const fromPdf = (await documentText(pdf, 'r.pdf')).text;
  for (const line of ['Pat Example', 'Director of Engineering, an example company', 'Grew the team from 10 to 30 engineers', 'BS Computer Science']) {
    assert.ok(fromPdf.includes(line), `PDF: ${line}`);
  }
  const fromDocx = (await documentText(await resumeDocx(RESUME), 'r.docx')).text;
  assert.ok(fromDocx.includes('Cut major incidents by 60%'), 'Word');
  const long = resumePdf(`${RESUME}\n\n${Array.from({ length: 120 }, (_, i) => `- Result number ${i} with a measurable outcome.`).join('\n')}`);
  assert.ok((long.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length >= 3, 'pages break');
});

test("the demo's sample resumes are full length and lay out with roles and bullets", () => {
  for (const r of DEMO_RESUMES) {
    assert.ok(r.text.length > 2000, `${r.label} is a realistic length`);
    const types = resumeBlocks(r.text).map((b) => b.type);
    assert.ok(types.filter((t) => t === 'role').length >= 3 && types.filter((t) => t === 'bullet').length >= 10, r.label);
  }
});

test('the download route serves the original, text, Word, and PDF, each named and typed for its format', async () => {
  const store = openJobStore(':memory:');
  const app = await buildApp({ store, config: { search: { homeLocations: [] }, fractional: {} }, services: { createBrowser: async () => null } });
  const r = await addResume(store.db, { bytes: Buffer.from(RESUME), filename: 'Pat resume.md' });
  const get = (format) => app.inject(`/api/resumes/${r.id}/file${format ? `?format=${format}` : ''}`);
  const cases = [
    [null, /text\/plain/, 'Pat resume.md'],
    ['text', /text\/plain/, 'Pat resume.txt'],
    ['docx', /wordprocessingml/, 'Pat resume.docx'],
    ['pdf', /application\/pdf/, 'Pat resume.pdf'],
  ];
  for (const [format, type, name] of cases) {
    const res = await get(format);
    assert.equal(res.statusCode, 200, String(format));
    assert.match(res.headers['content-type'], type, String(format));
    assert.match(res.headers['content-disposition'], new RegExp(`^attachment; filename="${name.replace('.', '\\.')}"`), String(format));
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  }
  assert.equal((await get('rtf')).statusCode, 400, 'only the four formats');
  await app.close();
  store.close();
});
