import { existsSync, readFileSync } from 'node:fs';
import { OAuth2Client } from 'google-auth-library';
import { repoPath } from '../paths.js';

/** Read the knowledge doc, manage only files this app creates, send email. Nothing broader. */
export const SCOPES = [
  'https://www.googleapis.com/auth/documents.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/gmail.send',
];

/** The inbox's own sign-in (npm run inbox:auth): read mail, and modify only to add labels. */
export const INBOX_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.modify'];

export const CLIENT_SECRET_PATH = repoPath('data', 'google', 'client_secret.json');
export const TOKEN_PATH = repoPath('data', 'google', 'token.json');

/**
 * OAuth client ID and secret: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET when set (cloud),
 * otherwise the Desktop-app JSON downloaded from Google Cloud.
 */
export function loadClientCredentials({ path = CLIENT_SECRET_PATH, env = process.env } = {}) {
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  }
  if (!existsSync(path)) {
    throw new Error(`Google client file not found at ${path}. Download the Desktop-app OAuth client JSON from Google Cloud.`);
  }
  const json = JSON.parse(readFileSync(path, 'utf8'));
  const c = json.installed ?? json.web;
  if (!c?.client_id || !c?.client_secret) throw new Error(`${path} does not look like an OAuth client file.`);
  return { clientId: c.client_id, clientSecret: c.client_secret };
}

/**
 * Signed-in OAuth2 client for the Google APIs. The refresh token comes from
 * GOOGLE_REFRESH_TOKEN when set (cloud), otherwise data/google/token.json from npm run google:login.
 * Access tokens are refreshed automatically by google-auth-library.
 */
export function getGoogleAuth({ clientSecretPath, tokenPath = TOKEN_PATH, env = process.env } = {}) {
  const { clientId, clientSecret } = loadClientCredentials({ path: clientSecretPath, env });
  let refreshToken = env.GOOGLE_REFRESH_TOKEN;
  if (!refreshToken && existsSync(tokenPath)) refreshToken = JSON.parse(readFileSync(tokenPath, 'utf8')).refresh_token;
  if (!refreshToken) throw new Error('Not signed in to Google. Run "npm run google:login".');
  const client = new OAuth2Client({ clientId, clientSecret });
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

/** Signed-in client for the inbox, from GMAIL_REFRESH_TOKEN in .env (written by npm run inbox:auth). */
export function getInboxAuth({ clientSecretPath, env = process.env } = {}) {
  const { clientId, clientSecret } = loadClientCredentials({ path: clientSecretPath, env });
  if (!env.GMAIL_REFRESH_TOKEN) throw new Error('Gmail inbox is not signed in. Run "npm run inbox:auth".');
  const client = new OAuth2Client({ clientId, clientSecret });
  client.setCredentials({ refresh_token: env.GMAIL_REFRESH_TOKEN });
  return client;
}
