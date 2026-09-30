import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '@scottmroth5/agent-core';
import { repoPath } from '../tools/paths.js';

/** Default database file. Gitignored, like everything under data/. */
export const DB_PATH = repoPath('data', 'job-agent.db');

const MIGRATIONS_DIR = repoPath('db', 'migrations');

/** Migrations are the .sql files in db/migrations, applied in file-name order. */
export function loadMigrations(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ id: f.replace(/\.sql$/, ''), up: readFileSync(join(dir, f), 'utf8') }));
}

/**
 * Opens the Job-Agent database with agent-core's store (runs, run_calls) plus
 * this app's tables. Use ':memory:' in tests.
 */
export function openJobStore(path = DB_PATH) {
  return openStore(path, { app: 'job-agent', migrations: loadMigrations() });
}
