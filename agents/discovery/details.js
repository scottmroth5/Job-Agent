// Fills in a new posting's full text (and missing company/title/location) before it is stored.
// Order: text from the source itself -> LinkedIn guest endpoint -> the page's JobPosting
// JSON-LD -> the page as plain text -> headless browser for pages that need JavaScript.
import { extractJobPosting, htmlToText } from '../../tools/html.js';
import { HttpError, RateLimitedError } from '../../tools/http.js';
import { fetchPosting } from './sources/linkedin.js';

export const MIN_DESCRIPTION = 200; // shorter text is treated as missing
export const MIN_PAGE_TEXT = 800; // plain page text shorter than this is probably a JS shell
export const MAX_TEXT = 20000; // stored text is capped; prompts trim further
export const LINKEDIN_BACKOFF_MS = 60000; // one pause after LinkedIn's first 429, before giving up for the run

const cap = (s) => (s && s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s);

function applyJobPosting(item, jp) {
  item.company ??= jp.company;
  if (!item.title) item.title = jp.title ?? item.title;
  item.location ??= jp.location;
  if (jp.remote) item.workplace = 'remote';
  item.postedOn ??= jp.datePosted ? String(jp.datePosted).slice(0, 10) : null;
  item.salary ??= jp.salary;
  item.jobType ??= jp.employmentType;
}

/**
 * Resolves details in place and returns the item with fetchStatus/fetchMethod set.
 * state.linkedinBlocked is shared across calls: after a LinkedIn 429 no more LinkedIn requests are made.
 */
export async function resolveDetails(item, { http, browser, state = {} }) {
  if (item.description && item.description.length >= MIN_DESCRIPTION) {
    return Object.assign(item, { description: cap(item.description), fetchStatus: 'ok', fetchMethod: 'source' });
  }

  if (item.linkedinJobId) {
    if (state.linkedinBlocked) return Object.assign(item, { fetchStatus: 'rate_limited', fetchMethod: null });
    try {
      let p;
      try {
        p = await fetchPosting(http, item.linkedinJobId);
      } catch (err) {
        // First 429 of the run: wait once and retry; a second 429 blocks LinkedIn for the rest of the run.
        if (!(err instanceof RateLimitedError) || state.linkedinBackedOff) throw err;
        state.linkedinBackedOff = true;
        await http.sleep(LINKEDIN_BACKOFF_MS);
        p = await fetchPosting(http, item.linkedinJobId);
      }
      item.jobType ??= p.jobType;
      if (p.description && p.description.length >= MIN_DESCRIPTION) {
        return Object.assign(item, { description: cap(p.description), fetchStatus: 'ok', fetchMethod: 'linkedin' });
      }
      return Object.assign(item, { fetchStatus: 'thin', fetchMethod: 'linkedin' });
    } catch (err) {
      if (err instanceof RateLimitedError) state.linkedinBlocked = true;
      return Object.assign(item, { fetchStatus: failure(err), fetchMethod: null });
    }
  }

  if (!item.url) return Object.assign(item, { fetchStatus: 'no_url', fetchMethod: null });

  let pageText = '';
  try {
    const { text: html } = await http.get(item.url, { headers: { Accept: 'text/html,application/xhtml+xml' } });
    const jp = extractJobPosting(html);
    if (jp) applyJobPosting(item, jp);
    if (jp?.description && jp.description.length >= MIN_DESCRIPTION) {
      return Object.assign(item, { description: cap(jp.description), fetchStatus: 'ok', fetchMethod: 'jsonld' });
    }
    pageText = htmlToText(html);
    if (pageText.length >= MIN_PAGE_TEXT) {
      return Object.assign(item, { description: cap(pageText), fetchStatus: 'ok', fetchMethod: 'html' });
    }
  } catch (err) {
    if (!(err instanceof HttpError) || ![401, 403].includes(err.status)) {
      return Object.assign(item, { fetchStatus: failure(err), fetchMethod: null });
    }
    // 401/403 often means bot protection that a real browser gets past; fall through.
  }

  if (!browser) return Object.assign(item, { fetchStatus: 'needs_browser', fetchMethod: null });
  try {
    const rendered = await browser.renderPage(item.url);
    if (!rendered) return Object.assign(item, { fetchStatus: 'needs_browser', fetchMethod: null });
    const jp = extractJobPosting(rendered.html);
    if (jp) applyJobPosting(item, jp);
    const text = jp?.description && jp.description.length >= MIN_DESCRIPTION ? jp.description : rendered.text?.trim();
    if (text && text.length >= MIN_DESCRIPTION) {
      return Object.assign(item, { description: cap(text), fetchStatus: 'ok', fetchMethod: 'browser' });
    }
    return Object.assign(item, { fetchStatus: 'thin', fetchMethod: 'browser' });
  } catch (err) {
    return Object.assign(item, { fetchStatus: failure(err), fetchMethod: 'browser' });
  }
}

/** Fetch statuses worth retrying on a later run (temporary failures, not "no text on the page"). */
export const RETRYABLE = ['rate_limited', 'timeout', 'error', 'needs_browser', 'http_429', 'http_500', 'http_502', 'http_503', 'http_504'];

function failure(err) {
  if (err instanceof RateLimitedError) return 'rate_limited';
  if (err instanceof HttpError) return `http_${err.status}`;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'timeout';
  return 'error';
}
