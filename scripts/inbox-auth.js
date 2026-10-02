// One-time Gmail sign-in for the inbox (read mail; modify only to add labels). Saves the refresh token
// to .env as GMAIL_REFRESH_TOKEN, and creates EMAIL_ENC_KEY there if it is missing. Prints neither.
// Uses the same Google Cloud OAuth client as npm run google:login.
import { INBOX_SCOPES } from '../tools/google/auth.js';
import { signIn } from '../tools/google/oauth-flow.js';
import { setEnvValues, hasEnvValue, ENV_PATH } from '../tools/env-file.js';
import { newKey } from '../agents/inbox/crypto.js';

async function main() {
  let wrote = [];
  await signIn({
    scopes: INBOX_SCOPES,
    command: 'npm run inbox:auth',
    save: ({ refreshToken }) => {
      const values = { GMAIL_REFRESH_TOKEN: refreshToken };
      if (!hasEnvValue('EMAIL_ENC_KEY')) values.EMAIL_ENC_KEY = newKey();
      wrote = setEnvValues(values);
    },
  });
  console.log(`Signed in. Saved ${wrote.join(' and ')} to ${ENV_PATH}.`);
  if (wrote.includes('EMAIL_ENC_KEY')) console.log('EMAIL_ENC_KEY encrypts stored email bodies: back up .env, since bodies cannot be read without it.');
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
