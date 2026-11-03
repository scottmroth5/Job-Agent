// The one way to make a Claude client in this app. Scripts and the server use this instead of createClaude().
// Each call is paid for by the user it runs as (db/scope.ts; scripts run as the owner):
//   the owner, and users the owner put on their key: ANTHROPIC_API_KEY;
//   anyone else: their own key, sealed in users.claude_key_enc (tools/secret-box.ts) and opened only in memory here.
// No key means no AI (NoClaudeKeyError). Before every call the caps are checked (agents/budget.js checkBudget); the
// first refusal of a month can tell someone (onCapReached).
import { createHash } from 'node:crypto';
import { createClaude } from '@scottmroth5/agent-core';
import type { Claude, SendOptions } from '@scottmroth5/agent-core';
import { BudgetExceededError, checkBudget } from '../agents/budget.js';
import { currentUserId } from '../db/scope.ts';
import { OWNER_ID, sealedClaudeKey } from '../db/users.ts';
import { open } from './secret-box.ts';
import type { Database } from './types.ts';

export interface JobClaudeOptions {
  forKey?: (apiKey: string) => Claude;
  ownerClient?: Claude;
  onCapReached?: (uid: number, err: Error) => unknown;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  apiKey?: string;
  client?: object;
  maxRetries?: number;
  timeoutMs?: number;
}

export class NoClaudeKeyError extends Error {
  statusCode: number;
  constructor() {
    super('Add your Claude API key in Settings to use AI.');
    this.name = 'NoClaudeKeyError';
    this.statusCode = 402;
  }
}

/**
 * db is the job database (users, and spend from runs and run_calls). The options are createClaude's for the owner's
 * client; ownerClient and forKey(apiKey) replace the owner's and a user's client (tests); onCapReached(uid, error) is
 * called when a cap refuses a call; now and env for tests.
 */
export function createJobClaude(db: Database, { forKey, ownerClient, onCapReached, now = () => new Date(), env = process.env, ...options }: JobClaudeOptions = {}): Claude {
  const owner = ownerClient ?? createClaude(options);
  const makeForKey = forKey ?? ((apiKey: string) => createClaude({ ...options, client: undefined, apiKey }));
  const cache = new Map<number, { stamp: string; client: Claude }>(); // uid -> { stamp, client }; the stamp changes when the user saves a new key

  const clientFor = (uid: number): Claude => {
    if (uid === OWNER_ID) return owner;
    const user = db.prepare('SELECT status, ai_source FROM users WHERE id = ?').get(uid) as { status: string; ai_source: string | null } | undefined;
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
    async send(opts: SendOptions) {
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
 */
export async function claudeKeyWorks(apiKey: string, fetchImpl: typeof fetch = fetch) {
  const res = await fetchImpl('https://api.anthropic.com/v1/models?limit=1', {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(10000),
  });
  return res.ok;
}
