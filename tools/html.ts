// HTML helpers for job pages: readable text for Claude, and structured JobPosting data
// (schema.org JSON-LD), which most job boards and ATS pages embed.

// any: JSON-LD parsed from a web page has no fixed shape; every field read below is checked first.
type JsonLd = any;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', hellip: '...', bull: '*' };

export function decodeEntities(s: string | null | undefined) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Escapes text for safe insertion into HTML (element content and quoted attributes). */
export function escapeHtml(s: unknown) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Converts HTML to plain text, keeping paragraph and list structure as line breaks. */
export function htmlToText(html: string | null | undefined) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<(script|style|noscript|svg|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|section|article|header|footer)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n+- /g, '\n- ') // list items sit on consecutive lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function* jsonLdObjects(html: string | null | undefined): Generator<JsonLd> {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of String(html ?? '').matchAll(re)) {
    let data: JsonLd;
    try {
      data = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const queue = Array.isArray(data) ? [...data] : [data];
    while (queue.length) {
      const obj = queue.shift();
      if (!obj || typeof obj !== 'object') continue;
      if (Array.isArray(obj['@graph'])) queue.push(...obj['@graph']);
      yield obj;
    }
  }
}

const isJobPosting = (o: JsonLd) => (Array.isArray(o['@type']) ? o['@type'] : [o['@type']]).includes('JobPosting');

function formatLocation(jobLocation: JsonLd) {
  const places = Array.isArray(jobLocation) ? jobLocation : jobLocation ? [jobLocation] : [];
  const parts = places
    .map((p: JsonLd) => p?.address ?? p)
    .map((a: JsonLd) => (typeof a === 'string' ? a : [a?.addressLocality, a?.addressRegion].filter(Boolean).join(', ')))
    .filter(Boolean);
  return [...new Set(parts)].join('; ') || null;
}

function formatSalary(baseSalary: JsonLd) {
  const v = baseSalary?.value;
  if (!v) return null;
  const k = (n: unknown) => `$${Math.round(Number(n) / 1000)}k`;
  if (v.minValue && v.maxValue) return `${k(v.minValue)} - ${k(v.maxValue)}`;
  if (v.value) return k(v.value);
  return null;
}

/**
 * The first schema.org JobPosting in the page, normalized; null when there is none.
 * remote is true when jobLocationType is TELECOMMUTE.
 */
export function extractJobPosting(html: string | null | undefined) {
  for (const obj of jsonLdObjects(html)) {
    if (!isJobPosting(obj)) continue;
    const org = obj.hiringOrganization;
    return {
      title: obj.title ? decodeEntities(obj.title).trim() : null,
      company: (typeof org === 'string' ? org : org?.name)?.trim() || null,
      description: obj.description ? htmlToText(decodeEntities(obj.description)) : null,
      datePosted: obj.datePosted ?? null,
      location: formatLocation(obj.jobLocation),
      remote: /telecommute/i.test(String(obj.jobLocationType ?? '')),
      employmentType: Array.isArray(obj.employmentType) ? obj.employmentType.join(', ') : obj.employmentType ?? null,
      salary: formatSalary(obj.baseSalary),
    };
  }
  return null;
}
