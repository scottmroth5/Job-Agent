// deploy/secrets.json (v3 Phase 7, decision 0010): which settings each service of the split layout gets. Held to the code:
// every setting the code reads is listed (from Parameter Store, fixed by compose or the image, or never in the cloud), the
// services that must not hold a secret do not, and env-from-ssm.sh writes each service only its own (with a stand-in aws;
// needs bash and python3, so Linux). Synthetic values only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { repoPath } from '../tools/paths.ts';

/** @typedef {{ services: string[], settings: Record<string, { to: string[], why: string }>, fixed: Record<string, string>, local: Record<string, string> }} Matrix */
const matrix = /** @type {Matrix} */ (JSON.parse(readFileSync(repoPath('deploy', 'secrets.json'), 'utf8')));
const listed = (/** @type {string} */ name) => name in matrix.settings || name in matrix.fixed || name in matrix.local;

/** Every .ts and .js file under a folder. @param {string} dir @returns {string[]} */
const filesIn = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : filesIn(path);
    return /\.(ts|js)$/.test(name) ? [path] : [];
  });

/** The settings the code that runs in the cloud reads: env.NAME and env['NAME'], with where. */
function settingsRead() {
  const files = [...['agents', 'tools', 'db', 'server', 'apps'].flatMap((d) => filesIn(repoPath(d))), repoPath('scripts', 'pipeline.js')];
  /** @type {Map<string, string>} */
  const found = new Map();
  for (const file of files) {
    for (const m of readFileSync(file, 'utf8').matchAll(/\benv(?:\.([A-Z][A-Z0-9_]+)|\[['"]([A-Z][A-Z0-9_]+)['"]\])/g)) {
      const name = m[1] ?? m[2];
      if (!found.has(name)) found.set(name, relative(repoPath(), file));
    }
  }
  // The Anthropic SDK reads the owner's key itself (through agent-core's createClaude).
  found.set('ANTHROPIC_API_KEY', 'the Anthropic SDK');
  return found;
}

test('every setting the code reads is in deploy/secrets.json', () => {
  const missing = [...settingsRead()].filter(([name]) => !listed(name)).map(([name, file]) => `${name} (${file})`);
  assert.deepEqual(missing, [], 'add each to secrets.json: settings (with its services), fixed, or local');
});

test('the matrix is well formed: known services, a reason each, and a name in one list only', () => {
  for (const [name, { to, why }] of Object.entries(matrix.settings)) {
    assert.ok(Array.isArray(to) && to.every((s) => matrix.services.includes(s)), `${name}: unknown service`);
    assert.ok(why && why.length > 10, `${name}: say why`);
    assert.ok(!(name in matrix.fixed) && !(name in matrix.local), `${name} is in two lists`);
  }
  for (const [name, why] of [...Object.entries(matrix.fixed), ...Object.entries(matrix.local)]) assert.ok(why.length > 5, `${name}: say why`);
  assert.deepEqual(matrix.services, ['api', 'scheduler', 'worker-browser', 'worker-ai', 'worker-io']);
});

test('deploy/cloud.env.example names only settings the matrix knows', () => {
  const names = [...readFileSync(repoPath('deploy', 'cloud.env.example'), 'utf8').matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]);
  assert.ok(names.length > 5);
  assert.deepEqual(names.filter((n) => !listed(n)), []);
});

const gets = (/** @type {string} */ service) => Object.entries(matrix.settings).filter(([, s]) => s.to.includes(service)).map(([n]) => n).sort();
const SECRETS = ['ANTHROPIC_API_KEY', 'USER_KEY_SECRET', 'SESSION_SECRET', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_WEB_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN', 'EMAIL_ENC_KEY', 'JOB_BACKUP_PASSPHRASE'];

test('the browser worker holds no Claude, Google, Gmail, user-key, session, or backup secret', () => {
  assert.deepEqual(gets('worker-browser').filter((n) => SECRETS.includes(n)), []);
  assert.ok(gets('worker-browser').includes('SERPER_API_KEY'), 'discover needs the search key');
});

test('the scheduler gets its database, its schedules, and its address only', () => {
  assert.deepEqual(gets('scheduler'), ['AUTH_MODE', 'AUTOMATIC_RUNS', 'DATABASE_URL', 'PUBLIC_URL', 'SCHEDULE_INBOX', 'SCHEDULE_PIPELINE', 'SHUTDOWN_GRACE_SECONDS', 'TZ']);
});

test('only the api signs sessions and sign-ins; no service gets the backup passphrase or the owner and backup logins', () => {
  for (const name of ['SESSION_SECRET', 'GOOGLE_WEB_CLIENT_SECRET', 'AUTH_ALLOWED_EMAILS']) assert.deepEqual(matrix.settings[name].to, ['api'], name);
  assert.deepEqual(matrix.settings.JOB_BACKUP_PASSPHRASE.to, []);
  for (const name of ['MIGRATE_DATABASE_URL', 'BACKUP_DATABASE_URL']) assert.ok(!(name in matrix.settings), `${name} stays in backup.env`);
});

test('compose.split.yml has a service, its own settings file, and its own database name for each service in the matrix', () => {
  const compose = readFileSync(repoPath('deploy', 'compose.split.yml'), 'utf8');
  for (const s of matrix.services) {
    assert.match(compose, new RegExp(`^  ${s}:$`, 'm'), s);
    assert.ok(compose.includes(`env_file: state/env/${s}.env`), `${s} env file`);
    assert.ok(compose.includes(`PGAPPNAME: ${s}`), `${s} application name`);
  }
});

const hasTools = process.platform !== 'win32' && spawnSync('sh', ['-c', 'command -v bash && command -v python3'], { encoding: 'utf8' }).status === 0;
const skip = hasTools ? false : 'needs bash and python3 (Linux)';

/**
 * Runs env-from-ssm.sh in a throwaway server folder with a stand-in aws that answers from params (name -> value).
 * @param {Record<string, string>} params @param {string[]} conf
 */
function envFromSsm(params, conf) {
  const dir = mkdtempSync(join(tmpdir(), 'ja-env-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    mkdirSync(join(dir, 'state'), { mode: 0o700 });
    writeFileSync(join(dir, 'params.json'), JSON.stringify(params));
    writeFileSync(join(bin, 'aws'), `#!/usr/bin/env bash
prefix=""; while [[ $# -gt 0 ]]; do [[ "$1" == --path ]] && prefix="$2"; shift; done
PREFIX="$prefix" python3 -c 'import json, os; p = os.environ["PREFIX"]; print(json.dumps([{"n": k, "v": v} for k, v in json.load(open("params.json")).items() if k.startswith(p)]))'
`);
    chmodSync(join(bin, 'aws'), 0o755);
    copyFileSync(repoPath('deploy', 'env-from-ssm.sh'), join(dir, 'env-from-ssm.sh'));
    copyFileSync(repoPath('deploy', 'secrets.json'), join(dir, 'secrets.json'));
    writeFileSync(join(dir, 'server.conf'), `${['AWS_REGION=us-east-2', ...conf].join('\n')}\n`);
    writeFileSync(join(dir, '.env'), '');
    writeFileSync(join(dir, 'backup.env'), '');
    const r = spawnSync('bash', [join(dir, 'env-from-ssm.sh')], { cwd: dir, encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir } });
    /** @type {Record<string, string[]>} */
    const files = {};
    for (const s of matrix.services) {
      const path = join(dir, 'state', 'env', `${s}.env`);
      if (existsSync(path)) files[s] = readFileSync(path, 'utf8').trim().split('\n').map((l) => l.split('=')[0]);
    }
    return { code: r.status, stderr: r.stderr, env: readFileSync(join(dir, '.env'), 'utf8'), files, leftover: existsSync(join(dir, 'state', 'env.new')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BASE = {
  '/job-agent/env/ANTHROPIC_API_KEY': 'sk-stand-in',
  '/job-agent/env/SESSION_SECRET': 'stand-in-session',
  '/job-agent/env/SERPER_API_KEY': 'stand-in-serper',
  '/job-agent/env/TZ': 'Etc/UTC',
  '/job-agent/env/DATABASE_URL': 'postgres://ja_app:x@db.example.com/job_agent',
  '/job-agent/backup/MIGRATE_DATABASE_URL': 'postgres://ja_migrate:x@db.example.com/job_agent',
};
const OWN = Object.fromEntries(matrix.services.map((s) => [`/job-agent/service/${s}/DATABASE_URL`, `postgres://ja_${s.replace('-', '_')}:x@db.example.com/job_agent`]));

test('env-from-ssm.sh: without LAYOUT=split it writes .env and backup.env as before, and no service files', { skip }, () => {
  const r = envFromSsm(BASE, ['ENV_SOURCE=ssm']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.env, /^SESSION_SECRET='stand-in-session'$/m);
  assert.deepEqual(r.files, {});
});

test('env-from-ssm.sh with LAYOUT=split: each service gets its own login and only its settings', { skip }, () => {
  const r = envFromSsm({ ...BASE, ...OWN }, ['ENV_SOURCE=ssm', 'LAYOUT=split']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.files.api, ['DATABASE_URL', 'ANTHROPIC_API_KEY', 'SESSION_SECRET', 'TZ']);
  assert.deepEqual(r.files['worker-browser'], ['DATABASE_URL', 'SERPER_API_KEY', 'TZ']);
  assert.deepEqual(r.files.scheduler, ['DATABASE_URL', 'TZ']);
  assert.match(r.env, /DATABASE_URL='postgres:\/\/ja_app:/, '.env keeps the one-process login');
  assert.ok(!r.stderr.includes('stand-in'), 'no value is printed');
  assert.equal(r.leftover, false);
});

test('env-from-ssm.sh with LAYOUT=split refuses an unlisted setting or a service without its own login, and changes nothing', { skip }, () => {
  const unlisted = envFromSsm({ ...BASE, ...OWN, '/job-agent/env/SOMETHING_NEW': 'x' }, ['ENV_SOURCE=ssm', 'LAYOUT=split']);
  assert.notEqual(unlisted.code, 0);
  assert.match(unlisted.stderr, /SOMETHING_NEW is not in secrets\.json/);
  assert.equal(unlisted.env, '', '.env is untouched');
  assert.deepEqual(unlisted.files, {});
  const { '/job-agent/service/worker-ai/DATABASE_URL': _, ...withoutAi } = OWN;
  const noLogin = envFromSsm({ ...BASE, ...withoutAi }, ['ENV_SOURCE=ssm', 'LAYOUT=split']);
  assert.notEqual(noLogin.code, 0);
  assert.match(noLogin.stderr, /no own database login for: worker-ai/);
  assert.equal(noLogin.leftover, false);
});
