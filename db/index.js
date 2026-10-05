import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '@scottmroth5/agent-core';
import { repoPath } from '../tools/paths.js';
import * as duplicateStatus from './migrations/008-duplicate-status.js';
import * as lookups from './migrations/009-lookups.js';

/** Default database file. Gitignored, like everything under data/. */
export const DB_PATH = repoPath('data', 'job-agent.db');

const MIGRATIONS_DIR = repoPath('db', 'migrations');

// Migrations that need code (a table rebuild) rather than plain SQL. Each exports id and up(db).
const CODE_MIGRATIONS = [duplicateStatus, lookups];

/** Migrations: the .sql files in db/migrations plus CODE_MIGRATIONS, applied in id (file-name) order. */
export function loadMigrations(dir = MIGRATIONS_DIR) {
  const sql = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => ({ id: f.replace(/\.sql$/, ''), up: readFileSync(join(dir, f), 'utf8') }));
  return [...sql, ...CODE_MIGRATIONS.map(({ id, up }) => ({ id, up }))].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * Opens the Job-Agent database with agent-core's store (runs, run_calls) plus
 * this app's tables. Use ':memory:' in tests.
 */
export function openJobStore(path = DB_PATH) {
  return openStore(path, { app: 'job-agent', migrations: loadMigrations() });
}
