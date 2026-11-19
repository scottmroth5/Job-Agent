// Creates Job-Agent's database and its three logins on the shared RDS (v3 Phase 5, as Health-Review does;
// db/postgres/roles.ts). The owner runs it through infra/db-setup.ps1, which opens an SSM port forward to RDS and passes
// everything in environment variables; nothing is written to disk, and no password or address is printed.
//   DB_SETUP_PORT     the local end of the port forward
//   DB_SETUP_HOST     the RDS host name: the certificate is checked against it (verify-full), though the socket is local
//   DB_SETUP_CA       the RDS certificate bundle file
//   DB_MASTER_USER, DB_MASTER_PASSWORD                         RDS's master login (from Secrets Manager)
//   JA_MIGRATE_PASSWORD, JA_APP_PASSWORD, JA_BACKUP_PASSWORD   the three logins' new passwords
// Then, as the owner login: the schema's grants (grantStatements). The tables come with the first deploy's migrate.js.
//
// --service-logins (v3 Phase 7, infra/db-setup.ps1 -ServiceLogins): only the split layout's logins (ja_api, ja_worker,
// ja_scheduler; setupServiceLogins), each a member of ja_app, with JA_API_PASSWORD, JA_WORKER_PASSWORD and
// JA_SCHEDULER_PASSWORD. The three logins above and the database are left as they are.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { DATABASE, grantStatements, JA_LOGINS, SERVICE_LOGINS, setupRoles, setupServiceLogins } from '../db/postgres/roles.ts';

/** @param {string} name */
const need = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

/** @param {string} user @param {string} password @param {string} database */
async function connect(user, password, database) {
  const client = new pg.Client({
    host: '127.0.0.1',
    port: Number(need('DB_SETUP_PORT')),
    user,
    password,
    database,
    ssl: { ca: readFileSync(need('DB_SETUP_CA'), 'utf8'), servername: need('DB_SETUP_HOST'), rejectUnauthorized: true },
  });
  await client.connect();
  return client;
}

async function serviceLogins() {
  const passwords = { api: need('JA_API_PASSWORD'), worker: need('JA_WORKER_PASSWORD'), scheduler: need('JA_SCHEDULER_PASSWORD') };
  const master = await connect(need('DB_MASTER_USER'), need('DB_MASTER_PASSWORD'), 'postgres');
  try {
    await setupServiceLogins(master, { passwords });
    console.log(`db-setup: service logins ready (${Object.values(SERVICE_LOGINS).join(', ')}), each a member of ${JA_LOGINS.app}`);
  } finally {
    await master.end();
  }
}

async function main() {
  if (process.argv.includes('--service-logins')) return await serviceLogins();
  const passwords = { owner: need('JA_MIGRATE_PASSWORD'), app: need('JA_APP_PASSWORD'), backup: need('JA_BACKUP_PASSWORD') };
  const master = await connect(need('DB_MASTER_USER'), need('DB_MASTER_PASSWORD'), 'postgres');
  try {
    await setupRoles(master, { passwords });
    console.log(`db-setup: logins ready (${Object.values(JA_LOGINS).join(', ')}); database ${DATABASE} ready`);
  } finally {
    await master.end();
  }
  const owner = await connect(JA_LOGINS.owner, passwords.owner, DATABASE);
  try {
    for (const sql of grantStatements('public', JA_LOGINS)) await owner.query(sql);
    console.log('db-setup: grants applied (app: rows only; backup: read only)');
  } finally {
    await owner.end();
  }
}

main().catch((err) => {
  // PostgreSQL's messages name logins and objects, never passwords; no address is built here.
  console.error(`db-setup failed: ${err.name}: ${err.message}`);
  process.exitCode = 1;
});
