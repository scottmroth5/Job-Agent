// The shapes discovery passes around (type-only). Every source maps its results to a JobItem; resolveDetails
// (details.ts) fills in what the source left out and records how it got the text.
import type { Http } from '../../tools/http.ts';
import type { JobSearchConfig } from '../../tools/config.ts';
import type { Hours, Rate } from '../../tools/rates.ts';

/** What a source's own page reader adds (Fractional Jobs' job pages). */
export interface PostingDetails {
  description: string | null;
  hoursText?: string | null;
  rateText?: string | null;
  location?: string | null;
  extra?: Record<string, unknown>;
}

/** One job as a source found it, before it is stored. */
export interface JobItem {
  source: string;
  sourceJobId?: string | null;
  linkedinJobId?: string | null;
  url: string | null;
  company: string | null;
  /** Null or empty until a page supplies one (LinkedIn may not). */
  title: string | null;
  location?: string | null;
  workplace?: string | null;
  postedOn?: string | null;
  salary?: string | null;
  jobType?: string | null;
  description: string | null;
  rateText?: string | null;
  rate?: Rate | null;
  hoursText?: string | null;
  hours?: Hours | null;
  /** 'fractional' when the item came from a fractional search. */
  searchTrack?: string;
  searchTerm?: string;
  fetchDetails?: (http: Http) => Promise<PostingDetails>;
  extra?: Record<string, unknown>;
  /** Set by resolveDetails: ok, thin, no_url, needs_browser, blocked, rate_limited, timeout, error, or http_<status>. */
  fetchStatus?: string;
  fetchMethod?: string | null;
}

/** What one source's search returns. */
export interface SourceResult {
  items: JobItem[];
  requests: number;
  errors: string[];
  rateLimited: boolean;
}

/** What a source's search runs with. */
export interface SourceContext {
  http: Http;
  config: JobSearchConfig;
  delayMs?: number;
}

/** The headless browser (tools/browser.ts createBrowser), or null when none is available. */
export interface PageRenderer {
  renderPage(url: string): Promise<{ html: string; text: string } | null>;
}
