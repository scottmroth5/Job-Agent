// Stale applications (no reply after the user's stale-application days, Settings > Follow-ups) close as "No response":
// a built-in closed status, after Rejected, and the status list's noResponse role pointing at it (Admin > Lists can point
// it elsewhere). A list that already has a no_response value (a custom one) keeps it and gets the role.

export const id = '018-no-response';

export function up(db) {
  const now = new Date().toISOString();
  const has = db.prepare("SELECT 1 FROM lookup_values WHERE list = 'status' AND id = 'no_response'").get();
  if (!has) {
    const after = db.prepare("SELECT sort_order FROM lookup_values WHERE list = 'status' AND id = 'rejected'").pluck().get();
    const order = after ?? (db.prepare("SELECT MAX(sort_order) FROM lookup_values WHERE list = 'status'").pluck().get() ?? 0) + 10;
    // Make room right after Rejected.
    db.prepare("UPDATE lookup_values SET sort_order = sort_order + 1 WHERE list = 'status' AND sort_order > ?").run(order);
    db.prepare(`INSERT INTO lookup_values (list, id, label, group_key, sort_order, settings_json, origin, created_at, updated_at)
      VALUES ('status', 'no_response', 'No response', 'closed', ?, NULL, 'built_in', ?, ?)`).run(order + 1, now, now);
  }
  db.prepare("INSERT INTO lookup_roles (list, role, value_id) VALUES ('status', 'noResponse', 'no_response') ON CONFLICT (list, role) DO NOTHING").run();
}
