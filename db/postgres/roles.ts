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

/**
 * The split layout's logins (v3 Phase 7, decision 0010): one per role, so the database names which service each session
 * is (with PGAPPNAME) and each can be revoked alone. The three workers share one.
 */
export const SERVICE_LOGINS = { api: 'ja_api', worker: 'ja_worker', scheduler: 'ja_scheduler' } as const;
export type ServiceLogin = keyof typeof SERVICE_LOGINS;

/** The options every login is made with: it signs in, and nothing more. */
export const LOGIN_OPTIONS = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';

/** Production's database on the shared RDS: text sorts byte by byte (C collation), as on SQLite. */
export const DATABASE = 'job_agent';
const NAME = /^[a-z][a-z0-9_]{0,40}$/;

/** A pg client, as setupRoles needs it. */
interface SetupClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  escapeLiteral: (s: string) => string;
}

/**
 * The one-time step, connected to the server's postgres database as RDS's master login (scripts/db-setup.js): the three
 * logins (made, or their passwords reset) and the database, owned by the owner login. Running it again never drops
 * anything. Passwords are quoted with escapeLiteral and never logged.
 */
export async function setupRoles(client: SetupClient, { logins = JA_LOGINS, database = DATABASE, passwords }: { logins?: Logins; database?: string; passwords: Record<keyof Logins, string> }) {
  for (const n of [database, ...Object.values(logins)]) if (!NAME.test(n)) throw new TypeError('names: lowercase letters, digits and _ only');
  const q = (n: string) => `"${n}"`;
  for (const key of Object.keys(logins) as Array<keyof Logins>) {
    const pw = passwords[key];
    if (typeof pw !== 'string' || pw.length < 24) throw new TypeError(`setupRoles: the ${key} password must be at least 24 characters`);
    const present = (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [logins[key]])).rows.length > 0;
    await client.query(`${present ? 'ALTER' : 'CREATE'} ROLE ${q(logins[key])} WITH ${LOGIN_OPTIONS} PASSWORD ${client.escapeLiteral(pw)}`);
  }
  if (!(await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database])).rows.length) {
    // CREATE DATABASE ... OWNER needs the caller to act as that owner (PostgreSQL 16+): a membership for this step only.
    await client.query(`GRANT ${q(logins.owner)} TO CURRENT_USER`);
    try {
      await client.query(`CREATE DATABASE ${q(database)} OWNER ${q(logins.owner)} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
    } finally {
      await client.query(`REVOKE ${q(logins.owner)} FROM CURRENT_USER`);
    }
  }
  await client.query(`REVOKE ALL ON DATABASE ${q(database)} FROM PUBLIC`);
  await client.query(`GRANT CONNECT ON DATABASE ${q(database)} TO ${q(logins.app)}, ${q(logins.backup)}`);
}

/**
 * The split layout's logins (scripts/db-setup.js --service-logins), connected as RDS's master login: each made (or its
 * password reset) and made a member of the app login, from which it inherits the row grants (now and for tables later
 * migrations make, through the owner's default privileges) and CONNECT. SET FALSE: a member can never act as the app
 * login itself. Row security applies to each as to the app login. The three Phase 5 logins are never touched.
 */
export async function setupServiceLogins(client: SetupClient, { member = JA_LOGINS.app, logins = SERVICE_LOGINS, passwords }: { member?: string; logins?: Record<ServiceLogin, string>; passwords: Record<ServiceLogin, string> }) {
  for (const n of [member, ...Object.values(logins)]) if (!NAME.test(n)) throw new TypeError('names: lowercase letters, digits and _ only');
  const q = (n: string) => `"${n}"`;
  for (const key of Object.keys(logins) as ServiceLogin[]) {
    const pw = passwords[key];
    if (typeof pw !== 'string' || pw.length < 24) throw new TypeError(`setupServiceLogins: the ${key} password must be at least 24 characters`);
  }
  if (!(await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [member])).rows.length) throw new Error(`setupServiceLogins: the ${member} login does not exist yet`);
  for (const key of Object.keys(logins) as ServiceLogin[]) {
    const present = (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [logins[key]])).rows.length > 0;
    await client.query(`${present ? 'ALTER' : 'CREATE'} ROLE ${q(logins[key])} WITH ${LOGIN_OPTIONS} PASSWORD ${client.escapeLiteral(passwords[key])}`);
    await client.query(`GRANT ${q(member)} TO ${q(logins[key])} WITH INHERIT TRUE, SET FALSE`);
  }
}
