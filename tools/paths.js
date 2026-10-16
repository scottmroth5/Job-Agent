import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo root, independent of the current working directory.
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Absolute path inside the repo, e.g. repoPath('web', 'dist'). */
export const repoPath = (...parts) => join(ROOT, ...parts);

/**
 * Where personal data lives: the database, config, Google sign-in, attachments, logs, and evals. DATA_DIR moves it
 * (for example to a mounted disk at /data in a container); otherwise it is the repo's gitignored data folder.
 */
export const DATA_DIR = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(ROOT, 'data');

/** Absolute path inside the data folder, e.g. dataPath('job-agent.db'). */
export const dataPath = (...parts) => join(DATA_DIR, ...parts);
