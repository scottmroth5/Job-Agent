// LinkedIn public (logged-out) job search. Two searches per term: remote across the US
// (f_WT=2) and local around search.localSearchLocation. The guest posting endpoint
// supplies the full description for each new job.
import { decodeEntities, htmlToText } from '../../../tools/html.js';
import { RateLimitedError } from '../../../tools/http.js';

export const SOURCE = 'LinkedIn';
const SEARCH = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const POSTING = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/';
const PAGE_SIZE = 10;

const text = (html) => decodeEntities(String(html ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

export function searchUrl({ keywords, mode, localLocation, start = 0 }) {
  const p = new URLSearchParams({ keywords, f_TPR: 'r604800', sortBy: 'DD', start: String(start) });
  if (mode === 'remote') {
    p.set('location', 'United States');
    p.set('f_WT', '2');
  } else {
    p.set('location', localLocation);
    p.set('distance', '25');
  }
  return `${SEARCH}?${p}`;
}

/** Job ID from a LinkedIn job URL (…/jobs/view/some-title-at-company-1234567890/). */
export function jobIdFromUrl(url) {
  return /linkedin\.com\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})/i.exec(String(url ?? ''))?.[1] ?? null;
}

/** Parses the job cards in one search-results page. mode 'remote' marks every job remote. */
export function parseSearchPage(html, mode) {
  return String(html ?? '')
    .split(/<li[\s>]/)
    .slice(1)
    .map((card) => {
      const id = /urn:li:jobPosting:(\d+)/.exec(card)?.[1] ?? jobIdFromUrl(card);
      const link = /base-card__full-link[^>]*href="([^"?#]+)/.exec(card)?.[1];
      const title = text(/base-search-card__title[^>]*>([\s\S]*?)<\/h3>/.exec(card)?.[1]);
      const company = text(/base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/.exec(card)?.[1]);
      const location = text(/job-search-card__location[^>]*>([\s\S]*?)<\/span>/.exec(card)?.[1]);
      const postedOn = /<time[^>]*datetime="(\d{4}-\d{2}-\d{2})/.exec(card)?.[1] ?? null;
      if (!id || !title) return null;
      return {
        source: SOURCE,
        sourceJobId: id,
        linkedinJobId: id,
        url: link ? decodeEntities(link) : `https://www.linkedin.com/jobs/view/${id}/`,
        company: company || null,
        title,
        location: location || null,
        workplace: mode === 'remote' ? 'remote' : null,
        postedOn,
        salary: text(/job-search-card__salary-info[^>]*>([\s\S]*?)<\/span>/.exec(card)?.[1]) || null,
        jobType: null,
        description: null,
      };
    })
    .filter(Boolean);
}

/** Parses the guest posting page: title, company, location, description text and the job criteria list. */
export function parsePosting(html) {
  const s = String(html ?? '');
  const body = /show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/.exec(s)?.[1];
  const criteria = {};
  const re = /description__job-criteria-subheader[^>]*>([\s\S]*?)<\/h3>[\s\S]*?description__job-criteria-text[^>]*>([\s\S]*?)<\/span>/g;
  for (const m of s.matchAll(re)) criteria[text(m[1])] = text(m[2]);
  const field = (cls, tag) => text(new RegExp(`class="[^"]*${cls}[^"]*"[^>]*>([\\s\\S]*?)</${tag}>`).exec(s)?.[1]) || null;
  return {
    title: field('top-card-layout__title', 'h2') ?? field('topcard__title', 'h\\d'),
    company: field('topcard__org-name-link', 'a'),
    location: field('topcard__flavor--bullet', 'span'),
    description: body ? htmlToText(body) : null,
    jobType: criteria['Employment type'] ?? null,
    seniority: criteria['Seniority level'] ?? null,
  };
}

/** Fetches full details for one LinkedIn job. Throws RateLimitedError on 429. */
export async function fetchPosting(http, jobId) {
  const { text: html } = await http.get(`${POSTING}${jobId}`);
  return parsePosting(html);
}

/**
 * Runs the remote search, plus the local one when localSearchLocation is set, for every full-time term,
 * and a remote search for every fractional term (those items are tagged searchTrack 'fractional').
 */
export async function search({ http, config, delayMs = 1500, maxPages = 2 }) {
  const out = { items: [], requests: 0, errors: [], rateLimited: false };
  const modes = config.search.localSearchLocation ? ['remote', 'local'] : ['remote'];
  const searches = [
    ...config.search.terms.map((term) => ({ term, modes })),
    ...(config.search.fractionalTerms ?? []).map((term) => ({ term, modes: ['remote'], searchTrack: 'fractional' })),
  ];
  outer: for (const { term, modes: termModes, searchTrack } of searches) {
    for (const mode of termModes) {
      for (let page = 0; page < maxPages; page++) {
        try {
          out.requests += 1;
          const { text: html } = await http.get(
            searchUrl({ keywords: term, mode, localLocation: config.search.localSearchLocation, start: page * PAGE_SIZE }),
          );
          const items = parseSearchPage(html, mode).map((i) => (searchTrack ? { ...i, searchTrack } : i));
          out.items.push(...items);
          await http.sleep(delayMs);
          if (items.length < PAGE_SIZE) break;
        } catch (err) {
          if (err instanceof RateLimitedError) {
            out.rateLimited = true;
            break outer;
          }
          out.errors.push(`${term} (${mode}): ${err.message}`);
          break;
        }
      }
    }
  }
  return out;
}
