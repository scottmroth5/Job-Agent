import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { ROOT } from '../tools/paths.js';

// DATA_DIR is read once at startup, so each case runs in its own process.
const pathsWith = (env) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      ['--input-type=module', '-e', `
        const { dataPath } = await import('./tools/paths.js');
        const { DB_PATH } = await import('./db/index.js');
        const { CONFIG_PATH } = await import('./tools/config.js');
        const { ATTACHMENTS_DIR } = await import('./server/attachments.js');
        const { TOKEN_PATH } = await import('./tools/google/auth.js');
        console.log(JSON.stringify({ db: DB_PATH, config: CONFIG_PATH, attachments: ATTACHMENTS_DIR, token: TOKEN_PATH, logs: dataPath('logs') }));
      `],
      { cwd: ROOT, env: { ...process.env, DATA_DIR: '', ...env }, encoding: 'utf8' },
    ),
  );

test('data paths default to the repo data folder and move together with DATA_DIR', () => {
  const plain = pathsWith({});
  assert.equal(plain.db, join(ROOT, 'data', 'job-agent.db'));
  const moved = pathsWith({ DATA_DIR: 'mounted-disk' });
  const base = resolve(ROOT, 'mounted-disk');
  assert.deepEqual(moved, {
    db: join(base, 'job-agent.db'),
    config: join(base, 'config', 'job-search.json'),
    attachments: join(base, 'attachments'),
    token: join(base, 'google', 'token.json'),
    logs: join(base, 'logs'),
  });
});
