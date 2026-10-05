// Manually added jobs: a link you found and/or a pasted description. Dedupe, get the text if
// you did not paste it, check location and track, score, and write materials when it scores
// well (or when asked). Used by the UI's Add job and by npm run add.
import { normalizeUrl } from '../tools/urls.js';
import { identityKey, storedKey, isRealCompany } from './identity.js';
import { checkLocation } from '../tools/location.js';
import { detectTrack } from '../tools/track.js';
import { parseRate, parseHours } from '../tools/rates.js';
import { listingReason, excludedSite } from '../tools/listings.js';
import { resolveDetails } from './discovery/details.js';
import { jobIdFromUrl } from './discovery/sources/linkedin.js';
import * as fractionaljobs from './discovery/sources/fractionaljobs.js';
import { scorePostings, DEFAULT_SCORE_MODEL, PROMOTE_AT } from './discovery/score.js';
import { generateForPostings } from './hunt/generate.js';
import { lookups } from './lookups.js';

export const MANUAL_SOURCE = 'manual';
export { isRealCompany };
const MIN_PASTED = 100;

const STAGE_LABEL = { discovered: 'Discovered', pipeline: 'Pipeline', archived: 'Archived' };

/** What an existing posting is, in words the Add job dialog can show. */
export function describeExisting(db, id) {
  const p = db
    .prepare(`SELECT p.id, p.title, p.company, p.source, p.stage, p.status, p.track, p.discovered_on, p.url,
        (SELECT score FROM scores s WHERE s.posting_id = p.id ORDER BY CASE WHEN s.source LIKE 'v2%' THEN 0 ELSE 1 END, s.id DESC LIMIT 1) AS score
      FROM postings p WHERE p.id = ?`)
    .get(id);
  const parts = [
    `found by ${p.source === MANUAL_SOURCE ? 'you' : p.source} on ${p.discovered_on}`,
    STAGE_LABEL[p.stage] ?? p.stage,
    p.status,
    p.score != null ? `score ${p.score}` : 'not scored',
  ];
  return {
    id: p.id,
    title: p.title,
    company: p.company,
    source: p.source,
    stage: p.stage,
    status: p.status,
    track: p.track,
    score: p.score,
    discoveredOn: p.discovered_on,
    url: p.url,
    summary: parts.join(', '),
  };
}

