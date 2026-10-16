// Starts the Job Hunt UI server: npm run ui, then open http://localhost:5178
// Local only (AUTH_MODE=none binds to 127.0.0.1). Google, Claude and the knowledge doc load on first use.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createClaude } from '@scottmroth5/agent-core';
import { loadConfig } from '../tools/config.js';
import { loadKnowledge } from '../tools/knowledge.js';
import { createHttp } from '../tools/http.js';
import { createBrowser } from '../tools/browser.js';
import { getGoogleAuth, getInboxAuth } from '../tools/google/auth.js';
import { createGmail } from '../agents/inbox/gmail.js';
import { loadInboxConfig } from '../agents/inbox/config.js';
import { loadKey } from '../agents/inbox/crypto.js';
import { createDriveClient } from '../tools/google/drive.js';
import { repoPath, ROOT } from '../tools/paths.js';
import { openJobStore } from '../db/index.js';
import { buildApp } from './app.js';
import { schedulesFromEnv } from './scheduler.js';
import { timeZone } from '../tools/dates.js';
import { assertSafeBinding, authSettings } from './auth.js';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 5178);
const authConfig = authSettings(process.env);
const authMode = authConfig.mode;
assertSafeBinding({ host, mode: authMode, settings: authConfig });

const config = loadConfig();
const store = openJobStore();
const auth = getGoogleAuth();

// The knowledge doc is re-read at most every 10 minutes, so edits to it show up without a restart.
let knowledgeCache = { text: null, at: 0 };
const services = {
  claude: createClaude(),
  http: createHttp(),
  drive: createDriveClient(auth),
  createBrowser: () => createBrowser(),
  // The Run pipeline button and the scheduler: the same scripts as npm run pipeline and npm run backup, each in its
  // own process so a long run never blocks the server.
  runScript: ({ script, onLine, onError = () => {} }) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ['--env-file-if-exists=.env', script], { cwd: ROOT, env: process.env, windowsHide: true });
      let lastError = null;
      createInterface({ input: child.stdout }).on('line', onLine);
      createInterface({ input: child.stderr }).on('line', (l) => {
        if (l.trim()) lastError = l.trim().slice(0, 300);
        onError(l);
      });
      child.on('error', (err) => resolve({ code: 1, lastError: err.message }));
      child.on('close', (code) => resolve({ code: code ?? 1, lastError }));
    }),
  runPipeline: (opts) => services.runScript({ ...opts, script: 'scripts/pipeline.js' }),
  schedules: schedulesFromEnv(process.env),
  inbox: {
    ready: () => Boolean(process.env.GMAIL_REFRESH_TOKEN && process.env.EMAIL_ENC_KEY),
    gmail: (opts = {}) => createGmail({ auth: getInboxAuth(), ...opts }),
    key: () => loadKey(),
    cfg: loadInboxConfig(),
  },
  knowledge: async () => {
    if (!knowledgeCache.text || Date.now() - knowledgeCache.at > 10 * 60 * 1000) {
      knowledgeCache = { text: await loadKnowledge({ auth }), at: Date.now() };
    }
    return knowledgeCache.text;
  },
};

const app = await buildApp({ store, config, services, webDir: repoPath('web', 'dist'), authMode, auth: { settings: authConfig } });
await app.listen({ host, port });
console.log(
  authMode === 'google'
    ? `Job Hunt UI: ${authConfig.publicUrl}  (Google sign-in on; ${authConfig.allowed.length} allowed account${authConfig.allowed.length === 1 ? '' : 's'})`
    : `Job Hunt UI: http://localhost:${port}  (API contract: http://localhost:${port}/api/openapi.json)`,
);
console.log(`Time zone: ${timeZone()}${process.env.TZ ? '' : ' (the computer\'s; set TZ in .env to fix it, e.g. TZ=America/New_York)'}`);
console.log(
  services.schedules.length
    ? `Scheduled: ${services.schedules.map((j) => `${j.name} ${j.schedule.spec}`).join('; ')}`
    : 'Scheduled: nothing (set SCHEDULE_PIPELINE, SCHEDULE_INBOX, or SCHEDULE_BACKUP in .env to run jobs from the server)',
);

const shutdown = async () => {
  await app.close();
  store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
