// Starts the Job Hunt server: the one-process app (npm run ui, server/main.ts) or the API service (apps/api.ts, v3
// Phase 7), which leaves the task workers and the scheduler to apps/worker.ts and apps/scheduler.ts.
// Local only (AUTH_MODE=none binds to 127.0.0.1). Google and Claude load on first use; knowledge docs are in the database.
// AUTH_MODE=demo serves the sample database read-only with every outside service off (npm run demo).
import { loadConfig } from '../tools/config.ts';
import { repoPath } from '../tools/paths.ts';
import { openJobStore } from '../db/index.ts';
import { buildApp } from './app.ts';
import { buildServices } from './services.ts';
import { timeZone } from '../tools/dates.ts';
import { countryLookup, geoAllowFromEnv, openGeo, openRelay } from './geo.ts';
import { getSetting } from '../db/settings.ts';
import { syncOwnerEmail } from '../db/users.ts';
import { assertSafeBinding, authSettings } from './auth.ts';
import { graceMs } from './roles.ts';
import type { BuildAppOptions } from './app.ts';

export async function startServer({ roles = {}, service = 'all' }: { roles?: BuildAppOptions['roles']; service?: string } = {}) {
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
  const demo = authMode === 'demo';
  // The owner's account row carries their first allowed address, for the Users screen.
  if (authMode === 'google') await syncOwnerEmail(store.admin, authConfig.allowed);
  const services = buildServices({ store, authConfig, demo });
  // The one-process app's workers get the grace period on a stop (the API service runs none).
  services.shutdownGraceMs = graceMs(service, process.env);

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
  // The admin's usage totals (server/usage-totals.ts): the personal site and demo hosts that name a source.
  const usage = { location: lookups?.location ?? null, siteHost: process.env.SOURCE_SITE_HOST, demoHost: process.env.SOURCE_DEMO_HOST };
  const app = await buildApp({ store, config, services, webDir: repoPath('web', 'dist'), authMode, auth: { settings: authConfig }, trustProxy, geo, usage, roles });

  // The location lists' alerts (an email to the owner, through a notify task) once the app and its queue exist.
  const alerts = app.alerts;
  if (geoAllow.length && !relay) {
    alerts?.alert('geo-relay', 'iCloud Private Relay list missing', "Apple's iCloud Private Relay address list is missing from the server image, so visitors using Private Relay are checked against the location database only, and some in the allowed countries may be refused. Blocking is still on. The next image build (or the weekly rebuild) adds it.", { once: true }).catch(() => {});
  } else if (relay) {
    await alerts?.recovered('geo-relay');
  }
  if (geoAllow.length && !geo.lookup) {
    alerts?.alert('geo-db', 'US-only blocking is off', 'The location database is missing from the server image, so visitors outside the allowed countries are not blocked. The next image build (or the weekly rebuild) adds it.', { once: true }).catch(() => {});
  } else if (geo.lookup) {
    await alerts?.recovered('geo-db');
  }

  await app.listen({ host, port });
  console.log(
    authMode === 'google'
      ? `Job Hunt UI: ${authConfig.publicUrl}  (Google sign-in on; ${authConfig.allowed.length} allowed account${authConfig.allowed.length === 1 ? '' : 's'})`
      : demo
        ? `Job Hunt demo: ${authConfig.publicUrl || `http://localhost:${port}`}  (read-only sample data; Claude, Gmail and Drive off)`
        : `Job Hunt UI: http://localhost:${port}  (API contract: http://localhost:${port}/api/openapi.json)`,
  );
  console.log(`Time zone: ${timeZone()}${process.env.TZ ? '' : ' (the computer\'s; set TZ in .env to fix it, e.g. TZ=America/Chicago)'}`);
  if (service !== 'all') console.log(`Service: ${service} (task workers: ${roles.workers === false ? 'apps/worker.ts' : 'here'}; scheduler: ${roles.scheduler === false ? 'apps/scheduler.ts' : 'here'})`);
  const schedules = services.schedules ?? [];
  if (roles.scheduler !== false) {
    console.log(
      schedules.length
        ? `Scheduled (pipeline and inbox are the owner's defaults until saved under Settings > Automatic runs): ${schedules.map((j) => `${j.name} ${j.schedule.spec}`).join('; ')}`
        : 'Scheduled: nothing from .env (SCHEDULE_BACKUP runs backups; pipelines and inbox checks are set under Settings > Automatic runs)',
    );
  }

  // The cloud demo's PostgreSQL (deploy/compose.yml demo-db) keeps its data in memory: if it restarts on its own it comes
  // back empty, and the demo would answer every page with an error while /healthz still passes. Once a minute the
  // demo checks its sample data is still there; if not, it exits, and its restart policy rebuilds the data.
  if (demo && store.engine === 'postgres') {
    const watch = setInterval(() => {
      void getSetting(store.admin, 'demo_database')
        .catch(() => null)
        .then((marker) => {
          if (marker === 'true') return;
          console.error('[demo] the sample data is gone (its database restarted); exiting so the demo rebuilds it');
          process.exit(1);
        });
    }, 60_000);
    watch.unref();
  }

  // A stop (Ctrl+C, or docker stop's SIGTERM on a deploy): no new requests, and running tasks get the grace period
  // (server/roles.ts) to finish before they are requeued or failed visibly.
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    store.close();
    process.exit(0);
  };
  // void: shutdown ends the process either way; the signal handler has nothing to wait for.
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  return app;
}
