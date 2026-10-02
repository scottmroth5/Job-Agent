// One-time Google sign-in. Opens the browser, receives the consent redirect on a local
// port, and saves the refresh token to data/google/token.json (gitignored).
// Run again any time the sign-in is revoked or the token file is lost.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCOPES, TOKEN_PATH } from '../tools/google/auth.js';
import { signIn } from '../tools/google/oauth-flow.js';

async function main() {
  await signIn({
    scopes: SCOPES,
    command: 'npm run google:login',
    save: ({ refreshToken, scope }) => {
      mkdirSync(dirname(TOKEN_PATH), { recursive: true });
      writeFileSync(TOKEN_PATH, JSON.stringify({ refresh_token: refreshToken, scope, obtained_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
    },
  });
  console.log(`Signed in. Refresh token saved to ${TOKEN_PATH}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
