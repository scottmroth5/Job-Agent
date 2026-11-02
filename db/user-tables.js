// Every table whose rows belong to one user, today. test/user-scope.test.js checks each query on these names user_id,
// and the isolation test snapshots them. Migration 013 keeps its own list of the tables it rebuilt; tables added since
// are listed here. usage_totals (020) is deliberately not one: app-wide daily counts with no user id or anything that
// leads back to a person, so account export and deletion have nothing of anyone's to take from it.
import { USER_TABLES as REBUILT_IN_013 } from './migrations/013-users.js';

export const USER_TABLES = [...REBUILT_IN_013, 'feedback', 'resumes'];
