// RemoteOK (remote-only job board). One request returns the latest ~100 jobs with descriptions.
import { htmlToText } from '../../../tools/html.js';
import { detectJobType } from '../../../tools/titles.js';
import { RateLimitedError } from '../../../tools/http.js';

export const SOURCE = 'RemoteOK';
const API = 'https://remoteok.com/api';

/** Maps one API job to the common item shape. */
export function parseJob(job) {
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
export function parseResponse(data) {
  return (Array.isArray(data) ? data.slice(1) : []).filter((j) => j && j.position).map(parseJob);
}

export async function search({ http }) {
  const out = { items: [], requests: 1, errors: [], rateLimited: false };
  try {
    out.items = parseResponse(await http.getJson(API));
  } catch (err) {
    if (err instanceof RateLimitedError) out.rateLimited = true;
    else out.errors.push(err.message);
  }
  return out;
}
