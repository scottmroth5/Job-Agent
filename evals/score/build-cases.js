// Builds scoring eval cases from past postings with a known outcome: applied (positive) or
// passed (negative). Text comes from the pasted job description, or is fetched again.
// Cases contain personal job-search data, so they live in gitignored data/evals/.
import { asEngine } from '../../db/engine/index.ts';
import { resolveDetails } from '../../agents/discovery/details.ts';
import { jobIdFromUrl } from '../../agents/discovery/sources/linkedin.ts';
import { checkLocation } from '../../tools/location.ts';
import { lookups, sqlList } from '../../agents/lookups.ts';
/**
 * @import { Database } from '../../tools/types.ts'
 * @import { Http } from '../../tools/http.ts'
 * @import { JobSearchConfig } from '../../tools/config.ts'
 * @import { JobItem, PageRenderer } from '../../agents/discovery/types.ts'
 * @import { PostingsRow } from '../../db/types.ts'
 */

/**
 * One scoring eval case (data/evals/score/cases.json).
 * @typedef {{ id: number, label: 'applied' | 'passed', company: string, title: string, location: string | null, url: string | null, location_check: string, jd_text: string, v1Score: number | null }} ScoreCase
 */

export const MIN_CASE_TEXT = 500;

/**
 * @param {{ db: Database, http: Http, browser?: PageRenderer | null, config: Pick<JobSearchConfig, 'search'>, log?: (line: string) => void }} opts
 * @returns {Promise<{cases: ScoreCase[], skipped: {noText: number}, fetched: number}>}
 */
export async function buildCases({ db, http, browser = null, config, log = () => {} }) {
  const found = await asEngine(db)
    .prepare(`SELECT p.id, p.company, p.title, p.location, p.url, p.status, p.jd_text,
        (SELECT score FROM scores s WHERE s.posting_id = p.id AND s.user_id = p.user_id AND s.source = 'v1-analysis' ORDER BY s.id DESC LIMIT 1) AS v1_score,
        (SELECT score FROM scores s WHERE s.posting_id = p.id AND s.user_id = p.user_id AND s.source = 'v1-quick' ORDER BY s.id DESC LIMIT 1) AS v1_quick
      FROM postings p WHERE p.user_id = @uid AND (p.status IN ${sqlList((await lookups(db)).inProgress())} OR p.status = 'passed')
        -- a status the agent set (cleanup of list pages, excluded sites, duplicates) is not the user's choice
        AND COALESCE((SELECT h.changed_by FROM status_history h WHERE h.posting_id = p.id AND h.user_id = p.user_id ORDER BY h.id DESC LIMIT 1), '') != 'agent'
      ORDER BY p.id`)
    .all();
  const rows = /** @type {Array<Pick<PostingsRow, 'id' | 'company' | 'title' | 'location' | 'url' | 'status' | 'jd_text'> & { v1_score: number | null, v1_quick: number | null }>} */ (found);

  /** @type {ScoreCase[]} */
  const cases = [];
  const skipped = { noText: 0 };
  let fetched = 0;
  const state = {};
  for (const r of rows) {
    let text = r.jd_text && r.jd_text.length >= MIN_CASE_TEXT ? r.jd_text : null;
    let location = r.location;
    /** @type {string | null} */
    let workplace = null;
    if (!text && r.url) {
      /** @type {Partial<JobItem> & Pick<JobItem, 'url' | 'company' | 'title'>} */
      const item = { url: r.url, linkedinJobId: jobIdFromUrl(r.url), company: r.company, title: r.title, location: r.location };
      await resolveDetails(/** @type {JobItem} */ (item), { http, browser, state }); // fills in what it finds; reads no source
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
