// The one way to make a Claude client in this app. Scripts and the server use this instead of createClaude().
// Each call is paid for by the user it runs as (db/scope.js; scripts run as the owner):
//   the owner, and users the owner put on their key: ANTHROPIC_API_KEY;
//   anyone else: their own key, sealed in users.claude_key_enc (tools/secret-box.js) and opened only in memory here.
// No key means no AI (NoClaudeKeyError). Before every call the caps are checked (agents/budget.js checkBudget); the
// first refusal of a month can tell someone (onCapReached).
import { createHash } from 'node:crypto';
import { createClaude } from '@scottmroth5/agent-core';
import { BudgetExceededError, checkBudget } from '../agents/budget.js';
import { currentUserId } from '../db/scope.js';
import { OWNER_ID, sealedClaudeKey } from '../db/users.js';
import { open } from './secret-box.js';

export class NoClaudeKeyError extends Error {
  constructor() {
    super('Add your Claude API key in Settings to use AI.');
    this.name = 'NoClaudeKeyError';
    this.statusCode = 402;
  }
}

/**
 * @param {import('better-sqlite3').Database} db  the job database (users, and spend from runs and run_calls)
 * @param {object} [options]  createClaude options for the owner's client; ownerClient and forKey(apiKey) replace the
 *   owner's and a user's client (tests);
 *   onCapReached(uid, error) is called when a cap refuses a call; now and env for tests
 */
export function createJobClaude(db, { forKey, ownerClient, onCapReached, now = () => new Date(), env = process.env, ...options } = {}) {
  const owner = ownerClient ?? createClaude(options);
  const makeForKey = forKey ?? ((apiKey) => createClaude({ ...options, client: undefined, apiKey }));
  const cache = new Map(); // uid -> { stamp, client }; the stamp changes when the user saves a new key

  const clientFor = (uid) => {
    if (uid === OWNER_ID) return owner;
    const user = db.prepare('SELECT status, ai_source FROM users WHERE id = ?').get(uid);
    if (!user || user.status !== 'active') throw Object.assign(new Error('This account is not active.'), { statusCode: 403 });
    if (user.ai_source === 'owner') return owner;
    const sealed = sealedClaudeKey(db, uid);
    if (!sealed) throw new NoClaudeKeyError();
    const stamp = createHash('sha256').update(sealed).digest('hex');
    const known = cache.get(uid);
    if (known?.stamp === stamp) return known.client;
    const client = makeForKey(open(sealed, uid));
    cache.set(uid, { stamp, client });
    return client;
  };

  return {
    async send(opts) {
      const uid = currentUserId() ?? OWNER_ID;
      const client = clientFor(uid);
      try {
        checkBudget(db, { uid, now: now(), env });
      } catch (err) {
        if (err instanceof BudgetExceededError) await Promise.resolve(onCapReached?.(uid, err)).catch(() => {});
        throw err;
      }
      return client.send(opts);
    },
  };
}

/**
 * Checks a key with Anthropic's model list (free; no tokens). True when the key works. Never logs the key.
 * @param {string} apiKey
 * @param {typeof fetch} [fetchImpl]
 */
export async function claudeKeyWorks(apiKey, fetchImpl = fetch) {
  const res = await fetchImpl('https://api.anthropic.com/v1/models?limit=1', {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(10000),
  });
  return res.ok;
}
