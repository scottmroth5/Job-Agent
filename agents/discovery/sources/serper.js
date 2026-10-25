// Google results via Serper.dev (v1's "Google Jobs" source). Results link to other job sites,
// so company and description usually come later from the linked page's JobPosting data.
import { RateLimitedError } from '../../../tools/http.js';
import { jobIdFromUrl } from './linkedin.js';
import { isOnSite } from '../../../tools/urls.js';

export const SOURCE = 'Google Jobs';
const API = 'https://google.serper.dev/search';

// Trailing segments that name the job site rather than the employer.
const SITE_NAMES = /^(linkedin|indeed(\.com)?|glassdoor|ziprecruiter|monster|simplyhired|dice|builtin|built in|wellfound|remote ?rocketship|remotive|dailyremote|remotefront|jobleads|remote\.co|we work remotely|jooble|careerbuilder|lensa|talent\.com|job board)$/i;

/**
 * Best-effort title/company from a search result title, e.g.
 *   "Acme hiring VP of Engineering in Denver, CO | LinkedIn"
 *   "VP of Engineering - Acme - Remote Rocketship"
 */
export function parseResultTitle(raw) {
  // Search result titles come from the web, so this parses with linear steps only (whitespace collapsed first,
  // then plain string searches); a crafted title can never make it slow.
  // Page-title wrappers such as Greenhouse's "Job Application for <title> at <company>".
  let s = String(raw ?? '').slice(0, 500).replace(/\s+/g, ' ').trim();
  if (s.endsWith('...')) s = s.slice(0, -3).trimEnd();
  s = s.replace(/^(job application for|apply for|apply to|careers:) /i, '').trim();
  const lower = s.toLowerCase();

  // "<company> hiring <title> in <location> | <site>"
  const hiringAt = lower.indexOf(' hiring ');
  if (hiringAt > 0) {
    let rest = s.slice(hiringAt + ' hiring '.length);
    const bar = rest.indexOf(' | ');
    if (bar >= 0) rest = rest.slice(0, bar);
    const inAt = rest.toLowerCase().indexOf(' in ');
    const title = (inAt > 0 ? rest.slice(0, inAt) : rest).trim();
    if (title) return { title, company: s.slice(0, hiringAt).trim(), location: inAt > 0 ? rest.slice(inAt + ' in '.length).trim() || null : null };
  }

  const parts = s.split(/ [-|–] /).map((p) => p.trim()).filter(Boolean);
  while (parts.length > 1 && SITE_NAMES.test(parts[parts.length - 1])) parts.pop();
  const first = parts[0] ?? '';
  const at = first.toLowerCase().indexOf(' at ');
  if (at > 0 && at + ' at '.length < first.length) return { title: first.slice(0, at).trim(), company: first.slice(at + ' at '.length).trim(), location: null };
  return { title: parts[0] ?? s, company: parts.length > 1 ? parts[1] : null, location: null };
}

// Search results from these sites are posts or profiles, never job postings.
const NOT_JOB_SITES = /(^|\.)(instagram|facebook|twitter|x|tiktok|youtube|reddit|pinterest|medium|quora)\.com$/i;

/** True when a result links to a site that never hosts job postings. */
export function isNonJobSite(url) {
  try {
    return NOT_JOB_SITES.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Maps one Serper result (organic or jobs) to the common item shape. */
export function parseResult(r, term) {
  const parsed = parseResultTitle(r.title);
  const url = r.link || r.applyLink || r.apply_link || null;
  const linkedinJobId = jobIdFromUrl(url);
  return {
    source: SOURCE,
    sourceJobId: linkedinJobId,
    linkedinJobId,
    url,
    company: (r.company_name || r.companyName || r.company || parsed.company || '').trim() || null,
    title: parsed.title,
    location: r.location || parsed.location || null,
    workplace: null,
    postedOn: null,
    salary: r.salary || null,
    jobType: r.employment_type || null,
    description: null,
    searchTerm: term,
  };
}

// Go Fractional's own pages are bot-protected, so its listings are found through Google instead.
export const GO_FRACTIONAL = 'Go Fractional';

/**
 * The searches to run: v1's "<term> remote jobs" for full-time terms, "<term> remote" for fractional
 * terms, and, when search.siteSearch is true, a Google site search of Go Fractional per fractional term.
 * Serper's free plan rejects site: queries ("Query pattern not allowed for free accounts"), so it is off by default.
 */
export function buildQueries(config) {
  const fractional = config.search.fractionalTerms ?? [];
  return [
    ...config.search.terms.map((term) => ({ term, q: `${term} remote jobs` })),
    ...fractional.map((term) => ({ term, q: `${term} remote`, searchTrack: 'fractional' })),
    ...(config.search.siteSearch
      ? fractional.map((term) => ({ term, q: `site:gofractional.com/jobs ${term}`, searchTrack: 'fractional', source: GO_FRACTIONAL }))
      : []),
  ];
}

export async function search({ http, config, apiKey = process.env.SERPER_API_KEY, delayMs = 1200 }) {
  const out = { items: [], requests: 0, errors: [], rateLimited: false };
  if (!apiKey) {
    out.errors.push('SERPER_API_KEY is not set; skipped');
    return out;
  }
  for (const { term, q, searchTrack, source } of buildQueries(config)) {
    try {
      out.requests += 1;
      const data = await http.postJson(API, { q, gl: 'us', hl: 'en', tbs: 'qdr:w', num: 20 }, { headers: { 'X-API-KEY': apiKey } });
      out.items.push(
        ...(data.jobs ?? data.organic ?? [])
          .map((r) => ({ ...parseResult(r, term), ...(searchTrack ? { searchTrack } : {}), ...(source ? { source } : {}) }))
          .filter((i) => !isNonJobSite(i.url))
          .filter((i) => source !== GO_FRACTIONAL || isOnSite(i.url, 'gofractional.com', '/jobs/')),
      );
    } catch (err) {
      if (err instanceof RateLimitedError) {
        out.rateLimited = true;
        break;
      }
      out.errors.push(`${term}: ${err.message}`);
    }
    await http.sleep(delayMs);
  }
  return out;
}
