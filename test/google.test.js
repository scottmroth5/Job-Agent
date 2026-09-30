import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { docText } from '../tools/google/docs.js';
import { buildRawEmail } from '../tools/google/gmail.js';
import { getGoogleAuth, loadClientCredentials } from '../tools/google/auth.js';

test('docText joins paragraphs and table cells in order', () => {
  const para = (s) => ({ paragraph: { elements: [{ textRun: { content: s } }] } });
  const document = {
    body: {
      content: [
        {},
        para('Section 1\n'),
        { table: { tableRows: [{ tableCells: [{ content: [para('A\n')] }, { content: [para('B\n')] }] }] } },
        para('\n\n\n'),
        para('End\n'),
      ],
    },
  };
  assert.equal(docText(document), 'Section 1\nA\nB\n\nEnd');
  assert.equal(docText({}), '');
});

test('buildRawEmail produces a decodable base64url message', () => {
  const raw = buildRawEmail({ to: 'someone@example.com', subject: 'Résumé update', text: 'Hello $200k' });
  assert.ok(!/[+/=]/.test(raw), 'base64url has no +, / or padding');
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  assert.match(decoded, /^To: someone@example.com\r\n/);
  assert.match(decoded, /Subject: =\?UTF-8\?B\?/);
  const body = decoded.split('\r\n\r\n')[1];
  assert.equal(Buffer.from(body, 'base64').toString('utf8'), 'Hello $200k');
  assert.throws(() => buildRawEmail({ to: 'a@example.com', subject: 's' }), /exactly one/);
});

test('client credentials and refresh token come from env first, then files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'job-agent-'));
  try {
    const secretPath = join(dir, 'client_secret.json');
    const tokenPath = join(dir, 'token.json');
    writeFileSync(secretPath, JSON.stringify({ installed: { client_id: 'file-id', client_secret: 'file-secret' } }));
    assert.deepEqual(loadClientCredentials({ path: secretPath, env: {} }), { clientId: 'file-id', clientSecret: 'file-secret' });
    assert.deepEqual(
      loadClientCredentials({ path: secretPath, env: { GOOGLE_CLIENT_ID: 'env-id', GOOGLE_CLIENT_SECRET: 'env-secret' } }),
      { clientId: 'env-id', clientSecret: 'env-secret' },
    );

    assert.throws(() => getGoogleAuth({ clientSecretPath: secretPath, tokenPath, env: {} }), /google:login/);
    writeFileSync(tokenPath, JSON.stringify({ refresh_token: 'file-refresh' }));
    assert.equal(getGoogleAuth({ clientSecretPath: secretPath, tokenPath, env: {} }).credentials.refresh_token, 'file-refresh');
    const fromEnv = getGoogleAuth({ clientSecretPath: secretPath, tokenPath, env: { GOOGLE_REFRESH_TOKEN: 'env-refresh' } });
    assert.equal(fromEnv.credentials.refresh_token, 'env-refresh');

    assert.throws(() => loadClientCredentials({ path: join(dir, 'missing.json'), env: {} }), /Desktop-app/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
