// Google results via Serper.dev (v1's "Google Jobs" source). Results link to other job sites,
// so company and description usually come later from the linked page's JobPosting data.
import { RateLimitedError } from '../../../tools/http.js';
import { jobIdFromUrl } from './linkedin.js';

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
  const s = String(raw ?? '').replace(/\s*\.{3}$/, '').trim();
  const hiring = /^(.+?) hiring (.+?)(?: in (.+?))?(?: \| .*)?$/i.exec(s);
  if (hiring) return { title: hiring[2].trim(), company: hiring[1].trim(), location: hiring[3]?.trim() ?? null };
  const parts = s.split(/\s+[-|–]\s+/).map((p) => p.trim()).filter(Boolean);
  while (parts.length > 1 && SITE_NAMES.test(parts[parts.length - 1])) parts.pop();
  const atMatch = /^(.+?) at (.+)$/i.exec(parts[0] ?? '');
  if (atMatch) return { title: atMatch[1].trim(), company: atMatch[2].trim(), location: null };
  return { title: parts[0] ?? s, company: parts.length > 1 ? parts[1] : null, location: null };
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

export async function search({ http, config, apiKey = process.env.SERPER_API_KEY, delayMs = 1200 }) {
  const out = { items: [], requests: 0, errors: [], rateLimited: false };
  if (!apiKey) {
    out.errors.push('SERPER_API_KEY is not set; skipped');
    return out;
  }
  for (const term of config.search.terms) {
    try {
      out.requests += 1;
      const data = await http.postJson(
        API,
        { q: `${term} remote jobs`, gl: 'us', hl: 'en', tbs: 'qdr:w', num: 20 },
        { headers: { 'X-API-KEY': apiKey } },
      );
      out.items.push(...(data.jobs ?? data.organic ?? []).map((r) => parseResult(r, term)));
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
