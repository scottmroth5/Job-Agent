import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJobStore } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { cleanFilename, cleanType } from '../server/attachments.js';

// Synthetic files in a temporary folder only.
async function setup() {
  const store = openJobStore(':memory:');
  const job = Number(
    store.db
      .prepare(`INSERT INTO postings (url_key, company, title, company_title_key, discovered_on, stage, status, created_at, updated_at)
        VALUES ('k', 'Example Co', 'CTO', 'example|cto', '2026-10-01', 'pipeline', 'applied', 'x', 'x')`)
      .run().lastInsertRowid,
  );
  const dir = mkdtempSync(join(tmpdir(), 'attach-'));
  const app = await buildApp({ store, config: { search: { homeLocations: [] }, fractional: {} }, services: { createBrowser: async () => null, attachmentsDir: dir } });
  const upload = (body, name, type, id = job) =>
    app.inject({ method: 'POST', url: `/api/postings/${id}/attachments`, headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(name), ...(type ? { 'x-file-type': type } : {}) }, payload: body });
  return { store, app, job, dir, upload };
}

test('upload, list, download, and delete an attachment', async () => {
  const { app, store, job, dir, upload } = await setup();
  const pdf = Buffer.from('%PDF-1.4 tailored resume');
  const res = await upload(pdf, 'Résumé for Example Co.pdf', 'application/pdf');
  assert.equal(res.statusCode, 201);
  const a = res.json();
  assert.deepEqual([a.filename, a.contentType, a.sizeBytes], ['Résumé for Example Co.pdf', 'application/pdf', pdf.length]);
  assert.deepEqual(readdirSync(join(dir, String(job))), [a.id], 'stored under its ID, not its name');

  assert.equal((await app.inject(`/api/postings/${job}/attachments`)).json().length, 1);
  assert.equal((await app.inject(`/api/postings/${job}`)).json().attachments[0].id, a.id);
  assert.equal((await app.inject('/api/postings')).json()[0].attachmentCount, 1);

  const dl = await app.inject(`/api/attachments/${a.id}/file`);
  assert.equal(dl.statusCode, 200);
  assert.deepEqual(dl.rawPayload, pdf);
  assert.match(dl.headers['content-disposition'], /^inline; filename="R_sum_ for Example Co\.pdf"; filename\*=UTF-8''R%C3%A9sum%C3%A9/);
  assert.equal(dl.headers['x-content-type-options'], 'nosniff');
  assert.match(dl.headers['content-security-policy'], /sandbox/);
  assert.match((await app.inject(`/api/attachments/${a.id}/file?download`)).headers['content-disposition'], /^attachment;/);

  assert.equal((await app.inject({ method: 'DELETE', url: `/api/attachments/${a.id}` })).statusCode, 204);
  assert.equal(existsSync(join(dir, String(job), a.id)), false, 'the file is removed too');
  assert.equal((await app.inject(`/api/attachments/${a.id}/file`)).statusCode, 404);
  await app.close();
  store.close();
});

test('HTML and unknown files always download; names and types are cleaned', async () => {
  const { app, store, upload } = await setup();
  const html = (await upload(Buffer.from('<script>alert(1)</script>'), '../../evil.html', 'text/html')).json();
  assert.equal(html.filename, 'evil.html');
  assert.match((await app.inject(`/api/attachments/${html.id}/file`)).headers['content-disposition'], /^attachment;/);
  const odd = (await upload(Buffer.from('x'), 'notes', 'not a type')).json();
  assert.equal(odd.contentType, 'application/octet-stream');
  assert.equal(cleanFilename('C:\\path\\to\\offer.docx'), 'offer.docx');
  assert.equal(cleanFilename('..'), 'file');
  assert.equal(cleanFilename('a"b\u0007c.txt'), 'abc.txt');
  assert.equal(cleanType('Image/PNG'), 'image/png');
  await app.close();
  store.close();
});

test('refused: an empty body, an unknown job, and a file over the limit', async () => {
  const { app, store, upload } = await setup();
  assert.equal((await upload(Buffer.alloc(0), 'empty.txt')).statusCode, 400);
  assert.equal((await upload(Buffer.from('x'), 'a.txt', 'text/plain', 9999)).statusCode, 404);
  assert.equal((await upload(Buffer.alloc(25 * 1024 * 1024 + 1), 'big.bin')).statusCode, 413);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/attachments/00000000-0000-0000-0000-000000000000' })).statusCode, 404);
  await app.close();
  store.close();
});
