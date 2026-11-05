// Status roles for the values the app sets itself: where the inbox moves a job for a confirmation, interview request,
// offer, or rejection email (the funnel counts the rejected role as rejected), where duplicate copies close, and where
// cleanup closes jobs never acted on. Each starts on the built-in value the code used to name, so nothing changes until
// Admin > Lists points one elsewhere. A role already set is kept; a value that is missing gets no role.

import type { Database } from '../../tools/types.ts';

export const id = '023-status-roles';

// A copy of the roles and values as of this migration (agents/lookups.ts STATUS_ROLES may change later).
const ROLES: Array<[role: string, valueId: string]> = [
  ['applied', 'applied'],
  ['interview', 'interviewing'],
  ['offer', 'offer'],
  ['rejected', 'rejected'],
  ['duplicate', 'duplicate'],
  ['passed', 'passed'],
];

export function up(db: Database) {
  const has = db.prepare("SELECT 1 FROM lookup_values WHERE list = 'status' AND id = ?");
  const add = db.prepare("INSERT INTO lookup_roles (list, role, value_id) VALUES ('status', ?, ?) ON CONFLICT (list, role) DO NOTHING");
  for (const [role, valueId] of ROLES) if (has.get(valueId)) add.run(role, valueId);
}
