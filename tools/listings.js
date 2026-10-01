// Postings that are never kept, whatever their score:
//   - job-list pages (search results, "CTO Jobs and Vacancies", "VP Engineering jobs in Remote -
//     Indeed") that come back from Google results and aggregators: they cannot be scored or applied to
//   - links to sites in config.search.excludedSites (for example sites that charge to apply)
// Discovery and manual add drop them, scoring gives them a 1 by rule, and archiveListings removes saved ones.
// Kept narrow on purpose: "(2 Openings)" titles and Workday links with "Search" in the path are real jobs.

// Titles that describe a set of jobs. A single role is never titled "... Jobs" or "... Vacancies".
const LIST_TITLE = [/\bjobs\b/i, /\bvacancies\b/i, /\bjob (listings|search|board)\b/i];

// Search and browse pages on job boards (a link to one posting on the same site is not matched).
const LIST_URL = [
  /indeed\.[a-z.]+\/(q-|jobs\?|m\/jobs\?|[a-z-]+-jobs(\.html|\/|$))/i,
  /ziprecruiter\.com\/(jobs-search|candidate\/search|Jobs\/)/,
  /glassdoor\.[a-z.]+\/Job\/.*SRCH/i,
  /simplyhired\.[a-z.]+\/search/i,
  /monster\.[a-z.]+\/jobs\/(search|q-)/i,
  /talent\.com\/jobs\?/i,
  /linkedin\.com\/jobs\/(search|collections)(?![^#]*currentJobId=)/i,
];

/**
 * Returns a short reason when a posting looks like a list of jobs rather than one job, else null.
 * @param {{title?: string, url?: string}} posting
 */
export function listingReason({ title, url } = {}) {
  if (LIST_TITLE.some((re) => re.test(String(title ?? '')))) return 'the title describes a list of jobs';
  if (LIST_URL.some((re) => re.test(String(url ?? '')))) return 'the link is a job search page';
  return null;
}

export const isListingPage = (posting) => listingReason(posting) !== null;

/** The entry of sites (domains such as "example.com") that a link belongs to, subdomains included, else null. */
export function excludedSite(url, sites = []) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  return (
    sites.find((site) => {
      const domain = site.toLowerCase().replace(/^www\./, '');
      return host === domain || host.endsWith(`.${domain}`);
    }) ?? null
  );
}

/** Why a posting is never kept (an excluded site or a list of jobs), else null. config is optional. */
export function skipReason(posting, config) {
  const site = excludedSite(posting?.url, config?.search?.excludedSites);
  if (site) return `excluded site (${site})`;
  const listing = listingReason(posting);
  return listing ? `not a single job (${listing})` : null;
}
