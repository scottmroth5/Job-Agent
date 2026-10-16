// The one way to make a Claude client in this app: agent-core's client behind the monthly spending cap
// (agents/budget.js). Scripts and the server use this instead of createClaude().
import { createClaude } from '@scottmroth5/agent-core';
import { withBudget } from '../agents/budget.js';

/** @param {import('better-sqlite3').Database} db  the job database (spend is read from its run_calls) */
export function createJobClaude(db, options = {}) {
  return withBudget(createClaude(options), db);
}
