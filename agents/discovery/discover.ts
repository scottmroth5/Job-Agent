// One discovery run: collect from every source, filter, dedupe against the database and
// within the run, fetch full text for new postings, check location, and store them.
// Scoring is a separate step (Phase 2c).
import { normalizeUrl } from '../../tools/urls.ts';
import { localDay, localDaysAgo } from '../../tools/dates.ts';
import { identityKey, storedKey } from '../identity.ts';
import { keywordMatcher } from '../../tools/titles.ts';
import { checkLocation } from '../../tools/location.ts';
import { detectTrack } from '../../tools/track.ts';
import { parseRate, parseHours } from '../../tools/rates.ts';
import { skipReason } from '../../tools/listings.ts';
import { withoutPictographs } from '../../tools/text.ts';
import { resolveDetails, RETRYABLE } from './details.ts';
import * as himalayas from './sources/himalayas.ts';
import * as remoteok from './sources/remoteok.ts';
import * as fractionaljobs from './sources/fractionaljobs.ts';
import * as linkedin from './sources/linkedin.ts';
import * as serper from './sources/serper.ts';
import { lookups, sqlList } from '../lookups.ts';
import type { Http } from '../../tools/http.ts';
import type { JobSearchConfig } from '../../tools/config.ts';
import type { LocationCheck } from '../../tools/location.ts';
import type { JobStore } from '../../tools/types.ts';
import type { DetailsState } from './details.ts';
import type { JobItem, PageRenderer, SourceContext, SourceResult } from './types.ts';

/** A job source module: its name and its search. */
export interface Source {
  SOURCE: string;
  search(ctx: SourceContext): Promise<SourceResult>;
}

/** An item during one run: the track and location check are added here; id is set on earlier postings retried. */
type RunItem = JobItem & { track?: string; locationCheck?: LocationCheck; id?: number };

/** Per-source counts for the run summary. */
interface SourceStats {
  requests: number;
  found: number;
  relevant: number;
  fresh: number;
  duplicates: number;
  new: number;
  detailsOk: number;
  detailsFailed: number;
  errors: string[];
  rateLimited: boolean;
}

/** What a stored posting this run found again looks like. */
type Existing = { id: number; source: string | null; stage: string };

/** Sources in priority order: when the same job appears in several, the earlier source wins. */
export const SOURCES: Record<string, Source> = { himalayas, remoteok, fractionaljobs, linkedin, serper };
export const PRIORITY = [himalayas.SOURCE, remoteok.SOURCE, fractionaljobs.SOURCE, linkedin.SOURCE, serper.GO_FRACTIONAL, serper.SOURCE];

/** Fills track, rate and hours on an item from what the source and details gave. */
function applyTrack(item: RunItem) {
  item.rate ??= parseRate(item.rateText);
  item.hours ??= parseHours(item.hoursText);
  item.track = detectTrack({ ...item, hoursMax: item.hours?.max });
  return item;
}
const rank = (source: string | null) => {
  const i = PRIORITY.indexOf(source as string);
  return i === -1 ? PRIORITY.length : i;
};

const UNKNOWN_COMPANY = '(unknown)';
const knownCompany = (c: string | null | undefined): c is string => Boolean(c && c !== UNKNOWN_COMPANY && c.toLowerCase() !== 'see posting');


