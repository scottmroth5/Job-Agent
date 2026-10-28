// Every table whose rows belong to one user, today. test/user-scope.test.js checks each query on these names user_id,
// and the isolation test snapshots them. Migration 013 keeps its own list of the tables it rebuilt; tables added since
// are listed here.
import { USER_TABLES as REBUILT_IN_013 } from './migrations/013-users.js';

export const USER_TABLES = [...REBUILT_IN_013, 'feedback', 'resumes'];
