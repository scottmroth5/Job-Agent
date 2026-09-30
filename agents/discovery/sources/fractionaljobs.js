// Fractional Jobs (fractionaljobs.io): public listing of fractional roles; robots.txt allows crawling.
// The home page lists the latest ~64 roles with hours, pay, and location on each card; the job page
// adds company stage, industry, notes such as "convert full-time", and the description.
import { decodeEntities, htmlToText } from '../../../tools/html.js';
import { RateLimitedError } from '../../../tools/http.js';
import { parseRate, parseHours } from '../../../tools/rates.js';

export const SOURCE = 'Fractional Jobs';
const BASE = 'https://www.fractionaljobs.io';
const text = (s) => decodeEntities(String(s ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function isoFromLongDate(s) {
  const d = new Date(`${s} 12:00 UTC`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Parses the listing cards on the home page into common items (search track 'fractional'). */
export function parseListing(html) {
  return String(html ?? '')
    .split('job-item w-dyn-item')
    .slice(1)
    .map((card) => {
      const href = /href="(\/jobs\/[^"#?]+)"/.exec(card)?.[1];
      const heads = [...card.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)].map((m) => text(m[1])).filter((t) => t && t !== '-');
      const inline = [...card.matchAll(/<div class="text-inline">([\s\S]*?)<\/div>/g)].map((m) => text(m[1])).filter((t) => t && !['|', '(', ')', 'added'].includes(t));
      const hoursText = inline.find((t) => /\bhrs?\b|hours?/i.test(t)) ?? null;
      const rateText = inline.find((t) => t.includes('$')) ?? null;
      const location = inline.find((t) => t !== hoursText && t !== rateText) ?? null;
      const date = /<div class="date">([^<]+)</.exec(card)?.[1]?.trim();
      if (!href || heads.length < 1) return null;
      const title = heads[heads.length - 1];
      const company = heads.length > 1 ? heads[0] : null;
      const hours = parseHours(hoursText);
      return {
        source: SOURCE,
        sourceJobId: href.replace('/jobs/', ''),
        url: `${BASE}${href}`,
        company,
        title,
        location,
        workplace: /\bremote\b/i.test(location ?? '') ? 'remote' : null,
        postedOn: date ? isoFromLongDate(date) : null,
        salary: rateText,
        rateText,
        rate: parseRate(rateText),
        hoursText,
        hours,
        jobType: 'Fractional',
        searchTrack: 'fractional',
        description: null,
        fetchDetails: (http) => fetchPosting(http, `${BASE}${href}`),
      };
    })
    .filter(Boolean);
}

/** The value following a labeled field on the job page ("Weekly Commitment" -> "5 - 10 hrs"). */
function labeled(html, label) {
  const i = html.indexOf(`>${label}<`);
  if (i < 0) return null;
  const after = html.slice(i + label.length + 2, i + 1500);
  const value = /<[^>]+>\s*([^<\s][^<]*?)\s*</.exec(after)?.[1];
  return value ? decodeEntities(value).trim() : null;
}

/** Parses a job page: description text plus the labeled terms and notes. */
export function parsePosting(html) {
  const s = String(html ?? '');
  const start = s.indexOf('w-richtext');
  const body = start >= 0 ? s.slice(s.indexOf('>', start) + 1, s.indexOf('</div>', start)) : '';
  const lower = s.toLowerCase();
  const notes = ['convert full-time', 'moonlight ok', 'equity', 'contract to hire'].filter((n) => lower.includes(`>${n}<`));
  return {
    description: body ? htmlToText(body) : null,
    hoursText: labeled(s, 'Weekly Commitment'),
    rateText: labeled(s, 'Compensation Range'),
    location: labeled(s, 'Location'),
    extra: {
      companyStage: labeled(s, 'Company Stage'),
      industry: labeled(s, 'Industry'),
      notes,
    },
  };
}

export async function fetchPosting(http, url) {
  const { text: html } = await http.get(url, { headers: { Accept: 'text/html' } });
  return parsePosting(html);
}

/** One request: the home page listing. Job pages are fetched later, only for new postings. */
export async function search({ http }) {
  const out = { items: [], requests: 1, errors: [], rateLimited: false };
  try {
    const { text: html } = await http.get(BASE, { headers: { Accept: 'text/html' } });
    out.items = parseListing(html);
  } catch (err) {
    if (err instanceof RateLimitedError) out.rateLimited = true;
    else out.errors.push(err.message);
  }
  return out;
}
