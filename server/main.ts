// Starts the Job Hunt UI server: npm run ui, then open http://localhost:5178
// Local only (AUTH_MODE=none binds to 127.0.0.1). Google and Claude load on first use; knowledge docs are in the database.
// AUTH_MODE=demo serves the sample database read-only with every outside service off (npm run demo).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createJobClaude } from '../tools/claude.ts';
import { loadConfig } from '../tools/config.ts';
import { createHttp } from '../tools/http.ts';
import { createBrowser } from '../tools/browser.ts';
import { getGoogleAuth, getInboxAuth } from '../tools/google/auth.ts';
import { createGmail } from '../agents/inbox/gmail.ts';
import { loadInboxConfig } from '../agents/inbox/config.ts';
import { loadKey } from '../agents/inbox/crypto.ts';
import { createDriveClient } from '../tools/google/drive.ts';
import { repoPath, ROOT } from '../tools/paths.ts';
import { openJobStore } from '../db/index.ts';
import { buildApp } from './app.ts';
import { schedulesFromEnv } from './scheduler.ts';
import { timeZone } from '../tools/dates.ts';
import { countryLookup, geoAllowFromEnv, openGeo, openRelay } from './geo.ts';
import { createAlerts } from './alerts.ts';
import { createNotices } from './notices.ts';
import { claimSetting } from '../db/settings.ts';
import { getUser, OWNER_ID, syncOwnerEmail } from '../db/users.ts';
import { sendEmail } from '../tools/google/gmail.ts';
import { assertSafeBinding, authSettings } from './auth.ts';
import { SAMPLE_TASKS } from '../demo/sample-data.ts';
import type { AppServices, RunScript } from './app.ts';
import type { Notices } from './types.ts';
import type { BudgetExceededError } from '../agents/budget.ts';
import type { User } from '../db/users.ts';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 5178);
const authConfig = authSettings(process.env);
const authMode = authConfig.mode;
assertSafeBinding({ host, mode: authMode, settings: authConfig });

const config = loadConfig();
// No fallback user: a query on a user table outside a request or scheduled job throws (db/scope.ts).
const store = openJobStore(undefined, { fallbackUid: null });
// On PostgreSQL the store connects and migrates first: a bad address or a failed migration stops the start here.
await store.ready;
// The demo runs on sample data with no accounts: no Google sign-in, Claude client, browser, or schedule, so a
// visitor can never reach a real account or spend money, even through a route the read-only check missed.
const demo = authMode === 'demo';
const auth = demo ? null : getGoogleAuth();
/** The owner's Google sign-in: everything that uses it runs outside the demo, where auth is set. */
type GoogleAuth = NonNullable<typeof auth>;

// Account emails (server/notices.ts): to the owner, or to a person about their own account; never anyone else.
const notices: Notices = demo
  ? {}
  : createNotices({ send: (email) => sendEmail(auth as GoogleAuth, email), owner: () => process.env.EMAIL_ADDRESS || null, appUrl: () => authConfig.publicUrl ?? '' });
// A user on the owner's key who uses up their allowance, and the owner, hear about it once a month.
const onCapReached = async (uid: number, error: Error) => {
  const err = error as BudgetExceededError; // the cap's refusal (tools/claude.ts)
  if (uid === OWNER_ID || err.scope !== 'user') return;
  const key = `allowance-notice:${uid}`;
  // The check and the mark are one transaction, so two refusals at once send one notice.
  if (!(await claimSetting(store.admin, key, err.status.month, (last) => last !== err.status.month))) return;
  await notices.allowanceReached?.((await getUser(store.admin, uid)) as User, err.status); // a user on the owner's key has a row
};
// The owner's account row carries their first allowed address, for the Users screen.
if (authMode === 'google') await syncOwnerEmail(store.admin, authConfig.allowed);
const realServices = (): AppServices => ({
  claude: createJobClaude(store.db, { onCapReached }),
  notices,
  http: createHttp(),
  drive: createDriveClient(auth as GoogleAuth),
  createBrowser: () => createBrowser(),
  // The Run pipeline button and the scheduler: the same scripts as npm run pipeline and npm run backup, each in its
  // own process so a long run never blocks the server.
  runScript: ({ script, args = [], onLine, onError = () => {} }) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ['--env-file-if-exists=.env', script, ...args], { cwd: ROOT, env: process.env, windowsHide: true });
      let lastError: string | null = null;
      createInterface({ input: child.stdout }).on('line', onLine);
      createInterface({ input: child.stderr }).on('line', (l) => {
        if (l.trim()) lastError = l.trim().slice(0, 300);
        onError(l);
      });
      child.on('error', (err) => resolve({ code: 1, lastError: err.message }));
      child.on('close', (code) => resolve({ code: code ?? 1, lastError }));
    }),
  // Each user's own pipeline: the script runs as them (--user), with their settings, background, and Claude key.
  // args are only the step flags (agents/automation.ts skipArgs); nothing else reaches the command line.
  runPipeline: ({ user, args = [], ...opts }) =>
    (services.runScript as RunScript)({ ...opts, script: 'scripts/pipeline.js', args: [...(user ? [`--user=${Number(user)}`] : []), ...args.filter((a) => a === '--no-score' || a === '--no-letters')] }),
  schedules: schedulesFromEnv(process.env),
  inbox: {
    ready: () => Boolean(process.env.GMAIL_REFRESH_TOKEN && process.env.EMAIL_ENC_KEY),
    gmail: (opts = {}) => createGmail({ auth: getInboxAuth(), ...opts }),
    key: () => loadKey(),
    cfg: loadInboxConfig(),
  },
  // Failure emails (server/alerts.ts), only ever to the owner's own address, like the run report.
  alerts: createAlerts({
    db: store.db,
    send: (email) => sendEmail(auth as GoogleAuth, email),
    to: () => process.env.EMAIL_ADDRESS || null,
    appUrl: () => authConfig.publicUrl ?? '',
  }),
});

