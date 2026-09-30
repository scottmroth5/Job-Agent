// Starts the Job Hunt UI server: npm run ui, then open http://localhost:5178
// Local only (AUTH_MODE=none binds to 127.0.0.1). Google, Claude and the knowledge doc load on first use.
import { createClaude } from '@scottmroth5/agent-core';
import { loadConfig } from '../tools/config.js';
import { loadKnowledge } from '../tools/knowledge.js';
import { createHttp } from '../tools/http.js';
import { createBrowser } from '../tools/browser.js';
import { getGoogleAuth } from '../tools/google/auth.js';
import { createDriveClient } from '../tools/google/drive.js';
import { repoPath } from '../tools/paths.js';
import { openJobStore } from '../db/index.js';
import { buildApp } from './app.js';
import { assertSafeBinding } from './auth.js';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 5178);
const authMode = process.env.AUTH_MODE ?? 'none';
assertSafeBinding({ host, mode: authMode });

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
  knowledge: async () => {
    if (!knowledgeCache.text || Date.now() - knowledgeCache.at > 10 * 60 * 1000) {
      knowledgeCache = { text: await loadKnowledge({ auth }), at: Date.now() };
    }
    return knowledgeCache.text;
  },
};

const app = await buildApp({ store, config, services, webDir: repoPath('web', 'dist'), authMode });
await app.listen({ host, port });
console.log(`Job Hunt UI: http://localhost:${port}  (API contract: http://localhost:${port}/api/openapi.json)`);

const shutdown = async () => {
  await app.close();
  store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
