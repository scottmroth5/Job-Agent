// Inbox settings: config/inbox.json (generic, committed). Personal values never go here.
import { readFileSync } from 'node:fs';
import { repoPath } from '../../tools/paths.js';

export const INBOX_CONFIG_PATH = repoPath('config', 'inbox.json');

export function loadInboxConfig(path = INBOX_CONFIG_PATH) {
  const c = JSON.parse(readFileSync(path, 'utf8'));
  const problems = [];
  if (!Array.isArray(c.atsDomains) || !c.atsDomains.every((d) => typeof d === 'string' && d)) problems.push('atsDomains must be a list of domains');
  if (!(c.autoLinkAt > 0 && c.autoLinkAt <= 1)) problems.push('autoLinkAt must be a number above 0 and at most 1');
  for (const k of ['backfillDays', 'fallbackDays', 'bodyChars']) if (!(Number.isInteger(c[k]) && c[k] > 0)) problems.push(`${k} must be a positive whole number`);
  if (typeof c.model !== 'string') problems.push('model must be a model ID');
  if (problems.length) throw new Error(`config/inbox.json: ${problems.join('; ')}`);
  return c;
}
