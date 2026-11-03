// Himalayas (remote-only job board). Free search API, one request per search term.
// The API includes the full description and a unix-seconds pubDate.
import { htmlToText } from '../../../tools/html.ts';
import { RateLimitedError } from '../../../tools/http.ts';
import type { JobItem, SourceContext, SourceResult } from '../types.ts';

/** The fields read from one job in Himalayas' API (JSON from the web: each is checked before use). */
interface ApiJob {
  guid?: string;
  applicationLink?: string;
  companyName?: string;
  title?: string;
  locationRestrictions?: string[];
  pubDate?: number;
  minSalary?: number;
  maxSalary?: number;
  currency?: string;
  employmentType?: string;
  description?: string;
}

export const SOURCE = 'Himalayas';
const API = 'https://himalayas.app/jobs/api/search';

const isoDay = (unixSeconds: number | undefined) => (unixSeconds ? new Date(unixSeconds * 1000).toISOString().slice(0, 10) : null);

function salary(job: ApiJob) {
  if (!job.minSalary || !job.maxSalary) return null;
  const sym = !job.currency || job.currency === 'USD' ? '$' : `${job.currency} `;
  return `${sym}${Math.round((job.minSalary as number) / 1000)}k - ${sym}${Math.round((job.maxSalary as number) / 1000)}k`;
}

/** Maps one API job to the common item shape. */
export function parseJob(job: ApiJob): JobItem {
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
export async function search({ http, config, delayMs = 1000 }: SourceContext): Promise<SourceResult> {
  const out: SourceResult = { items: [], requests: 0, errors: [], rateLimited: false };
  for (const term of config.search.terms) {
    const url = `${API}?q=${encodeURIComponent(term)}&sort=recent`;
    try {
      out.requests += 1;
      const data = await http.getJson(url);
      out.items.push(...((data.jobs ?? []) as ApiJob[]).map(parseJob));
    } catch (err) {
      if (err instanceof RateLimitedError) {
        out.rateLimited = true;
        break;
      }
      out.errors.push(`${term}: ${(err as Error).message}`);
    }
    await http.sleep(delayMs);
  }
  return out;
}