/** Checks the input before any work. Throws with a message fit for the UI. */
export function validateManualInput(input) {
  const url = input.url?.trim();
  const description = input.description?.trim();
  if (!url && !description) throw new Error('Add a link to the posting, a pasted description, or both.');
  if (url && !/^https?:\/\//i.test(url)) throw new Error('The link must start with http:// or https://.');
  if (!url && (!input.title?.trim() || !input.company?.trim())) throw new Error('Without a link, enter the job title and company.');
  if (description && description.length < MIN_PASTED) throw new Error(`The pasted description is very short (under ${MIN_PASTED} characters).`);
  if (input.track && !/^[a-z][a-z0-9_]*$/.test(input.track)) throw new Error('Choose a track from the list.');
  rejectSkipped({ url, title: input.title });
}

/** Refuses a list-of-jobs page (it cannot be scored or applied to) or a link to an excluded site. */
function rejectSkipped(posting, config) {
  const site = excludedSite(posting.url, config?.search?.excludedSites);
  if (site) throw new Error(`Jobs from ${site} are excluded in your settings (search.excludedSites). Find the job on the employer's site and add that link.`);
  const reason = listingReason(posting);
  if (reason) throw new Error(`This looks like a list of jobs, not one job (${reason}). Open it, pick a job, and add that job's link.`);
}

/**
 * Adds one job and runs it through the same steps as discovered jobs.
 * @param {object} input   { url?, title?, company?, location?, description?, notes?, track?, rateText?, hoursText?, writeMaterials? }
 * @param {object} ctx     { store, config, http, browser, claude, knowledge, drive, run, onStep(message) }
 * @returns {Promise<{ id, created, score, promoted, materials }>}
 */
export async function addPosting(input, ctx) {
  validateManualInput(input);
  const { store, config, http, browser, claude, knowledge, drive, run } = ctx;
  rejectSkipped({ url: input.url?.trim() }, config);
  const step = (m) => {
    ctx.onStep?.(m);
    run?.log?.('info', m);
  };
  const { db } = store;
  const url = input.url?.trim() || null;
  const pasted = input.description?.trim() || null;

  // 1. Already known?
  const urlKey = normalizeUrl(url);
  const byUrl = urlKey ? db.prepare('SELECT id FROM postings WHERE url_key = ?').get(urlKey) : null;
  // Company + title only identifies a job when the company is real, not a placeholder like "Unknown".
  const ctKey = input.title ? identityKey({ company: input.company, title: input.title }) : null;
  const existing = byUrl ?? (ctKey ? db.prepare('SELECT id FROM postings WHERE company_title_key = ? ORDER BY id LIMIT 1').get(ctKey) : null);
  if (existing) {
    const match = describeExisting(db, existing.id);
    step(`Already saved: "${match.title}" at ${match.company} (${match.summary})`);
    return { id: existing.id, created: false, existing: match, matchedBy: byUrl ? 'link' : 'company and title' };
  }

  // 2. Text and details
  const item = {
    source: MANUAL_SOURCE,
    url,
    title: input.title?.trim() || '',
    company: input.company?.trim() || null,
    location: input.location?.trim() || null,
    description: pasted,
    rateText: input.rateText?.trim() || null,
    hoursText: input.hoursText?.trim() || null,
    linkedinJobId: jobIdFromUrl(url),
  };
  if (url && /fractionaljobs\.io\/jobs\//i.test(url)) item.fetchDetails = (h) => fractionaljobs.fetchPosting(h, url);
  if (pasted) {
    Object.assign(item, { fetchStatus: 'ok', fetchMethod: 'pasted' });
    // Still read the page for title/company/terms when they were not typed in.
    if (url && (!item.title || !item.company)) {
      step('Reading the posting page for title and company');
      const probe = { ...item, description: null };
      await resolveDetails(probe, { http, browser });
      item.title ||= probe.title || '';
      item.company ??= probe.company;
      item.location ??= probe.location;
      item.rateText ??= probe.rateText;
      item.hoursText ??= probe.hoursText;
      item.workplace ??= probe.workplace;
      item.extra = probe.extra;
    }
  } else {
    step('Fetching the posting text');
    await resolveDetails(item, { http, browser });
    if (item.fetchStatus !== 'ok') step(`Could not read the posting (${item.fetchStatus}); paste the description in the job's detail panel`);
  }
  if (!item.title || !item.company) {
    throw new Error("Couldn't read the job title or company from the link. Enter them and try again.");
  }
  rejectSkipped(item, config);
  // The link may have supplied the company and title: check again for the same job saved from another site.
  const fetchedKey = identityKey(item);
  const sameJob = fetchedKey ? db.prepare('SELECT id FROM postings WHERE company_title_key = ? ORDER BY id LIMIT 1').get(fetchedKey) : null;
  if (sameJob) {
    const match = describeExisting(db, sameJob.id);
    step(`Already saved: "${match.title}" at ${match.company} (${match.summary})`);
    return { id: sameJob.id, created: false, existing: match, matchedBy: 'company and title' };
  }

  // 3. Location, track, pay and hours
  const rate = parseRate(item.rateText);
  const hours = parseHours(item.hoursText);
  const lk = lookups(db);
  if (input.track && !lk.selectable('track', input.track)) throw new Error(`"${input.track}" is not an available track.`);
  const track = input.track ?? detectTrack({ ...item, hoursMax: hours?.max });
  const locationCheck = checkLocation({ location: item.location, workplace: item.workplace, text: item.description }, config.search.homeLocations);

  // 4. Save
  const nowIso = new Date().toISOString();
  const id = Number(
    db
      .prepare(`INSERT INTO postings (url, url_key, company, title, company_title_key, source, location, workplace, discovered_on,
          stage, status, notes, jd_text, fetched_text, fetched_at, fetch_status, fetch_method, fetch_attempts, location_check,
          track, rate_text, rate_min, rate_max, rate_unit, hours_min, hours_max, extra_json, created_at, updated_at)
        VALUES (@url, @url_key, @company, @title, @ct, 'manual', @location, @workplace, @today, @stage, @status, @notes,
          @jd_text, @fetched_text, @fetched_at, @fetch_status, @fetch_method, 1, @location_check, @track, @rate_text,
          @rate_min, @rate_max, @rate_unit, @hours_min, @hours_max, @extra, @now, @now)`)
      .run({
        url,
        url_key: urlKey,
        company: item.company,
        title: item.title,
        ct: storedKey(item),
        location: item.location ?? null,
        workplace: item.workplace ?? null,
        today: nowIso.slice(0, 10),
        notes: input.notes?.trim() || null,
        jd_text: pasted,
        fetched_text: pasted ? null : item.description ?? null,
        fetched_at: !pasted && item.description ? nowIso : null,
        fetch_status: item.fetchStatus ?? null,
        fetch_method: item.fetchMethod ?? null,
        location_check: locationCheck,
        track,
        rate_text: item.rateText,
        rate_min: rate?.min ?? null,
        rate_max: rate?.max ?? null,
        rate_unit: rate?.unit ?? null,
        hours_min: hours?.min ?? null,
        hours_max: hours?.max ?? null,
        extra: item.extra && Object.keys(item.extra).length ? JSON.stringify(item.extra) : null,
        now: nowIso,
        stage: lk.role('stage', 'default'),
        status: lk.role('status', 'default'),
      }).lastInsertRowid,
  );
  db.prepare("INSERT INTO status_history (posting_id, from_status, to_status, changed_by, changed_at) VALUES (?, NULL, ?, 'user', ?)").run(id, lk.role('status', 'default'), nowIso);
  step(`Saved as job #${id} (${lk.label('track', track)})`);

  // 5. Score
  step('Scoring');
  const scored = await scorePostings({ store, config, claude, knowledge, model: DEFAULT_SCORE_MODEL, run, options: { ids: [id], concurrency: 1 } });
  if (scored.failures.length) throw new Error(`Saved as job #${id}, but scoring failed: ${scored.failures[0].error}`);
  const score = db.prepare("SELECT score FROM scores WHERE posting_id = ? AND source IN ('v2', 'v2-rule') ORDER BY id DESC LIMIT 1").pluck().get(id);
  const promoted = scored.promoted.includes(id);
  step(`Scored ${score} of 10${promoted ? ', moved to your pipeline' : ''}`);

  // 6. Materials
  let materials = null;
  if (promoted || input.writeMaterials) {
    if (!promoted) db.prepare('UPDATE postings SET stage = ?, updated_at = ? WHERE id = ?').run(lk.role('stage', 'promote'), nowIso, id);
    step('Writing resume tweaks and cover letter');
    materials = await generateForPostings({ store, config, claude, knowledge, drive, run, options: { ids: [id] } });
    step(materials.docs ? 'Cover letter saved as a Google Doc' : 'Materials written');
  } else if (!pasted && !item.description) {
    step('No description, so it stays in Discovered: paste the description in the detail panel, then Re-score');
  } else {
    step(`Score is under ${PROMOTE_AT}, so no materials were written (use Write materials to create them anyway)`);
  }
  return { id, created: true, score, promoted, materials };
}
