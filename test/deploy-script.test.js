// deploy/deploy.sh (v3 Phase 5): which commands each kind of deploy runs, in order, with a stand-in docker that records
// its calls and answers with set exit codes. SQLite servers (no server.conf) keep their old flow; PostgreSQL servers
// check on a scratch copy, back up, migrate as the owner, and put the database back when a migration fails. The split
// layout (v3 Phase 7, LAYOUT=split): roles first and the api last, one service replaced or rolled back alone, never
// across a schema change. Needs bash and flock (Linux: CI, or the image); skipped elsewhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoPath } from '../tools/paths.ts';

const hasTools = process.platform !== 'win32' && spawnSync('sh', ['-c', 'command -v bash && command -v flock'], { encoding: 'utf8' }).status === 0;
const skip = hasTools ? false : 'needs bash and flock (Linux)';

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "tag=\${IMAGE_TAG:-} profiles=\${COMPOSE_PROFILES:-} require=\${JA_REQUIRE_POSTGRES:-} mode=\${JA_DATABASE_MIGRATIONS:-} :: $* || files=\${COMPOSE_FILE:-} browser=\${TAG_WORKER_BROWSER:-} api=\${TAG_API:-}" >> "$FAKE_LOG"
case "$*" in
  *"migrations-list.js"*) v="FAKE_SCHEMA_\${IMAGE_TAG//-/_}"; echo "\${!v:-029-workers}"; exit 0 ;;
  *"exec -T"*) exit "\${FAKE_UNHEALTHY:-0}" ;;
  *"backup-service.js pre-migrate"*) exit "\${FAKE_PREMIGRATE:-0}" ;;
  *"scripts/migrate.js"*) exit "\${FAKE_MIGRATE:-0}" ;;
  *"migrations-pending.js"*) exit "\${FAKE_PENDING:-0}" ;;
