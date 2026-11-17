// deploy/deploy.sh (v3 Phase 5): which commands each kind of deploy runs, in order, with a stand-in docker that records
// its calls and answers with set exit codes. SQLite servers (no server.conf) keep their old flow; PostgreSQL servers
// check on a scratch copy, back up, migrate as the owner, and put the database back when a migration fails. Needs bash
// and flock (Linux: CI, or the image); skipped elsewhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoPath } from '../tools/paths.ts';

const hasTools = process.platform !== 'win32' && spawnSync('sh', ['-c', 'command -v bash && command -v flock'], { encoding: 'utf8' }).status === 0;
const skip = hasTools ? false : 'needs bash and flock (Linux)';

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "tag=\${IMAGE_TAG:-} profiles=\${COMPOSE_PROFILES:-} require=\${JA_REQUIRE_POSTGRES:-} mode=\${JA_DATABASE_MIGRATIONS:-} :: $*" >> "$FAKE_LOG"
case "$*" in
  *"backup-service.js pre-migrate"*) exit "\${FAKE_PREMIGRATE:-0}" ;;
  *"scripts/migrate.js"*) exit "\${FAKE_MIGRATE:-0}" ;;
  *"migrations-pending.js"*) exit "\${FAKE_PENDING:-0}" ;;
esac
exit 0
`;

/**
 * Runs deploy.sh in a throwaway server folder. conf: server.conf lines (none: a SQLite server). Returns the exit code
 * and the docker calls (and whether env-from-ssm.sh ran).
 * @param {string[]} args @param {{ conf?: string[], current?: string, env?: Record<string, string> }} o
 */
function deploy(args, { conf, current = 'sha-old', env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ja-deploy-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'docker'), FAKE_DOCKER);
    chmodSync(join(bin, 'docker'), 0o755);
    copyFileSync(repoPath('deploy', 'deploy.sh'), join(dir, 'deploy.sh'));
    chmodSync(join(dir, 'deploy.sh'), 0o755);
    writeFileSync(join(dir, 'env-from-ssm.sh'), '#!/usr/bin/env bash\necho "env-from-ssm" >> "$FAKE_LOG"\n');
    chmodSync(join(dir, 'env-from-ssm.sh'), 0o755);
    if (conf) writeFileSync(join(dir, 'server.conf'), `${conf.join('\n')}\n`);
    if (current) writeFileSync(join(dir, '.deployed-tag'), `${current}\n`);
    const log = join(dir, 'calls.log');
    writeFileSync(log, '');
    const r = spawnSync('bash', [join(dir, 'deploy.sh'), ...args], {
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, HOME: dir, ...env },
    });
    return { code: r.status, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean), stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const has = (/** @type {string[]} */ calls, /** @type {string} */ part) => calls.findIndex((c) => c.includes(part));

test('a SQLite server (no server.conf) deploys as before: the file check, no backup service, no SSM', { skip }, () => {
  const { code, calls } = deploy(['deploy', 'sha-new']);
  assert.equal(code, 0);
  assert.ok(has(calls, 'migrations-pending.js') >= 0);
  assert.equal(has(calls, 'backup-service.js'), -1);
  assert.equal(has(calls, 'env-from-ssm'), -1);
  const up = calls.find((c) => c.includes('up -d'));
  assert.match(String(up), /profiles= require= mode= ::/, 'no PostgreSQL settings');
});

test('a PostgreSQL server with nothing to migrate: checked on a copy, no backup or migration, the backup service starts', { skip }, () => {
  const { code, calls } = deploy(['deploy', 'sha-new'], { conf: ['DB_ENGINE=postgres'] });
  assert.equal(code, 0);
  assert.ok(has(calls, 'backup-service.js pre-migrate') >= 0);
  assert.equal(has(calls, 'backup-now'), -1);
  assert.equal(has(calls, 'scripts/migrate.js'), -1);
  assert.equal(has(calls, 'migrations-pending.js'), -1, 'no SQLite check');
  assert.ok(calls.some((c) => c.includes('pull app demo backup')));
  assert.match(String(calls.find((c) => c.includes('up -d'))), /tag=sha-new profiles=postgres require=1 mode=deploy ::/);
});

test('a PostgreSQL deploy that migrates: Drive backup with the current image, then migrate.js with the new one, then start', { skip }, () => {
  const { code, calls } = deploy(['deploy', 'sha-new'], { conf: ['DB_ENGINE=postgres'], env: { FAKE_PREMIGRATE: '10' } });
  assert.equal(code, 0);
  const backup = has(calls, 'backup-service.js backup-now');
  const migrate = has(calls, 'scripts/migrate.js');
  const up = has(calls, 'up -d');
  assert.ok(backup >= 0 && migrate > backup && up > migrate, 'backup, then migrate, then start');
  assert.match(String(calls[backup]), /^tag=sha-old /, 'the backup runs with the current image');
  assert.match(String(calls[migrate]), /^tag=sha-new /, 'the migration runs with the new image');
});

test('a failed migration puts the database back and keeps the old image running', { skip }, () => {
  const { code, calls } = deploy(['deploy', 'sha-new'], { conf: ['DB_ENGINE=postgres'], env: { FAKE_PREMIGRATE: '10', FAKE_MIGRATE: '1' } });
  assert.notEqual(code, 0);
  const restore = has(calls, 'backup-service.js restore-pre-migration');
  assert.ok(restore > has(calls, 'scripts/migrate.js'));
  assert.match(String(calls.findLast((c) => c.includes('up -d'))), /^tag=sha-old /);
});

test('a failed check on the copy changes nothing', { skip }, () => {
  const { code, calls } = deploy(['deploy', 'sha-new'], { conf: ['DB_ENGINE=postgres'], env: { FAKE_PREMIGRATE: '1' } });
  assert.notEqual(code, 0);
  assert.equal(has(calls, 'scripts/migrate.js'), -1);
  assert.equal(has(calls, 'up -d'), -1);
});

test('ENV_SOURCE=ssm rebuilds the settings before deploy, rollback and up', { skip }, () => {
  for (const args of [['deploy', 'sha-new'], ['up']]) {
    const { code, calls } = deploy(args, { conf: ['DB_ENGINE=postgres', 'ENV_SOURCE=ssm'] });
    assert.equal(code, 0, args.join(' '));
    assert.ok(has(calls, 'env-from-ssm') >= 0 && has(calls, 'env-from-ssm') < has(calls, 'up -d'), args.join(' '));
  }
});
