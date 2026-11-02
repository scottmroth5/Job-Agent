// Adds the 'dismissed' review status to emails: Dismiss on the Inbox screen takes an email the user is not sure
// about off the review list with no action and no eval case. Loosens the CHECK in place like 008 (every existing
// row already satisfies the new list), so the table is not rebuilt.

export const id = '019-dismissed-email';

const OLD = "'not_job', 'new_opportunity')";
const NEW = "'not_job', 'new_opportunity', 'dismissed')";

export function up(db) {
  const createSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'emails'").pluck().get();
  if (createSql?.includes(NEW)) return;
  if (!createSql?.includes(OLD) || createSql.split(OLD).length !== 2) {
    throw new Error('019: the emails review_status constraint is not in the expected form; nothing was changed.');
  }

  const version = db.pragma('schema_version', { simple: true });
  db.unsafeMode(true);
  try {
    db.pragma('writable_schema = ON');
    db.prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = 'emails'").run(createSql.replace(OLD, NEW));
    db.pragma(`schema_version = ${version + 1}`);
    db.pragma('writable_schema = OFF');
  } finally {
    db.unsafeMode(false);
  }
  const check = db.pragma('integrity_check', { simple: true });
  if (check !== 'ok') throw new Error(`019: integrity check failed after the schema edit (${check}); rolled back.`);
}
