// Inbox settings: config/inbox.json (generic, committed). Personal values never go here.
import { readFileSync } from 'node:fs';
import { repoPath } from '../../tools/paths.ts';

export const INBOX_CONFIG_PATH = repoPath('config', 'inbox.json');

/** config/inbox.json, as loadInboxConfig checks it. */
export interface InboxConfig {
  atsDomains: string[];
  personalDomains?: string[];
  /** Model links at or above this confidence are made without review. */
  autoLinkAt: number;
  backfillDays: number;
  fallbackDays: number;
  bodyChars: number;
  model: string;
}

export function loadInboxConfig(path = INBOX_CONFIG_PATH): InboxConfig {
  // A committed file, checked field by field below before it is used.
  const c = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> & { atsDomains?: unknown[]; personalDomains?: unknown[]; autoLinkAt?: number };
  const problems: string[] = [];
  if (!Array.isArray(c.atsDomains) || !c.atsDomains.every((d) => typeof d === 'string' && d)) problems.push('atsDomains must be a list of domains');
  if (c.personalDomains != null && !(Array.isArray(c.personalDomains) && c.personalDomains.every((d) => typeof d === 'string'))) problems.push('personalDomains must be a list of domains');
  if (!((c.autoLinkAt as number) > 0 && (c.autoLinkAt as number) <= 1)) problems.push('autoLinkAt must be a number above 0 and at most 1');
  for (const k of ['backfillDays', 'fallbackDays', 'bodyChars']) if (!(Number.isInteger(c[k]) && (c[k] as number) > 0)) problems.push(`${k} must be a positive whole number`);
  if (typeof c.model !== 'string') problems.push('model must be a model ID');
  if (problems.length) throw new Error(`config/inbox.json: ${problems.join('; ')}`);
  return c as unknown as InboxConfig;
}
