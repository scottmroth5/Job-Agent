// One discovery run: collect from every source, filter, dedupe against the database and
// within the run, fetch full text for new postings, check location, and store them.
// Scoring is a separate step (Phase 2c).
import { normalizeUrl, companyTitleKey } from '../../tools/urls.js';
import { keywordMatcher } from '../../tools/titles.js';
import { checkLocation } from '../../tools/location.js';
import { detectTrack } from '../../tools/track.js';
import { parseRate, parseHours } from '../../tools/rates.js';
import { resolveDetails, RETRYABLE } from './details.js';
import * as himalayas from './sources/himalayas.js';
import * as remoteok from './sources/remoteok.js';
import * as fractionaljobs from './sources/fractionaljobs.js';
import * as linkedin from './sources/linkedin.js';
import * as serper from './sources/serper.js';

/** Sources in priority order: when the same job appears in several, the earlier source wins. */
export const SOURCES = { himalayas, remoteok, fractionaljobs, linkedin, serper };
export const PRIORITY = [himalayas.SOURCE, remoteok.SOURCE, fractionaljobs.SOURCE, linkedin.SOURCE, serper.GO_FRACTIONAL, serper.SOURCE];

/** Fills track, rate and hours on an item from what the source and details gave. */
function applyTrack(item) {
  item.rate ??= parseRate(item.rateText);
  item.hours ??= parseHours(item.hoursText);
  item.track = detectTrack({ ...item, hoursMax: item.hours?.max });
  return item;
}
const rank = (source) => {
  const i = PRIORITY.indexOf(source);
  return i === -1 ? PRIORITY.length : i;
};

const UNKNOWN_COMPANY = '(unknown)';
const knownCompany = (c) => c && c !== UNKNOWN_COMPANY && c.toLowerCase() !== 'see posting';

