// Starts the one-process Job Hunt server: npm run ui, then open http://localhost:5178. It runs every role: the routes,
// the task workers for every pool, and the scheduler. In the cloud each is a service of its own (apps/api.ts,
// apps/worker.ts, apps/scheduler.ts; v3 Phase 7). AUTH_MODE=demo serves the sample database read-only (npm run demo).
import { startServer } from './start.ts';

await startServer();