const demoOff = () => {
  throw Object.assign(new Error('Turned off in the demo.'), { statusCode: 403 });
};
const demoServices = (): AppServices => ({
  claude: null,
  http: null,
  drive: null,
  createBrowser: null,
  runScript: async () => ({ code: 1, lastError: 'Turned off in the demo.' }),
  runPipeline: async () => ({ code: 1, lastError: 'Turned off in the demo.' }),
  schedules: [],
  inbox: { ready: () => false, gmail: demoOff, key: demoOff, cfg: loadInboxConfig() },
  sampleTasks: SAMPLE_TASKS,
});

const services = demo ? demoServices() : realServices();

// TRUST_PROXY: set behind a reverse proxy so client addresses (for rate limits) come from X-Forwarded-For: the proxy's
// addresses, e.g. "loopback,linklocal,uniquelocal" for Caddy on a private network. Never a hop count ("1"): Fastify
// then reports the proxy as every visitor (test/proxy.test.js). Unset: the direct connection's address.
const trustProxy = !process.env.TRUST_PROXY ? false : process.env.TRUST_PROXY === 'true' ? true : /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY;
// US-only access (GEO_ALLOW, server/geo.ts) and the usage totals' locations: the location database ships in the image;
// without it nothing is blocked and locations count as unknown. The demo never opens it (it counts nothing).
const geoAllow = geoAllowFromEnv();
const lookups = geoAllow.length || authMode === 'google' ? await openGeo().catch(() => null) : null;
// Apple's iCloud Private Relay list comes first for the country check; DB-IP decides for every other address.
const relayStarted = Date.now();
const relay = geoAllow.length ? (() => { try { return openRelay(); } catch { return null; } })() : null;
const geo = { allow: geoAllow, lookup: lookups?.country ? countryLookup({ relay: relay?.country, dbip: lookups.country }) : null };
if (geoAllow.length) console.log(geo.lookup ? `[geo] only ${geoAllow.join(', ')} allowed` : '[geo] the location database is missing: nothing is blocked (the next image build adds it)');
if (geoAllow.length) {
  console.log(relay
    ? `[geo] iCloud Private Relay list: ${relay.v4} IPv4 and ${relay.v6} IPv6 ranges (${Date.now() - relayStarted} ms)`
    : '[geo] the iCloud Private Relay list is missing: relay visitors are checked against the location database only (the next image build adds it)');
}
if (geoAllow.length && !relay) {
  services.alerts?.alert('geo-relay', 'iCloud Private Relay list missing', "Apple's iCloud Private Relay address list is missing from the server image, so visitors using Private Relay are checked against the location database only, and some in the allowed countries may be refused. Blocking is still on. The next image build (or the weekly rebuild) adds it.", { once: true }).catch(() => {});
} else if (relay) {
  await services.alerts?.recovered('geo-relay');
}
if (geoAllow.length && !geo.lookup) {
  services.alerts?.alert('geo-db', 'US-only blocking is off', 'The location database is missing from the server image, so visitors outside the allowed countries are not blocked. The next image build (or the weekly rebuild) adds it.', { once: true }).catch(() => {});
} else if (geo.lookup) {
  await services.alerts?.recovered('geo-db');
}
// The admin's usage totals (server/usage-totals.ts): the personal site and demo hosts that name a source.
const usage = { location: lookups?.location ?? null, siteHost: process.env.SOURCE_SITE_HOST, demoHost: process.env.SOURCE_DEMO_HOST };
const app = await buildApp({ store, config, services, webDir: repoPath('web', 'dist'), authMode, auth: { settings: authConfig }, trustProxy, geo, usage });
await app.listen({ host, port });
console.log(
  authMode === 'google'
    ? `Job Hunt UI: ${authConfig.publicUrl}  (Google sign-in on; ${authConfig.allowed.length} allowed account${authConfig.allowed.length === 1 ? '' : 's'})`
    : demo
      ? `Job Hunt demo: ${authConfig.publicUrl || `http://localhost:${port}`}  (read-only sample data; Claude, Gmail and Drive off)`
      : `Job Hunt UI: http://localhost:${port}  (API contract: http://localhost:${port}/api/openapi.json)`,
);
console.log(`Time zone: ${timeZone()}${process.env.TZ ? '' : ' (the computer\'s; set TZ in .env to fix it, e.g. TZ=America/Chicago)'}`);
const schedules = services.schedules ?? [];
console.log(
  schedules.length
    ? `Scheduled (pipeline and inbox are the owner's defaults until saved under Settings > Automatic runs): ${schedules.map((j) => `${j.name} ${j.schedule.spec}`).join('; ')}`
    : 'Scheduled: nothing from .env (SCHEDULE_BACKUP runs backups; pipelines and inbox checks are set under Settings > Automatic runs)',
);

const shutdown = async () => {
  await app.close();
  store.close();
  process.exit(0);
};
// void: shutdown ends the process either way; the signal handler has nothing to wait for.
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
