// Runs job discovery: search every source, dedupe, fetch full text, check location, store.
//   npm run discover                              full run
//   npm run discover -- --dry-run --limit=20      preview, writes nothing
//   npm run discover -- --sources=himalayas,linkedin --no-details
import { createTracer } from '@scottmroth5/agent-core';
import { loadConfig } from '../tools/config.js';
import { createHttp } from '../tools/http.js';
import { createBrowser } from '../tools/browser.js';
import { openJobStore } from '../db/index.js';
import { exitWhenDone } from '../tools/exit.js';
import { assertNoRunningRun } from '../tools/runs.js';
import { runDiscovery, SOURCES } from '../agents/discovery/discover.js';

function parseArgs(argv) {
  const get = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const names = get('sources')?.split(',').map((s) => s.trim().toLowerCase());
  const unknown = names?.filter((n) => !SOURCES[n]);
  if (unknown?.length) throw new Error(`Unknown source(s): ${unknown.join(', ')}. Known: ${Object.keys(SOURCES).join(', ')}`);
  const limit = get('limit');
  return {
    dryRun: argv.includes('--dry-run'),
    details: !argv.includes('--no-details'),
    limit: limit ? Number(limit) : Infinity,
    sources: names ? Object.fromEntries(names.map((n) => [n, SOURCES[n]])) : SOURCES,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const store = openJobStore();
  if (!args.dryRun) {
    try {
      assertNoRunningRun(store.db, 'discover');
    } catch (err) {
      store.close();
      throw err;
    }
  }
  const run = createTracer({ store }).startRun('discover', { dryRun: args.dryRun, sources: Object.keys(args.sources), limit: args.limit });
  const browser = args.details ? await createBrowser() : null;
  if (args.details && !browser) console.log('Playwright is not installed; pages that need JavaScript will be marked needs_browser.');

  try {
    const summary = await runDiscovery({
      store,
      config,
      http: createHttp(),
      browser,
      sources: args.sources,
      options: { dryRun: args.dryRun, limit: args.limit, details: args.details, log: run.log },
    });

    console.log(`\n${args.dryRun ? 'DRY RUN (nothing written). ' : ''}Postings since ${summary.since}:`);
    const rows = Object.entries(summary.bySource).map(([source, s]) => ({
      source,
      requests: s.requests,
      found: s.found,
      relevant: s.relevant,
      fresh: s.fresh,
      duplicates: s.duplicates,
      new: s.new,
      'text ok': s.detailsOk,
      'text failed': s.detailsFailed,
      notes: [s.rateLimited ? 'rate limited' : '', ...s.errors].filter(Boolean).join('; ').slice(0, 80),
    }));
    console.table(rows);
    console.log(`Location checks: ${Object.entries(summary.locationChecks).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
    if (Number.isFinite(args.limit) && summary.newFound > summary.selected) {
      console.log(`Limited to ${summary.selected} of ${summary.newFound} new postings (--limit).`);
    }
    console.log(args.dryRun ? `Would insert ${summary.wouldInsert} postings.` : `Inserted ${summary.inserted} postings; ${summary.upgrades} existing postings upgraded to a better source.`);
    if (summary.retried.attempted) {
      console.log(`Retried full text for ${summary.retried.attempted} earlier postings: ${summary.retried.fixed} fixed.`);
    }
    if (summary.linkedinRateLimited) console.log('LinkedIn rate limited full-text requests; the rest will be retried on the next run.');

    const { insertedIds, ...rest } = summary;
    run.finish(Object.values(summary.bySource).some((s) => s.errors.length || s.rateLimited) ? 'partial' : 'ok', {
      ...rest,
      insertedCount: insertedIds.length,
    });
  } catch (err) {
    run.finish('failed');
    throw err;
  } finally {
    await browser?.close();
    store.close();
  }
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(exitWhenDone);
