// Settings (multi-user, phase 2): the signed-in user's account and their own Claude key. The key is checked with
// Anthropic's free model list, then sealed (tools/secret-box.js, bound to the user's id) before it is stored; it is never
// returned, logged, or shown to anyone, only whether one is set. The owner's AI uses ANTHROPIC_API_KEY instead.
import { budgetStatus } from '../agents/budget.js';
import { getUser, OWNER_ID, setClaudeKey } from '../db/users.js';
import { boxKey, seal } from '../tools/secret-box.js';

const anyObject = { type: 'object', additionalProperties: true };
// Anthropic API keys: "sk-ant-" then letters, digits, dashes, and underscores.
const KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]{20,200}$/;

function account(db, uid) {
  const u = getUser(db, uid);
  const budget = budgetStatus(db, { uid });
  return {
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status,
    owner: uid === OWNER_ID,
    // Where AI calls are paid from: 'env' (the owner's ANTHROPIC_API_KEY), 'owner' (the owner's key, with a cap), 'own'.
    ai: { paidBy: uid === OWNER_ID ? 'env' : u.ai_source, keySet: u.has_key, budget },
  };
}

/**
 * @param {object} o
 * @param {(apiKey: string) => Promise<boolean>} [o.checkKey]  tools/claude.js claudeKeyWorks (tests pass a fake)
 */
export function registerAccountRoutes(app, { db, checkKey }) {
  app.get('/api/account', { schema: { summary: 'Your account: who you are and how your AI is paid for', response: { 200: anyObject } } }, async (req) =>
    account(db, req.uid ?? OWNER_ID),
  );

  app.put(
    '/api/account/claude-key',
    {
      schema: {
        summary: 'Save your own Claude API key (checked with Anthropic, then stored encrypted)',
        body: { type: 'object', required: ['key'], additionalProperties: false, properties: { key: { type: 'string' } } },
        response: { 200: anyObject },
      },
    },
    async (req) => {
      const uid = req.uid ?? OWNER_ID;
      if (uid === OWNER_ID) throw Object.assign(new Error('Your AI uses ANTHROPIC_API_KEY in the server settings.'), { statusCode: 400 });
      const apiKey = req.body.key.trim();
      if (!KEY_PATTERN.test(apiKey)) throw Object.assign(new Error('That does not look like an Anthropic API key (it starts with sk-ant-).'), { statusCode: 400 });
      let key;
      try {
        key = boxKey();
      } catch {
        throw Object.assign(new Error('The server is not set up to store keys yet. Ask the owner.'), { statusCode: 503 });
      }
      let works = false;
      try {
        works = await checkKey(apiKey);
      } catch {
        throw Object.assign(new Error('Could not reach Anthropic to check the key. Try again shortly.'), { statusCode: 502 });
      }
      if (!works) throw Object.assign(new Error('Anthropic did not accept this key.'), { statusCode: 400 });
      setClaudeKey(db, uid, seal(apiKey, uid, key));
      return account(db, uid);
    },
  );

  app.delete('/api/account/claude-key', { schema: { summary: 'Remove your saved Claude API key', response: { 200: anyObject } } }, async (req) => {
    const uid = req.uid ?? OWNER_ID;
    setClaudeKey(db, uid, null);
    return account(db, uid);
  });
}
