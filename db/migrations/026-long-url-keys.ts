// Url keys over 500 characters become their first 400 characters, #sha256=, and the SHA-256 of the whole key (UTF-8,
// hex), the rule tools/urls.ts capUrlKey now applies to every new key. PostgreSQL refuses index entries over about
// 2.7 KB, so a long key could not be copied into it (Phase 4), and the same link must keep giving the same key. The
// PostgreSQL twin (db/postgres/026-long-url-keys.sql) does the same in SQL.

import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3'; // migrations run on the connection, synchronously, before the engine exists

export const id = '026-long-url-keys';

// A copy of the rule as of this migration (tools/urls.ts capUrlKey may change later).
const MAX = 500;
const KEPT = 400;
const capped = (key: string) => `${Array.from(key).slice(0, KEPT).join('')}#sha256=${createHash('sha256').update(key, 'utf8').digest('hex')}`;

export function up(db: Database) {
  // length() counts characters, as Array.from does.
  const rows = db.prepare('SELECT id, url_key FROM postings WHERE length(url_key) > ?').all(MAX) as Array<{ id: number; url_key: string }>;
  const update = db.prepare('UPDATE postings SET url_key = ? WHERE id = ?');
  for (const r of rows) update.run(capped(r.url_key), r.id);
}