/** Runs async tasks with a concurrency limit and a pause after each task. */
async function mapLimit<T>(items: T[], limit: number, pauseMs: number, sleep: (ms: number) => Promise<unknown>, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
      if (pauseMs) await sleep(pauseMs);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Resolves details for many items. LinkedIn's endpoint rate-limits quickly, so its requests run
 * one at a time with a longer pause, alongside the other sites at normal concurrency.
 */
async function resolveAll(
  items: RunItem[],
  { http, browser, state, concurrency, pauseMs, linkedinPauseMs, onDone }: {
    http: Http;
    browser: PageRenderer | null;
    state: DetailsState;
    concurrency: number;
    pauseMs: number;
    linkedinPauseMs: number;
    onDone: (item: RunItem) => void;
  },
) {
  const viaLinkedIn = items.filter((i) => i.linkedinJobId);
  const others = items.filter((i) => !i.linkedinJobId);
  const run = async (item: RunItem) => {
    await resolveDetails(item, { http, browser, state });
    onDone(item);
  };
  await Promise.all([
    mapLimit(viaLinkedIn, 1, linkedinPauseMs, http.sleep, run),
    mapLimit(others, concurrency, pauseMs, http.sleep, run),
  ]);
}

const MAX_FETCH_ATTEMPTS = 3;

/**
 * One run. http is from createHttp(), browser from createBrowser() or null, sources maps a name to a source module
 * (SOURCES by default). Returns a summary with per-source counts, location results, and the inserted postings.
 */
export async function runDiscovery({ store, config, http, browser = null, sources = SOURCES, now = new Date(), options = {} }: {
  store: Pick<JobStore, 'db' | 'tx'>;
  config: JobSearchConfig;
  http: Http;
  browser?: PageRenderer | null;
  sources?: Record<string, Source>;
  now?: Date;
  options?: {
    dryRun?: boolean;
    limit?: number;
    details?: boolean;
    maxAgeDays?: number;
    concurrency?: number;
    pauseMs?: number;
    linkedinPauseMs?: number;
    retryPending?: boolean;
    log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  };
}) {
  const {
    dryRun = false,
    limit = Infinity,
    details = true,
    maxAgeDays = 7,
    concurrency = 3,
    pauseMs = 1000,
    linkedinPauseMs = 3000,
    retryPending = true,
    log = () => {},
  } = options;
  const { db } = store;
  const today = localDay(now);
  const since = localDaysAgo(now, maxAgeDays);
  const fullTimeRelevant = keywordMatcher(config.search.relevantTitleKeywords);
  const fractionalRelevant = keywordMatcher(config.search.fractionalTitleKeywords ?? []);
  // Fractional items also pass on the fractional keywords (e.g. CISO), which full-time searches do not target.
  const relevant = (item: JobItem) => fullTimeRelevant(item.title) || (detectTrack(item) === 'fractional' && fractionalRelevant(item.title));
  const noise = keywordMatcher(config.search.noiseTitleKeywords ?? []);

  const bySource: Record<string, SourceStats> = {};
  const stat = (source: string) =>
    (bySource[source] ??= { requests: 0, found: 0, relevant: 0, fresh: 0, duplicates: 0, new: 0, detailsOk: 0, detailsFailed: 0, errors: [], rateLimited: false });

  // 1. Collect, in priority order
  const collected: RunItem[] = [];
  const ordered = Object.values(sources).sort((a, b) => rank(a.SOURCE) - rank(b.SOURCE));
  for (const source of ordered) {
    const s = stat(source.SOURCE);
    try {
      const res = await source.search({ http, config });
      Object.assign(s, { requests: res.requests, found: res.items.length, errors: res.errors, rateLimited: res.rateLimited });
      collected.push(...res.items);
      log('info', `${source.SOURCE}: ${res.items.length} found in ${res.requests} requests${res.rateLimited ? ' (rate limited)' : ''}`);
    } catch (err) {
      s.errors.push((err as Error).message);
      log('warn', `${source.SOURCE} failed: ${(err as Error).message}`);
    }
  }

  // 2-3. Filter by title and age
  const candidates = collected.filter((item) => {
    const s = stat(item.source);
    if (!item.title || !relevant(item) || noise(item.title) || skipReason(item, config)) return false;
    s.relevant += 1;
    if (item.postedOn && item.postedOn < since) return false;
    s.fresh += 1;
    return true;
  });

  // 4. Dedupe against the database and within this run
  const byUrl = db.prepare('SELECT id, source, stage FROM postings WHERE url_key = ? AND user_id = @uid');
  const byCompanyTitle = db.prepare('SELECT id, source, stage FROM postings WHERE company_title_key = ? AND user_id = @uid ORDER BY id LIMIT 1');
  const sightings: Array<{ postingId: number; source: string; url: string | null }> = [];
  const upgrades: Array<{ id: number; item: RunItem }> = []; // existing discovered postings that a higher-priority source found again
  const seenUrl = new Set<string>();
  const seenCt = new Set<string>();
  const fresh: RunItem[] = [];

  const findExisting = (item: RunItem) => {
    const urlKey = normalizeUrl(item.url);
    const ctKey = identityKey(item);
    const existing = ((urlKey && byUrl.get(urlKey)) || (ctKey && byCompanyTitle.get(ctKey)) || null) as Existing | null;
    return { urlKey, ctKey, existing };
  };
  const recordDuplicate = (item: RunItem, existing: Existing) => {
    stat(item.source).duplicates += 1;
    sightings.push({ postingId: existing.id, source: item.source, url: item.url });
    if (lookups(db).groupOf('stage', existing.stage) === 'found' && rank(item.source) < rank(existing.source)) upgrades.push({ id: existing.id, item });
  };

  for (const item of candidates) {
    const { urlKey, ctKey, existing } = findExisting(item);
    if (existing) {
      recordDuplicate(item, existing);
      continue;
    }
    if ((urlKey && seenUrl.has(urlKey)) || (ctKey && seenCt.has(ctKey))) {
      stat(item.source).duplicates += 1;
      continue;
    }
    if (urlKey) seenUrl.add(urlKey);
    if (ctKey) seenCt.add(ctKey);
    fresh.push(item);
  }
  const selected = fresh.slice(0, limit);

  // 5. Full text for new postings
  const state: DetailsState = {};
  if (details) {
    if (selected.length) log('info', `Fetching full text for ${selected.length} new postings`);
    let done = 0;
    await resolveAll(selected, {
      http,
      browser,
      state,
      concurrency,
      pauseMs,
      linkedinPauseMs,
      onDone: (item) => {
        stat(item.source)[item.fetchStatus === 'ok' ? 'detailsOk' : 'detailsFailed'] += 1;
        done += 1;
        if (done % 5 === 0 && done < selected.length) log('info', `Full text ${done}/${selected.length}`);
      },
    });
  } else {
    for (const item of selected) Object.assign(item, { fetchStatus: item.description ? 'ok' : 'skipped', fetchMethod: item.description ? 'source' : null });
  }

  // Details can reveal the company (Serper results); drop jobs that turn out to be duplicates.
  const toInsert: RunItem[] = [];
  const seenAfter = new Set<string>();
  for (const item of selected) {
    if (skipReason(item, config)) continue; // a Google redirect resolved to a skipped site or a list of jobs
    const { ctKey, existing } = findExisting(item);
    if (existing) {
      recordDuplicate(item, existing);
      continue;
    }
    if (ctKey && seenAfter.has(ctKey)) {
      stat(item.source).duplicates += 1;
      continue;
    }
    if (ctKey) seenAfter.add(ctKey);
    // 6. Location check, and full-time vs fractional track with parsed pay and hours
    item.locationCheck = checkLocation({ location: item.location, workplace: item.workplace, text: item.description }, config.search.homeLocations);
    applyTrack(item);
    stat(item.source).new += 1;
    toInsert.push(item);
  }

  const locationChecks: Record<string, number> = {};
  // Every item in toInsert has its location check (step 6).
  for (const item of toInsert) locationChecks[item.locationCheck as string] = (locationChecks[item.locationCheck as string] ?? 0) + 1;

  // 7. Store
  const insertedIds: number[] = [];
  if (!dryRun) {
    const nowIso = now.toISOString();
    const found = sqlList(lookups(db).ids('stage', 'found'));
    const insert = db.prepare(`INSERT INTO postings
      (user_id, url, url_key, company, title, company_title_key, source, location, salary, job_type, posted_on, posted_raw,
       discovered_on, stage, status, fetched_text, fetched_at, fetch_status, fetch_method, fetch_attempts, workplace, location_check,
       source_job_id, track, rate_text, rate_min, rate_max, rate_unit, hours_min, hours_max, extra_json, created_at, updated_at)
      VALUES (@uid, @url, @url_key, @company, @title, @company_title_key, @source, @location, @salary, @job_type, @posted_on, @posted_raw,
       @discovered_on, @stage, @status, @fetched_text, @fetched_at, @fetch_status, @fetch_method, @fetch_attempts, @workplace, @location_check,
       @source_job_id, @track, @rate_text, @rate_min, @rate_max, @rate_unit, @hours_min, @hours_max, @extra_json, @now, @now)`);
    const history = db.prepare(`INSERT INTO status_history (user_id, posting_id, from_status, to_status, changed_by, changed_at) VALUES (@uid, ?, NULL, ?, 'agent', ?)`);
    const sighting = db.prepare('INSERT OR IGNORE INTO posting_sightings (user_id, posting_id, source, url, seen_on) VALUES (@uid, ?, ?, ?, ?)');
    const upgrade = db.prepare(`UPDATE postings SET url = @url, url_key = @url_key, source = @source,
        fetched_text = COALESCE(fetched_text, @fetched_text), location = COALESCE(location, @location),
        salary = COALESCE(salary, @salary), posted_on = COALESCE(posted_on, @posted_on),
        workplace = COALESCE(workplace, @workplace), updated_at = @now
      WHERE id = @id AND user_id = @uid AND stage IN ${found}`);

    store.tx(() => {
      for (const item of toInsert) {
        const company = knownCompany(item.company) ? withoutPictographs(item.company) : UNKNOWN_COMPANY;
        const id = Number(
          insert.run({
            url: item.url,
            url_key: normalizeUrl(item.url),
            company,
            title: withoutPictographs(item.title),
            company_title_key: storedKey({ company, title: withoutPictographs(item.title) }),
            source: item.source,
            location: item.location ?? null,
            salary: item.salary ?? null,
            job_type: item.jobType ?? null,
            posted_on: item.postedOn ?? null,
            posted_raw: item.postedOn ?? null,
            discovered_on: today,
            fetched_text: item.description ?? null,
            fetched_at: item.description ? nowIso : null,
            fetch_status: item.fetchStatus ?? null,
            fetch_method: item.fetchMethod ?? null,
            fetch_attempts: details && item.fetchMethod !== 'source' ? 1 : 0,
            workplace: item.workplace ?? null,
            location_check: item.locationCheck,
            source_job_id: item.sourceJobId ?? null,
            track: item.track ?? lookups(db).role('track', 'default'),
            stage: lookups(db).role('stage', 'default'),
            status: lookups(db).role('status', 'default'),
            rate_text: item.rateText ?? null,
            rate_min: item.rate?.min ?? null,
            rate_max: item.rate?.max ?? null,
            rate_unit: item.rate?.unit ?? null,
            hours_min: item.hours?.min ?? null,
            hours_max: item.hours?.max ?? null,
            extra_json: item.extra && Object.keys(item.extra).length ? JSON.stringify(item.extra) : null,
            now: nowIso,
          }).lastInsertRowid,
        );
        history.run(id, lookups(db).role('status', 'default'), nowIso);
        sighting.run(id, item.source, item.url ?? null, today);
        insertedIds.push(id);
      }
      for (const s of sightings) sighting.run(s.postingId, s.source, s.url ?? null, today);
      for (const { id, item } of upgrades) {
        try {
          upgrade.run({
            id,
            url: item.url,
            url_key: normalizeUrl(item.url),
            source: item.source,
            fetched_text: item.description ?? null,
            location: item.location ?? null,
            salary: item.salary ?? null,
            posted_on: item.postedOn ?? null,
            workplace: item.workplace ?? null,
            now: nowIso,
          });
        } catch {
          // another posting already owns that URL; keep the existing primary source
        }
      }
    });
  }

  // 8. Retry recent postings whose full text failed on an earlier run (rate limits, timeouts)
  const retried = { attempted: 0, fixed: 0 };
  if (!dryRun && details && retryPending) {
    const pending = db
      .prepare(`SELECT id, url, company, title, location, workplace, source_job_id, source FROM postings
        WHERE user_id = @uid AND stage IN ${sqlList(lookups(db).ids('stage', 'found'))} AND fetch_status IN (${RETRYABLE.map(() => '?').join(', ')})
          AND fetch_attempts < ? AND discovered_on >= ?
          ${insertedIds.length ? `AND id NOT IN (${insertedIds.map(() => '?').join(', ')})` : ''}`)
      .all(...RETRYABLE, MAX_FETCH_ATTEMPTS, since, ...insertedIds) as Array<{ id: number; url: string | null; company: string; title: string; location: string | null; workplace: string | null }>;
    // These need no source: resolveDetails and the update below do not read it.
    const items = pending.map((p) => ({
      id: p.id,
      url: p.url,
      company: knownCompany(p.company) ? p.company : null,
      title: p.title,
      location: p.location,
      workplace: p.workplace,
      linkedinJobId: linkedin.jobIdFromUrl(p.url),
      description: null,
    })) as RunItem[];
    if (items.length) log('info', `Retrying full text for ${items.length} earlier postings`);
    const update = db.prepare(`UPDATE postings SET fetched_text = @text, fetched_at = @fetchedAt, fetch_status = @status,
        fetch_method = @method, fetch_attempts = fetch_attempts + 1, location = COALESCE(location, @location),
        workplace = COALESCE(workplace, @workplace), location_check = @locationCheck,
        company = CASE WHEN company = '${UNKNOWN_COMPANY}' AND @company IS NOT NULL THEN @company ELSE company END,
        company_title_key = CASE WHEN company = '${UNKNOWN_COMPANY}' AND @company IS NOT NULL THEN @ctKey ELSE company_title_key END,
        updated_at = @now WHERE id = @id AND user_id = @uid`);
    await resolveAll(items, {
      http,
      browser,
      state,
      concurrency,
      pauseMs,
      linkedinPauseMs,
      onDone: (item) => {
        retried.attempted += 1;
        if (item.fetchStatus === 'ok') retried.fixed += 1;
        const nowIso = new Date().toISOString();
        update.run({
          id: item.id,
          text: item.description ?? null,
          fetchedAt: item.description ? nowIso : null,
          status: item.fetchStatus,
          method: item.fetchMethod ?? null,
          location: item.location ?? null,
          workplace: item.workplace ?? null,
          locationCheck: checkLocation({ location: item.location, workplace: item.workplace, text: item.description }, config.search.homeLocations),
          company: item.company ?? null,
          ctKey: item.company ? storedKey({ company: item.company, title: item.title }) : null,
          now: nowIso,
        });
      },
    });
    if (retried.attempted) log('info', `Retried full text for ${retried.attempted} earlier postings; ${retried.fixed} now have text`);
  }

  return {
    dryRun,
    since,
    bySource,
    retried,
    candidates: candidates.length,
    newFound: fresh.length,
    selected: selected.length,
    inserted: dryRun ? 0 : insertedIds.length,
    wouldInsert: toInsert.length,
    locationChecks,
    upgrades: upgrades.length,
    insertedIds,
    linkedinRateLimited: Boolean(state.linkedinBlocked),
  };
}
