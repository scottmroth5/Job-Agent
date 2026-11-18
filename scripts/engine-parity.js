// npm run db:parity (v3 Phase 4): the app's rule-based decisions on SQLite and on PostgreSQL, compared. Run it after
// npm run db:to-postgres, on the same data: for every user, the job lists and their filters, one job's panel, the
// summary, funnel, and Today, which jobs scoring would pick, what archive, cleanup, and follow-ups would move (dry runs),
// spending, and which job each stored email's rules link it to. No Claude call is made.
//
//   DATABASE_URL=postgres://... node --env-file=.env scripts/engine-parity.js --from <sqlite file> [--schema <name>]
//
// Both sides must hold the same rows (the copy's check). The SQLite side is a copy in the OS temp folder, since the
// dry runs open transactions; the PostgreSQL side is DATABASE_URL's schema. Output is check names, item counts, and
// match, "same, different order", or DIFFER: never a value. Exit 0 when nothing differs, 2 when something does.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { copyDatabase } from '../db/engine/files.ts';
import { loadMigrations, openJobStore, postgresUrl } from '../db/index.ts';
import { openPgStore } from '../db/postgres/store.ts';
import { runAsUser } from '../db/scope.ts';
import { loadConfig } from '../tools/config.ts';
import { dataPath } from '../tools/paths.ts';
import { localDaysAgo } from '../tools/dates.ts';
import { configFor } from '../agents/user-config.ts';
import { lookups } from '../agents/lookups.ts';
import { getPosting, listPostings, summary } from '../server/queries.ts';
import { applications, funnel } from '../agents/funnel.ts';
import { today } from '../server/today.ts';
import { closeNoResponse, waitingApplications } from '../agents/follow-ups.ts';
import { archiveListings, archiveLongLinks, archivePostings, demoteWithoutText, findDuplicates } from '../agents/hunt/archive.ts';
import { selectPostings } from '../agents/discovery/score.ts';
import { listOpenApplications } from '../agents/inbox/match.ts';
import { decideEmail } from '../agents/inbox/process.ts';
import { loadInboxConfig } from '../agents/inbox/config.ts';
import { budgetStatus, spendByLabel } from '../tools/budget.ts';
/** @import { Db } from '../tools/types.ts' */

/**
 * A value in a form both engines can be compared in: object keys sorted, numbers to 12 significant digits (an
 * average can differ in its last binary digit between engines), Buffers as hex.
 * @param {unknown} v @returns {unknown}
 */
function canonical(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Number(v.toPrecision(12)) : String(v);
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { hex: Buffer.from(v).toString('hex') };
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(canonical);
  if (typeof v === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonical(/** @type {Record<string, unknown>} */ (v)[k]);
    return out;
  }
  return v;
}

/** @typedef {{ check: string, items: number, result: 'match' | 'order' | 'differ' }} Check */

const json = (/** @type {unknown} */ x) => JSON.stringify(x);

/** A canonical value with every list, at every depth, sorted: what is left once order is ignored. @param {unknown} v @returns {unknown} */
function unordered(v) {
  if (Array.isArray(v)) return v.map(unordered).map(json).sort();
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unordered(x)]));
  return v;
}

/** Compares two results. 'order' when they hold the same items with some list in a different order. @param {string} check @param {unknown} a @param {unknown} b @returns {Check} */
export function compare(check, a, b) {
  const [ca, cb] = [canonical(a), canonical(b)];
  const items = Array.isArray(ca) ? ca.length : ca && typeof ca === 'object' ? Object.keys(ca).length : 1;
  if (json(ca) === json(cb)) return { check, items, result: 'match' };
  if (json(unordered(ca)) === json(unordered(cb))) return { check, items, result: 'order' };
  return { check, items, result: 'differ' };
}

/**
 * The decisions for one user, as [check name, fn(db)] pairs. config is that user's settings; now is fixed for both.
 * @param {Db} sample a handle to read the lists and samples from (the SQLite side) @param {import('../tools/config.ts').JobSearchConfig} config @param {Date} now
 * @returns {Promise<Array<[string, (db: Db) => Promise<unknown>]>>}
 */
