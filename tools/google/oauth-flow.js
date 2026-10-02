// Google sign-in for a Desktop OAuth client: opens the browser, receives the consent redirect on a local
// loopback port (PKCE), and hands the tokens to a save function. Tokens are never printed.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import { loadClientCredentials } from './auth.js';

const TIMEOUT_MS = 5 * 60 * 1000;

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

const page = (msg) => `<!doctype html><meta charset="utf-8"><title>Job Agent</title><p style="font:16px system-ui;margin:40px">${msg}</p>`;

/** The consent URL: offline access, consent prompt (always returns a refresh token), exactly these scopes. */
export function buildAuthUrl(client, { scopes, state, codeChallenge }) {
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes,
    state,
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: codeChallenge,
  });
}

/**
 * Runs the sign-in and calls save(tokens) with the refresh token and granted scopes.
 * @param {{ scopes: string[], save: (t: { refreshToken: string, scope: string }) => void, command: string }} opts
 *   command: the npm command to rerun, used in messages
 * @returns {Promise<{ missing: string[] }>}  scopes the user left unchecked (save still ran)
 */
export async function signIn({ scopes, save, command }) {
  const { clientId, clientSecret } = loadClientCredentials();
  const state = randomBytes(16).toString('hex');
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const redirectUri = `http://127.0.0.1:${server.address().port}`;
  const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const authUrl = buildAuthUrl(client, { scopes, state, codeChallenge });

  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for the Google sign-in (5 minutes).')), TIMEOUT_MS);
    server.on('request', async (req, res) => {
      const url = new URL(req.url, redirectUri);
      if (url.pathname !== '/') {
        res.writeHead(404).end();
        return;
      }
      const finish = (status, msg, err, value) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(msg));
        clearTimeout(timer);
        err ? reject(err) : resolve(value);
      };
      if (url.searchParams.get('state') !== state) return finish(400, 'Sign-in failed: state mismatch.', new Error('State mismatch; try again.'));
      const error = url.searchParams.get('error');
      if (error) return finish(400, `Sign-in cancelled (${error}).`, new Error(`Google returned: ${error}`));
      try {
        const { tokens } = await client.getToken({ code: url.searchParams.get('code'), codeVerifier, redirect_uri: redirectUri });
        if (!tokens.refresh_token) throw new Error('Google did not return a refresh token.');
        const granted = String(tokens.scope ?? '').split(/\s+/);
        const missing = scopes.filter((s) => !granted.includes(s));
        save({ refreshToken: tokens.refresh_token, scope: tokens.scope });
        if (missing.length) {
          return finish(200, 'Signed in, but some permissions were not granted. See the terminal.',
            new Error(`Signed in, but these permissions were unchecked on the consent screen: ${missing.join(', ')}. ` +
              `Run "${command}" again and leave every box checked.`));
        }
        finish(200, 'Signed in. You can close this tab and return to the terminal.', null, { missing });
      } catch (err) {
        finish(500, 'Sign-in failed. See the terminal.', err);
      }
    });
  });

  console.log('Opening your browser for Google sign-in. If it does not open, visit:\n');
  console.log(authUrl + '\n');
  console.log('Google will warn that the app is unverified: choose Advanced, then "Go to Job Agent".');
  openBrowser(authUrl);
  try {
    return await result;
  } finally {
    server.close();
  }
}
