// Applies pending PostgreSQL migrations and row security (v3 Phase 5). Production runs it from deploy.sh before the new
// image starts, as the database's owner login (MIGRATE_DATABASE_URL, from backup.env); the app's own login only reads and
// writes rows and starts in deploy mode (DATABASE_MIGRATIONS=deploy), which refuses to run while anything is pending.
//
//   node scripts/migrate.js            MIGRATE_DATABASE_URL, else DATABASE_URL
//
// Prints the migration ids it applied (or none), never the address. Exit 0 done, 1 failed.
import { pathToFileURL } from 'node:url';
import { isPostgresUrl, openPgStore } from '../db/postgres/store.ts';
import { loadMigrations } from '../db/index.ts';

/** @param {NodeJS.ProcessEnv} env */
export async function main(env = process.env) {
  const url = isPostgresUrl(env.MIGRATE_DATABASE_URL) ? env.MIGRATE_DATABASE_URL : isPostgresUrl(env.DATABASE_URL) ? env.DATABASE_URL : null;
  if (!url) {
    console.error('migrate: set MIGRATE_DATABASE_URL (or DATABASE_URL) to the database owner\'s postgres:// address.');
    return 1;
  }
  let store;
  try {
    store = openPgStore(url, { schema: 'public', sqliteIds: loadMigrations().map((m) => m.id) });
    await store.ready;
    console.log(store.applied.length ? `[migrate] applied ${store.applied.join(', ')}` : '[migrate] nothing pending');
    return 0;
  } catch (err) {
    // The kind and code only: a database message can quote a value.
    const e = /** @type {Error & { code?: string }} */ (err);
    console.error(`[migrate] failed: ${e.code ? `${e.name} ${e.code}` : e.message}`);
    return 1;
  } finally {
    store?.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main();