async function decisions(sample, config, now) {
  const lk = await lookups(sample);
  const inbox = loadInboxConfig();
  const ids = /** @type {number[]} */ (await sample.prepare('SELECT id FROM postings WHERE user_id = @uid ORDER BY id').pluck().all());
  // Every 25th job's panel: notes, scores, history, letters, reminders, and its score details.
  const panelIds = ids.filter((_, i) => i % 25 === 0);
  const emails = /** @type {Array<{ thread_id: string, sender: string, sender_domain: string, subject: string | null, type: string | null, confidence: number | null, posting_id: number | null }>} */ (
    await sample.prepare('SELECT thread_id, sender, sender_domain, subject, type, confidence, posting_id FROM emails WHERE user_id = @uid ORDER BY id').all());
  /** @type {Array<[string, (db: Db) => Promise<unknown>]>} */
  const list = [
    ['jobs: all', (db) => listPostings(db, {}, config)],
    ['jobs: needs a description', (db) => listPostings(db, { needsDescription: true }, config)],
    ['jobs: score 7 and up', (db) => listPostings(db, { minScore: 7 }, config)],
    ['jobs: discovered in the last 30 days', (db) => listPostings(db, { discoveredAfter: localDaysAgo(now, 30) }, config)],
    ['jobs: search "engineering"', (db) => listPostings(db, { q: 'engineering' }, config)],
    ...lk.values('stage').map((v) => /** @type {[string, (db: Db) => Promise<unknown>]} */ ([`jobs: stage ${v.id}`, (db) => listPostings(db, { stage: v.id }, config)])),
    ...lk.values('status').map((v) => /** @type {[string, (db: Db) => Promise<unknown>]} */ ([`jobs: status ${v.id}`, (db) => listPostings(db, { status: v.id }, config)])),
    ...lk.values('track').map((v) => /** @type {[string, (db: Db) => Promise<unknown>]} */ ([`jobs: track ${v.id}`, (db) => listPostings(db, { track: v.id }, config)])),
    [`job panels (${panelIds.length})`, async (db) => await Promise.all(panelIds.map((id) => getPosting(db, id, config)))],
    ['summary', (db) => summary(db, config, now)],
    ['funnel: all time', (db) => funnel(db, { now })],
    ['funnel: last 30 days', (db) => funnel(db, { days: 30, now })],
    ['funnel: last 90 days', (db) => funnel(db, { days: 90, now })],
    ['applications', (db) => applications(db, { now })],
    ['today', (db) => today(db, { now })],
    ['follow-ups waiting', (db) => waitingApplications(db, { now })],
    ['close no response (dry run)', (db) => closeNoResponse(db, { now, dryRun: true })],
    ['scoring would pick', (db) => selectPostings(db)],
    ['scoring would pick (all unscored)', (db) => selectPostings(db, { allUnscored: true })],
    ['archive (dry run)', (db) => archivePostings(db, { now, dryRun: true })],
    ['cleanup: listings and excluded sites (dry run)', (db) => archiveListings(db, { config, now, dryRun: true })],
    ['cleanup: duplicates', (db) => findDuplicates(db)],
    ['cleanup: no description (dry run)', (db) => demoteWithoutText(db, { now, dryRun: true })],
    ['archive long links (dry run)', (db) => archiveLongLinks(db, { now, dryRun: true })],
    ['inbox: open applications', (db) => listOpenApplications(db)],
    [`inbox: rule links for stored emails (${emails.length})`, async (db) => {
      const open = await listOpenApplications(db);
      const out = [];
      for (const e of emails) {
        const email = { threadId: e.thread_id, senderEmail: e.sender, senderDomain: e.sender_domain, subject: e.subject };
        const c = { applicationId: e.posting_id, confidence: e.confidence ?? 0, type: /** @type {never} */ (e.type ?? 'other') };
        out.push(await decideEmail(db, email, c, { cfg: inbox, open }));
      }
      return out;
    }],
  ];
  return list;
}

/** @param {string[]} args */
export async function main(args = process.argv.slice(2)) {
  const opt = (/** @type {string} */ name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const url = postgresUrl();
  if (!url) {
    console.error('engine-parity: set DATABASE_URL to the PostgreSQL copy (npm run db:to-postgres made it).');
    return 1;
  }
  const from = opt('from') ?? dataPath('job-agent.db');
  const dir = mkdtempSync(join(tmpdir(), 'ja-parity-'));
  const copy = join(dir, 'job-agent.db');
  copyDatabase(from, copy);
  // The SQLite side opens with DATABASE_URL out of the way (openJobStore picks the engine from it).
  delete process.env.DATABASE_URL;
  const lite = openJobStore(copy, { snapshot: false, fallbackUid: null });
  const pgStore = openPgStore(url, { schema: opt('schema') ?? 'public', sqliteIds: loadMigrations().map((m) => m.id) });
  /** @type {Check[]} */
  const checks = [];
  try {
    await pgStore.ready;
    const now = new Date();
    const users = /** @type {number[]} */ (await lite.admin.prepare('SELECT id FROM users ORDER BY id').pluck().all());
    const ownerConfig = (() => {
      try {
        return loadConfig();
      } catch {
        return /** @type {import('../tools/config.ts').JobSearchConfig} */ ({ search: {} });
      }
    })();
    for (const uid of users) {
      const config = /** @type {import('../tools/config.ts').JobSearchConfig} */ (/** @type {unknown} */ (await configFor(lite.admin, uid, ownerConfig)));
      await runAsUser(uid, async () => {
        for (const [name, fn] of await decisions(lite.db, config, now)) {
          const check = `user ${uid}: ${name}`;
          let a, b;
          try {
            [a, b] = [await fn(lite.db), await fn(pgStore.db)];
          } catch (err) {
            const e = /** @type {Error & { code?: string }} */ (err);
            checks.push({ check: `${check} (failed: ${e.name}${e.code ? ` ${e.code}` : ''})`, items: 0, result: 'differ' });
            continue;
          }
          checks.push(compare(check, a, b));
        }
      });
      for (const [name, fn] of /** @type {Array<[string, (db: Db) => Promise<unknown>]>} */ ([
        ['spending', (db) => budgetStatus(db, { uid, now, env: {} })],
        ['spending by feature', (db) => spendByLabel(db, { uid, now })],
      ])) checks.push(compare(`user ${uid}: ${name}`, await fn(lite.admin), await fn(pgStore.admin)));
    }
  } finally {
    lite.close();
    pgStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
  for (const c of checks) console.log(`[parity] ${c.check}: ${c.items} items, ${c.result === 'match' ? 'match' : c.result === 'order' ? 'same, different order' : 'DIFFER'}`);
  const differ = checks.filter((c) => c.result === 'differ').length;
  const order = checks.filter((c) => c.result === 'order').length;
  console.log(`[parity] ${checks.length} checks: ${checks.length - differ - order} match, ${order} same but in a different order, ${differ} differ`);
  return differ ? 2 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main();
