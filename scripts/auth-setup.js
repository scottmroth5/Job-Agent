// Prepares .env for Google sign-in (AUTH_MODE=google). Creates SESSION_SECRET when missing (or with --rotate,
// which signs everyone out) and reports which sign-in settings are still missing. Never prints values.
//   npm run auth:setup
//   npm run auth:setup -- --rotate
import { randomBytes } from 'node:crypto';
import { setEnvValues, hasEnvValue, ENV_PATH } from '../tools/env-file.js';

const rotate = process.argv.includes('--rotate');
if (rotate || !hasEnvValue('SESSION_SECRET')) {
  setEnvValues({ SESSION_SECRET: randomBytes(48).toString('base64') });
  console.log(`${rotate ? 'Replaced' : 'Created'} SESSION_SECRET in ${ENV_PATH}.${rotate ? ' Everyone is signed out.' : ''}`);
} else {
  console.log('SESSION_SECRET is already set (use --rotate to replace it and sign everyone out).');
}

const needed = {
  GOOGLE_WEB_CLIENT_ID: 'the Web application OAuth client ID (Google Cloud > Clients)',
  GOOGLE_WEB_CLIENT_SECRET: "that client's secret",
  AUTH_ALLOWED_EMAILS: 'the Google accounts allowed to sign in, comma separated',
  PUBLIC_URL: 'where the app is opened, e.g. http://localhost:5178 (its redirect URI is PUBLIC_URL/auth/google/callback)',
};
const missing = Object.entries(needed).filter(([k]) => !hasEnvValue(k));
if (missing.length) {
  console.log('\nStill to add to .env:');
  for (const [k, what] of missing) console.log(`  ${k}=  ${what}`);
}
console.log(`\nThen set AUTH_MODE=google in .env and restart npm run ui.${hasEnvValue('AUTH_MODE') ? '' : ' (Without AUTH_MODE the app stays open on this computer only.)'}`);
