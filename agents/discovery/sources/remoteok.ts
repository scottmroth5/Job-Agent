// RemoteOK (remote-only job board). One request returns the latest ~100 jobs with descriptions.
import { htmlToText } from '../../../tools/html.ts';
import { detectJobType } from '../../../tools/titles.ts';
import { RateLimitedError } from '../../../tools/http.ts';
import type { JobItem, SourceContext, SourceResult } from '../types.ts';

/** The fields read from one job in RemoteOK's API (JSON from the web: each is checked before use). */
interface ApiJob {
  id?: number | string | null;
  url?: string;
  apply_url?: string;
  company?: string;
  position?: string;
  location?: string;
  epoch?: number;
  date?: string;
  salary_min?: number;
  salary_max?: number;
  tags?: string[];
  description?: string;
}

export const SOURCE = 'RemoteOK';
const API = 'https://remoteok.com/api';

/** Maps one API job to the common item shape. */
export function parseJob(job: ApiJob): JobItem {
  const description = job.description ? htmlToText(job.description) : null;
  return {
    source: SOURCE,
    sourceJobId: job.id != null ? String(job.id) : null,
    url: job.url || job.apply_url || null,
    company: job.company?.trim() || null,
    title: job.position?.trim() || '',
    location: job.location?.trim() ? `Remote (${job.location.trim()})` : 'Remote',
    workplace: 'remote',
    postedOn: job.epoch ? new Date(job.epoch * 1000).toISOString().slice(0, 10) : (job.date ?? '').slice(0, 10) || null,
    salary: job.salary_min && job.salary_max ? `$${Math.round(job.salary_min / 1000)}k - $${Math.round(job.salary_max / 1000)}k` : null,
    jobType: detectJobType(job.position, (job.tags ?? []).join(' ')),
    description,
  };
}

/** The first array element is API metadata, not a job. */
export function parseResponse(data: unknown): JobItem[] {
  return ((Array.isArray(data) ? data.slice(1) : []) as ApiJob[]).filter((j) => j && j.position).map(parseJob);
}

export async function search({ http }: Pick<SourceContext, 'http'>): Promise<SourceResult> {
  const out: SourceResult = { items: [], requests: 1, errors: [], rateLimited: false };
  try {
    out.items = parseResponse(await http.getJson(API));
  } catch (err) {
    if (err instanceof RateLimitedError) out.rateLimited = true;
    else out.errors.push((err as Error).message);
  }
  return out;
}
