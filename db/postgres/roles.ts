// The three production logins (v3 Phase 5, like Health-Review's): the owner runs migrations, the app reads and writes
// rows, and the backup login only reads (pg_dump). None is a superuser, creates databases or roles, or bypasses row
// security. scripts/db-setup.js runs these once on the database; test/pg-production.test.js runs them on a schema to
// prove the app works as a login that owns nothing.
import { quoteIdent } from './store.ts';

export interface Logins {
  owner: string;
  app: string;
  backup: string;
}

/**
 * What the owner grants on a schema it owns, now and for tables it makes later (ALTER DEFAULT PRIVILEGES): the app
 * gets row reads and writes and the sequences, the backup login reads everything. Run as the owner.
 */
export function grantStatements(schema: string, { owner, app, backup }: Logins): string[] {
  const [s, o, a, b] = [schema, owner, app, backup].map(quoteIdent);
  return [
    `REVOKE CREATE ON SCHEMA ${s} FROM PUBLIC`,
    `GRANT USAGE ON SCHEMA ${s} TO ${a}, ${b}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${s} TO ${a}`,
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${s} TO ${a}`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA ${s} TO ${b}`,
    `GRANT SELECT ON ALL SEQUENCES IN SCHEMA ${s} TO ${b}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${o} IN SCHEMA ${s} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${a}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${o} IN SCHEMA ${s} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${a}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${o} IN SCHEMA ${s} GRANT SELECT ON TABLES TO ${b}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${o} IN SCHEMA ${s} GRANT SELECT ON SEQUENCES TO ${b}`,
  ];
}

/** Production's login names on the shared RDS (scripts/db-setup.js makes them). */
export const JA_LOGINS: Logins = { owner: 'ja_migrate', app: 'ja_app', backup: 'ja_backup' };

/** The options every login is made with: it signs in, and nothing more. */
export const LOGIN_OPTIONS = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
