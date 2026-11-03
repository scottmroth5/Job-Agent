// Google sign-in for a Desktop OAuth client: opens the browser, receives the consent redirect on a local
// loopback port (PKCE), and hands the tokens to a save function. Tokens are never printed.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import { loadClientCredentials } from './auth.ts';

const TIMEOUT_MS = 5 * 60 * 1000;

function openBrowser(url: string) {
  const [cmd, args]: [string, string[]] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

const page = (msg: string) => `<!doctype html><meta charset="utf-8"><title>Job Agent</title><p style="font:16px system-ui;margin:40px">${msg}</p>`;

/** The consent URL: offline access, consent prompt (always returns a refresh token), exactly these scopes. */
export function buildAuthUrl(client: OAuth2Client, { scopes, state, codeChallenge }: { scopes: string[]; state: string; codeChallenge?: string }) {
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
 * command is the npm command to rerun, used in messages. Resolves to the scopes the user left unchecked (save still ran).
 */
export async function signIn({ scopes, save, command }: { scopes: string[]; save: (t: { refreshToken: string; scope: string | undefined }) => void; command: string }): Promise<{ missing: string[] }> {
  const { clientId, clientSecret } = loadClientCredentials();
  const state = randomBytes(16).toString('hex');
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // A TCP listen always reports an AddressInfo (a string is only for pipes).
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const authUrl = buildAuthUrl(client, { scopes, state, codeChallenge });

  const result = new Promise<{ missing: string[] }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for the Google sign-in (5 minutes).')), TIMEOUT_MS);
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- the handler catches its own errors and settles the sign-in through finish
    server.on('request', async (req, res) => {
      const url = new URL(req.url ?? '/', redirectUri);
      if (url.pathname !== '/') {
        res.writeHead(404).end();
        return;
      }
      const finish = (status: number, msg: string, err?: unknown, value?: { missing: string[] }) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(msg));
        clearTimeout(timer);
        err ? reject(err) : resolve(value as { missing: string[] });
      };
      if (url.searchParams.get('state') !== state) return finish(400, 'Sign-in failed: state mismatch.', new Error('State mismatch; try again.'));
      // Google's error code is not echoed anywhere (terminal or page): only a fixed message chosen from it.
      if (url.searchParams.has('error')) {
        const cancelled = url.searchParams.get('error') === 'access_denied';
        const message = cancelled ? 'The sign-in was cancelled on the Google page.' : 'Google returned an error instead of signing in.';
        return finish(400, `${message} Close this tab and try again.`, new Error(`${message} Run "${command}" again.`));
      }
      try {
        const { tokens } = await client.getToken({ code: url.searchParams.get('code') as string, codeVerifier, redirect_uri: redirectUri });
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
