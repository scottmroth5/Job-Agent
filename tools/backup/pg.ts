// PostgreSQL's own programs for the backup container (v3 Phase 5, ported from Health-Review): pg_dump, pg_restore, and a
// scratch cluster (initdb plus pg_ctl) to restore into. The backup image has PostgreSQL 18 (PG_BIN); the app image has
// none, and only this file may start them (scripts/security-check.js).
//
// Safety:
// - Programs start from an argument array, never a shell.
// - Connection details reach them as PG* environment variables, never arguments (other processes can read those);
//   the address is never logged.
// - A failure names the program and its exit code only: their output can quote row values (a COPY error), so it is kept
//   out of errors and logs.
// - A scratch cluster lives in a new folder under the OS temp folder, listens on a Unix socket only (no TCP), and is
//   stopped and deleted however the work ends.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A program from PG_BIN (the backup image and CI set it), else from PATH. */
const bin = (name: string) => (process.env.PG_BIN ? join(process.env.PG_BIN, name) : name);

/** For tests: false when PostgreSQL's programs are here, else why the test skips. */
export const pgToolsSkip: string | false = process.env.PG_BIN ? false : 'PG_BIN is not set (PostgreSQL 18 programs: the backup image and CI have them)';

/** A database address as libpq environment variables (only what libpq needs). */
export function pgEnv(url: string): Record<string, string> {
  const u = new URL(url);
  const q = u.searchParams;
  const env: Record<string, string> = {
    PGHOST: q.get('host') ?? decodeURIComponent(u.hostname),
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
  };
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  const sslmode = q.get('sslmode');
  const sslrootcert = q.get('sslrootcert');
  if (sslmode) env.PGSSLMODE = sslmode;
  if (sslrootcert) env.PGSSLROOTCERT = sslrootcert;
  return env;
}

/** Runs one program; rejects with "<program> failed (exit N)" only. */
function run(tool: string, args: string[], env: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    // A small, fixed environment: PATH and a locale for the programs, plus the connection variables given.
    const childEnv = { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', ...env };
    execFile(bin(tool), args, { env: childEnv, maxBuffer: 1024 * 1024, windowsHide: true }, (err) => {
      if (!err) return resolve();
      const code = typeof err.code === 'number' ? err.code : (err.code ?? 'unknown');
      reject(Object.assign(new Error(`${tool} failed (exit ${code})`), { name: 'PgToolError', tool, exitCode: code }));
    });
  });
}

/**
 * pg_dump in custom format (compressed, restorable table by table) to file. The backup login obeys row security (it is
 * neither a superuser nor BYPASSRLS), and pg_dump refuses a table whose rows row security would filter unless told it may
 * (--enable-row-security); the session's app.uid is 'all' (PGOPTIONS, as store.admin sets it), so the own_rows policy
 * lets it read every user's rows.
 */
export const dump = (url: string, file: string) =>
  run('pg_dump', ['--format=custom', '--no-password', '--enable-row-security', `--file=${file}`], { ...pgEnv(url), PGOPTIONS: '-c app.uid=all' });

/**
 * Restores a dump into an empty database (a scratch cluster's): owners and grants are left out, since the scratch
 * cluster has none of production's logins. One transaction; the first error stops it.
 */
export const restoreInto = (url: string, file: string) =>
  run('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction', '--no-password', `--dbname=${pgEnv(url).PGDATABASE}`, file], pgEnv(url));

/**
 * Restores a dump into the live database after its schema was emptied (pg-deploy.ts restorePreMigration), as the owner
 * login: one transaction, objects owned by that login, with the dump's grants.
 */
export const restoreLive = (url: string, file: string) =>
  run('pg_restore', ['--no-owner', '--exit-on-error', '--single-transaction', '--no-password', `--dbname=${pgEnv(url).PGDATABASE}`, file], pgEnv(url));

/**
 * A throwaway PostgreSQL in the OS temp folder for fn(url): initdb with byte-order text (C locale, UTF8), started on a
 * Unix socket only, with a database named scratch. Stopped and deleted however fn ends.
 */
export async function withScratchCluster<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'ja-scratch-pg-'));
  const data = join(root, 'data');
  let started = false;
  try {
    await run('initdb', ['--pgdata', data, '--username=scratch', '--auth=trust', '--locale=C', '--encoding=UTF8', '--no-instructions', '--no-sync']);
    // A short-lived copy: no TCP, little memory, no durability (it is deleted afterwards).
    const opts = `-c listen_addresses= -c unix_socket_directories=${root} -c shared_buffers=16MB -c fsync=off -c full_page_writes=off -c synchronous_commit=off`;
    await run('pg_ctl', ['--pgdata', data, '--options', opts, '--wait', '--silent', '--log', join(root, 'log'), 'start']);
    started = true;
    const url = (database: string) => `postgres://scratch@localhost/${database}?host=${encodeURIComponent(root)}`;
    await run('createdb', ['--template=template0', '--encoding=UTF8', '--lc-collate=C', '--lc-ctype=C', 'scratch'], pgEnv(url('postgres')));
    return await fn(url('scratch'));
  } finally {
    if (started) await run('pg_ctl', ['--pgdata', data, '--mode=immediate', '--wait', '--silent', 'stop']).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}
