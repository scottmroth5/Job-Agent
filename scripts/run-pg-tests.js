// npm run test:pg: the whole suite (or the files named) on PostgreSQL (v3 Phase 4). It recreates the job_agent_test
// database, then runs node --test with DATABASE_URL pointing at it, so every openJobStore in the tests is on PostgreSQL
// (':memory:' stores get a throwaway schema each). The address holds a password, so it is never printed.
//
// Where it connects: PG_TEST_URL when set (CI: an administrator connection to the service), else the local database
// from compose.dev.yml (npm run pg:up) with PG_DEV_PASSWORD from .env.
//
//   npm run test:pg                          every suite
//   npm run test:pg -- test/notes.test.js    the files named
import { spawnSync } from 'node:child_process';
import pg from 'pg';

const TEST_DB = 'job_agent_test';

function adminUrl() {
  if (process.env.PG_TEST_URL) return process.env.PG_TEST_URL;
  const password = process.env.PG_DEV_PASSWORD;
  if (!password) {
    console.error('test:pg: set PG_TEST_URL, or PG_DEV_PASSWORD in .env and start the local database with npm run pg:up.');
    process.exit(1);
  }
  return `postgres://job_agent:${encodeURIComponent(password)}@127.0.0.1:5433/job_agent`;
}

/** @param {string} url @param {string} database */
const withDatabase = (url, database) => {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
};

const admin = adminUrl();
const client = new pg.Client({ connectionString: admin });
try {
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await client.query(`CREATE DATABASE ${TEST_DB}`);
} catch (err) {
  console.error(`test:pg: could not prepare the test database: ${/** @type {Error} */ (err).message}`);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}

const files = process.argv.slice(2);
const run = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: withDatabase(admin, TEST_DB), PG_SCHEMA_PER_PATH: '1' },
});
process.exit(run.status ?? 1);