esac
exit 0
`;

/**
 * Runs deploy.sh in a throwaway server folder. conf: server.conf lines (none: a SQLite server). Returns the exit code
 * and the docker calls (and whether env-from-ssm.sh ran).
 * state: use a state/ folder (the EC2 server) seeded with these files; its files are returned afterwards too.
 * @param {string[]} args @param {{ conf?: string[], current?: string, env?: Record<string, string>, state?: Record<string, string> }} o
 */
function deploy(args, { conf, current = 'sha-old', env = {}, state } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ja-deploy-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'docker'), FAKE_DOCKER);
    chmodSync(join(bin, 'docker'), 0o755);
    // deploy.sh's health wait sleeps 3 seconds a try for up to 120 seconds; a test of an unhealthy start need not wait it out.
    writeFileSync(join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(join(bin, 'sleep'), 0o755);
    copyFileSync(repoPath('deploy', 'deploy.sh'), join(dir, 'deploy.sh'));
    chmodSync(join(dir, 'deploy.sh'), 0o755);
    writeFileSync(join(dir, 'env-from-ssm.sh'), '#!/usr/bin/env bash\necho "env-from-ssm" >> "$FAKE_LOG"\n');
    chmodSync(join(dir, 'env-from-ssm.sh'), 0o755);
    if (conf) writeFileSync(join(dir, 'server.conf'), `${conf.join('\n')}\n`);
    const stateDir = state ? join(dir, 'state') : dir;
    if (state) {
      mkdirSync(stateDir);
      for (const [name, value] of Object.entries(state)) writeFileSync(join(stateDir, name), `${value}\n`);
    }
    if (current) writeFileSync(join(stateDir, '.deployed-tag'), `${current}\n`);
    const log = join(dir, 'calls.log');
    writeFileSync(log, '');
    const r = spawnSync('bash', [join(dir, 'deploy.sh'), ...args], {
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, HOME: dir, ...env },
    });
    /** @type {Record<string, string>} */
    const files = {};
    if (state) for (const name of readdirSync(stateDir)) if (name.startsWith('.') && name !== '.deploy.lock') files[name] = readFileSync(join(stateDir, name), 'utf8').trim();
    return { code: r.status, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean), stderr: r.stderr, files };
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

const SPLIT = ['DB_ENGINE=postgres', 'ENV_SOURCE=ssm', 'LAYOUT=split'];
const ROLES = ['worker-browser', 'worker-ai', 'worker-io', 'scheduler', 'api'];
const tags = (/** @type {string} */ tag) => Object.fromEntries(ROLES.map((r) => [`.tag-${r}`, tag]));

test('the split layout: the one app container goes, the roles start before the api, each answers /healthz, each tag is kept', { skip }, () => {
  const { code, calls, files, stderr } = deploy(['deploy', 'sha-new'], { conf: SPLIT, state: {} });
  assert.equal(code, 0, stderr);
  const rm = has(calls, 'rm -sf app');
  const roles = has(calls, 'up -d --remove-orphans worker-browser worker-ai worker-io scheduler demo backup');
  const api = has(calls, 'up -d api caddy');
  assert.ok(rm >= 0 && roles > rm && api > roles, 'app removed, then the roles, then the api');
  assert.match(calls[api], /files=compose\.yml:compose\.split\.yml browser= api=$/, 'both compose files; every service on IMAGE_TAG');
  for (const r of ROLES) {
    const port = r === 'api' ? ':5178/' : ':5180/';
    assert.ok(calls.some((c) => c.includes(`exec -T ${r} `) && c.includes(port)), `${r} health`);
  }
  for (const r of ROLES) assert.equal(files[`.tag-${r}`], 'sha-new', r);
  assert.equal(files['.deployed-tag'], 'sha-new');
});

test('the split layout needs PostgreSQL, Parameter Store, and the state folder', { skip }, () => {
  const { code, stderr } = deploy(['deploy', 'sha-new'], { conf: ['DB_ENGINE=postgres', 'LAYOUT=split'], state: {} });
  assert.notEqual(code, 0);
  assert.match(stderr, /LAYOUT=split needs/);
});

test('deploy --only replaces one service on the same schema; the others keep their tags', { skip }, () => {
  const { code, calls, files, stderr } = deploy(['deploy', 'sha-new', '--only', 'worker-browser'], { conf: SPLIT, state: tags('sha-old') });
  assert.equal(code, 0, stderr);
  const up = calls.find((c) => c.includes('up -d --no-deps worker-browser'));
  assert.match(String(up), /^tag=sha-old .* browser=sha-new api=sha-old$/, 'only worker-browser on the new tag');
  assert.equal(has(calls, 'pre-migrate'), -1, 'no database work');
  assert.equal(has(calls, 'up -d api'), -1, 'the api is untouched');
  assert.deepEqual([files['.tag-worker-browser'], files['.prev-tag-worker-browser'], files['.tag-api']], ['sha-new', 'sha-old', 'sha-old']);
});

test('deploy --only is refused across a schema change, for an unknown service, and without the split layout', { skip }, () => {
  const schema = deploy(['deploy', 'sha-new', '--only', 'worker-ai'], { conf: SPLIT, state: tags('sha-old'), env: { FAKE_SCHEMA_sha_new: '030-traces' } });
  assert.notEqual(schema.code, 0);
  assert.match(schema.stderr, /know different migrations/);
  assert.equal(has(schema.calls, 'up -d'), -1, 'nothing started');
  assert.equal(schema.files['.tag-worker-ai'], 'sha-old');
  const unknown = deploy(['deploy', 'sha-new', '--only', 'worker-ai,app'], { conf: SPLIT, state: tags('sha-old') });
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.stderr, /Unknown service "app"/);
  const oneProcess = deploy(['deploy', 'sha-new', '--only', 'worker-ai'], { conf: ['DB_ENGINE=postgres', 'ENV_SOURCE=ssm'], state: {} });
  assert.notEqual(oneProcess.code, 0);
  assert.match(oneProcess.stderr, /needs the split layout/);
});

test('a failed deploy --only puts that service back on its previous tag', { skip }, () => {
  const { code, calls, files } = deploy(['deploy', 'sha-new', '--only', 'worker-io'], { conf: SPLIT, state: tags('sha-old'), env: { FAKE_UNHEALTHY: '1' } });
  assert.notEqual(code, 0);
  const ups = calls.filter((c) => c.includes('up -d --no-deps worker-io'));
  assert.equal(ups.length, 2, 'started on the new tag, then on the old one again');
  assert.equal(files['.tag-worker-io'], 'sha-old');
});

test('rollback <service> on the same schema; refused across a schema change', { skip }, () => {
  const state = { ...tags('sha-new'), '.prev-tag-worker-ai': 'sha-old' };
  const ok = deploy(['rollback', 'worker-ai'], { conf: SPLIT, state, current: 'sha-new' });
  assert.equal(ok.code, 0, ok.stderr);
  assert.ok(ok.calls.some((c) => c.includes('up -d --no-deps worker-ai')));
  assert.deepEqual([ok.files['.tag-worker-ai'], ok.files['.prev-tag-worker-ai']], ['sha-old', 'sha-new']);
  const across = deploy(['rollback', 'worker-ai'], { conf: SPLIT, state, current: 'sha-new', env: { FAKE_SCHEMA_sha_old: '028-reserved' } });
  assert.notEqual(across.code, 0);
  assert.match(across.stderr, /different migrations/);
  assert.equal(has(across.calls, 'up -d'), -1);
});

test('the forced SSH command takes only the known words', { skip }, () => {
  const extra = deploy([], { conf: SPLIT, state: {}, env: { SSH_ORIGINAL_COMMAND: 'deploy sha-new --only worker-ai extra' } });
  assert.notEqual(extra.code, 0);
  assert.match(extra.stderr, /Too many arguments/);
  const stray = deploy([], { conf: SPLIT, state: {}, env: { SSH_ORIGINAL_COMMAND: 'deploy sha-new --no-backup worker-ai' } });
  assert.notEqual(stray.code, 0);
  assert.match(stray.stderr, /Too many arguments/);
});
