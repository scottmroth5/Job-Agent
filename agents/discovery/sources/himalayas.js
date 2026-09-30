// Himalayas (remote-only job board). Free search API, one request per search term.
// The API includes the full description and a unix-seconds pubDate.
import { htmlToText } from '../../../tools/html.js';
import { RateLimitedError } from '../../../tools/http.js';

export const SOURCE = 'Himalayas';
const API = 'https://himalayas.app/jobs/api/search';

const isoDay = (unixSeconds) => (unixSeconds ? new Date(unixSeconds * 1000).toISOString().slice(0, 10) : null);

function salary(job) {
  if (!job.minSalary || !job.maxSalary) return null;
  const sym = !job.currency || job.currency === 'USD' ? '$' : `${job.currency} `;
  return `${sym}${Math.round(job.minSalary / 1000)}k - ${sym}${Math.round(job.maxSalary / 1000)}k`;
}

/** Maps one API job to the common item shape. */
export function parseJob(job) {
  const restrictions = Array.isArray(job.locationRestrictions) ? job.locationRestrictions.filter(Boolean) : [];
  return {
    source: SOURCE,
    sourceJobId: job.guid ?? null,
    url: job.applicationLink || job.guid || null,
    company: job.companyName?.trim() || null,
    title: job.title?.trim() || '',
    location: restrictions.length ? `Remote (${restrictions.join(', ')})` : 'Remote',
    workplace: 'remote',
    postedOn: isoDay(job.pubDate),
    salary: salary(job),
    jobType: job.employmentType ?? null,
    description: job.description ? htmlToText(job.description) : null,
  };
}

/** Searches every configured term. Returns { items, requests, errors, rateLimited }. */
export async function search({ http, config, delayMs = 1000 }) {
  const out = { items: [], requests: 0, errors: [], rateLimited: false };
  for (const term of config.search.terms) {
    const url = `${API}?q=${encodeURIComponent(term)}&sort=recent`;
    try {
      out.requests += 1;
      const data = await http.getJson(url);
      out.items.push(...(data.jobs ?? []).map(parseJob));
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
