// The API service (v3 Phase 7): the routes, the short AI calls they make, and the account emails. Task work runs in
// apps/worker.ts and automatic runs in apps/scheduler.ts, so a browser crash or a long Claude task never reaches
// sign-in. npm run ui and the demo stay one process (server/index.js).
import { startServer } from '../server/start.ts';

await startServer({ roles: { workers: false, scheduler: false }, service: 'api' });
