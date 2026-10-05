// Builds scoring eval cases from past postings with a known outcome: applied (positive) or
// passed (negative). Text comes from the pasted job description, or is fetched again.
// Cases contain personal job-search data, so they live in gitignored data/evals/.
import { resolveDetails } from '../../agents/discovery/details.js';
import { jobIdFromUrl } from '../../agents/discovery/sources/linkedin.js';
import { checkLocation } from '../../tools/location.js';
import { lookups, sqlList } from '../../agents/lookups.js';

export const MIN_CASE_TEXT = 500;

/**
 * @returns {Promise<{cases: object[], skipped: {noText: number}, fetched: number}>}
 */
export async function buildCases({ db, http, browser = null, config, log = () => {} }) {
  const rows = db
    .prepare(`SELECT p.id, p.company, p.title, p.location, p.url, p.status, p.jd_text,
        (SELECT score FROM scores s WHERE s.posting_id = p.id AND s.source = 'v1-analysis' ORDER BY s.id DESC LIMIT 1) AS v1_score,
        (SELECT score FROM scores s WHERE s.posting_id = p.id AND s.source = 'v1-quick' ORDER BY s.id DESC LIMIT 1) AS v1_quick
      FROM postings p WHERE (p.status IN ${sqlList(lookups(db).inProgress())} OR p.status = 'passed')
        -- a status the agent set (cleanup of list pages, excluded sites, duplicates) is not the user's choice
        AND COALESCE((SELECT h.changed_by FROM status_history h WHERE h.posting_id = p.id ORDER BY h.id DESC LIMIT 1), '') != 'agent'
      ORDER BY p.id`)
    .all();

  const cases = [];
  const skipped = { noText: 0 };
  let fetched = 0;
  const state = {};
  for (const r of rows) {
    let text = r.jd_text && r.jd_text.length >= MIN_CASE_TEXT ? r.jd_text : null;
    let location = r.location;
    let workplace = null;
    if (!text && r.url) {
      const item = { url: r.url, linkedinJobId: jobIdFromUrl(r.url), company: r.company, title: r.title, location: r.location };
      await resolveDetails(item, { http, browser, state });
      if (item.description && item.description.length >= MIN_CASE_TEXT) {
        text = item.description;
        location = item.location ?? location;
        workplace = item.workplace ?? null;
        fetched += 1;
      }
      await http.sleep(item.linkedinJobId ? 3000 : 1000);
    }
    if (!text) {
      skipped.noText += 1;
      continue;
    }
    cases.push({
      id: r.id,
      label: r.status === 'passed' ? 'passed' : 'applied', // pursued: any in-progress status
      company: r.company,
      title: r.title,
      location: location ?? null,
      url: r.url ?? null,
      location_check: checkLocation({ location, workplace, text }, config.search.homeLocations),
      jd_text: text,
      v1Score: r.v1_score ?? r.v1_quick ?? null,
    });
    log(`case ${cases.length}: ${r.status}`);
  }
  return { cases, skipped, fetched };
}
