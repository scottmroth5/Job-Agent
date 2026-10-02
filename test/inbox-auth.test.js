import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OAuth2Client } from 'google-auth-library';
import { buildAuthUrl } from '../tools/google/oauth-flow.js';
import { INBOX_SCOPES, getInboxAuth } from '../tools/google/auth.js';

test('the inbox asks for exactly gmail.readonly and gmail.modify, offline, with PKCE', () => {
  const client = new OAuth2Client({ clientId: 'test-client.apps.example', clientSecret: 'x', redirectUri: 'http://127.0.0.1:5555' });
  const url = new URL(buildAuthUrl(client, { scopes: INBOX_SCOPES, state: 's1', codeChallenge: 'c1' }));
  assert.deepEqual(url.searchParams.get('scope').split(' ').sort(), [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.readonly',
  ]);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:5555');
  assert.ok(!INBOX_SCOPES.some((s) => /gmail\.send|mail\.google\.com\/?$/.test(s)), 'no send or full-mail scope');
});

test('the inbox client reads its token from GMAIL_REFRESH_TOKEN only', () => {
  const env = { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' };
  assert.throws(() => getInboxAuth({ env }), /inbox:auth/);
  const client = getInboxAuth({ env: { ...env, GMAIL_REFRESH_TOKEN: 'rt-test' } });
  assert.equal(client.credentials.refresh_token, 'rt-test');
});