function isoDaysAgo(now, days) {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Runs async tasks with a concurrency limit and a pause after each task. */
async function mapLimit(items, limit, pauseMs, sleep, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
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
async function resolveAll(items, { http, browser, state, concurrency, pauseMs, linkedinPauseMs, onDone }) {
  const viaLinkedIn = items.filter((i) => i.linkedinJobId);
  const others = items.filter((i) => !i.linkedinJobId);
  const run = async (item) => {
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
 * @param {object} ctx
 * @param {{db, tx}} ctx.store
 * @param {object} ctx.config               loaded job-search config
 * @param {object} ctx.http                 from createHttp()
 * @param {object|null} [ctx.browser]       from createBrowser(), or null
 * @param {object} [ctx.sources]            name -> source module; defaults to SOURCES
 * @param {Date}   [ctx.now]
 * @param {object} [ctx.options]            { dryRun, limit, details = true, maxAgeDays = 7, concurrency = 3, pauseMs = 1000,
 *                                            linkedinPauseMs = 3000, retryPending = true, log }
 * @returns {Promise<object>} summary with per-source counts, location results and inserted postings
 */
export async function runDiscovery({ store, config, http, browser = null, sources = SOURCES, now = new Date(), options = {} }) {
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
  const today = now.toISOString().slice(0, 10);
  const since = isoDaysAgo(now, maxAgeDays);
  const fullTimeRelevant = keywordMatcher(config.search.relevantTitleKeywords);
  const fractionalRelevant = keywordMatcher(config.search.fractionalTitleKeywords ?? []);
  // Fractional items also pass on the fractional keywords (e.g. CISO), which full-time searches do not target.
  const relevant = (item) => fullTimeRelevant(item.title) || (detectTrack(item) === 'fractional' && fractionalRelevant(item.title));
  const noise = keywordMatcher(config.search.noiseTitleKeywords ?? []);

  const bySource = {};
  const stat = (source) =>
    (bySource[source] ??= { requests: 0, found: 0, relevant: 0, fresh: 0, duplicates: 0, new: 0, detailsOk: 0, detailsFailed: 0, errors: [], rateLimited: false });

  // 1. Collect, in priority order
  const collected = [];
  const ordered = Object.values(sources).sort((a, b) => rank(a.SOURCE) - rank(b.SOURCE));
  for (const source of ordered) {
    const s = stat(source.SOURCE);
    try {
      const res = await source.search({ http, config });
      Object.assign(s, { requests: res.requests, found: res.items.length, errors: res.errors, rateLimited: res.rateLimited });
      collected.push(...res.items);
      log('info', `${source.SOURCE}: ${res.items.length} found in ${res.requests} requests${res.rateLimited ? ' (rate limited)' : ''}`);
    } catch (err) {
      s.errors.push(err.message);
      log('warn', `${source.SOURCE} failed: ${err.message}`);
    }
  }

  // 2-3. Filter by title and age
  const candidates = collected.filter((item) => {
    const s = stat(item.source);
    if (!item.title || !relevant(item) || noise(item.title)) return false;
    s.relevant += 1;
    if (item.postedOn && item.postedOn < since) return false;
    s.fresh += 1;
    return true;
  });

  // 4. Dedupe against the database and within this run
  const byUrl = db.prepare('SELECT id, source, stage FROM postings WHERE url_key = ?');
  const byCompanyTitle = db.prepare('SELECT id, source, stage FROM postings WHERE company_title_key = ? ORDER BY id LIMIT 1');
  const sightings = []; // { postingId, source, url }
  const upgrades = []; // existing discovered postings that a higher-priority source found again
  const seenUrl = new Set();
  const seenCt = new Set();
  const fresh = [];

  const findExisting = (item) => {
    const urlKey = normalizeUrl(item.url);
    const ctKey = knownCompany(item.company) ? companyTitleKey(item.company, item.title) : null;
    const existing = (urlKey && byUrl.get(urlKey)) || (ctKey && byCompanyTitle.get(ctKey)) || null;
    return { urlKey, ctKey, existing };
  };
  const recordDuplicate = (item, existing) => {
    stat(item.source).duplicates += 1;
    sightings.push({ postingId: existing.id, source: item.source, url: item.url });
    if (existing.stage === 'discovered' && rank(item.source) < rank(existing.source)) upgrades.push({ id: existing.id, item });
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
  const state = {};
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
  const toInsert = [];
  const seenAfter = new Set();
  for (const item of selected) {
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

  const locationChecks = {};
  for (const item of toInsert) locationChecks[item.locationCheck] = (locationChecks[item.locationCheck] ?? 0) + 1;

  // 7. Store
  const insertedIds = [];
  if (!dryRun) {
    const nowIso = now.toISOString();
    const insert = db.prepare(`INSERT INTO postings
      (url, url_key, company, title, company_title_key, source, location, salary, job_type, posted_on, posted_raw,
       discovered_on, stage, status, fetched_text, fetched_at, fetch_status, fetch_method, fetch_attempts, workplace, location_check,
       source_job_id, track, rate_text, rate_min, rate_max, rate_unit, hours_min, hours_max, extra_json, created_at, updated_at)
      VALUES (@url, @url_key, @company, @title, @company_title_key, @source, @location, @salary, @job_type, @posted_on, @posted_raw,
       @discovered_on, 'discovered', 'new', @fetched_text, @fetched_at, @fetch_status, @fetch_method, @fetch_attempts, @workplace, @location_check,
       @source_job_id, @track, @rate_text, @rate_min, @rate_max, @rate_unit, @hours_min, @hours_max, @extra_json, @now, @now)`);
    const history = db.prepare(`INSERT INTO status_history (posting_id, from_status, to_status, changed_by, changed_at) VALUES (?, NULL, 'new', 'agent', ?)`);
    const sighting = db.prepare('INSERT OR IGNORE INTO posting_sightings (posting_id, source, url, seen_on) VALUES (?, ?, ?, ?)');
    const upgrade = db.prepare(`UPDATE postings SET url = @url, url_key = @url_key, source = @source,
        fetched_text = COALESCE(fetched_text, @fetched_text), location = COALESCE(location, @location),
        salary = COALESCE(salary, @salary), posted_on = COALESCE(posted_on, @posted_on),
        workplace = COALESCE(workplace, @workplace), updated_at = @now
      WHERE id = @id AND stage = 'discovered'`);

    store.tx(() => {
      for (const item of toInsert) {
        const company = knownCompany(item.company) ? item.company : UNKNOWN_COMPANY;
        const id = Number(
          insert.run({
            url: item.url,
            url_key: normalizeUrl(item.url),
            company,
            title: item.title,
            company_title_key: companyTitleKey(company, item.title),
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
            track: item.track ?? 'fulltime',
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
        history.run(id, nowIso);
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
        WHERE stage = 'discovered' AND fetch_status IN (${RETRYABLE.map(() => '?').join(', ')})
          AND fetch_attempts < ? AND discovered_on >= ?
          ${insertedIds.length ? `AND id NOT IN (${insertedIds.map(() => '?').join(', ')})` : ''}`)
      .all(...RETRYABLE, MAX_FETCH_ATTEMPTS, since, ...insertedIds);
    const items = pending.map((p) => ({
      id: p.id,
      url: p.url,
      company: knownCompany(p.company) ? p.company : null,
      title: p.title,
      location: p.location,
      workplace: p.workplace,
      linkedinJobId: linkedin.jobIdFromUrl(p.url),
      description: null,
    }));
    if (items.length) log('info', `Retrying full text for ${items.length} earlier postings`);
    const update = db.prepare(`UPDATE postings SET fetched_text = @text, fetched_at = @fetchedAt, fetch_status = @status,
        fetch_method = @method, fetch_attempts = fetch_attempts + 1, location = COALESCE(location, @location),
        workplace = COALESCE(workplace, @workplace), location_check = @locationCheck,
        company = CASE WHEN company = '${UNKNOWN_COMPANY}' AND @company IS NOT NULL THEN @company ELSE company END,
        company_title_key = CASE WHEN company = '${UNKNOWN_COMPANY}' AND @company IS NOT NULL THEN @ctKey ELSE company_title_key END,
        updated_at = @now WHERE id = @id`);
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
          ctKey: item.company ? companyTitleKey(item.company, item.title) : null,
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
