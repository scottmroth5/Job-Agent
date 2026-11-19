// The last migration this code knows, by id (v3 Phase 7): deploy/deploy.sh compares two tags with it before it replaces
// one service of the split layout alone or rolls one back, so a service never runs code for a different schema than the
// others. Opens no database. Prints the id only.
//   node scripts/migrations-list.js
import { loadMigrations } from '../db/index.ts';

const last = loadMigrations().at(-1);
if (!last) {
  console.error('migrations-list: no migrations found');
  process.exitCode = 1;
} else {
  console.log(last.id);
}
