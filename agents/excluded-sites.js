// Job sites each user skips (Settings > Job sites to skip, or Skip this site in the job panel): a domain such as
// "example-jobs.com" with the user's note on why, in user_settings. A skipped site's links are never kept: discovery
// and manual add drop them, scoring gives 1, and cleanup removes saved ones (tools/listings.js). The list is added to
// search.excludedSites from the settings file (the owner's) or the user's saved search, so every caller of
// config.search.excludedSites sees both (agents/user-config.js configFor).
import { OWNER_ID } from '../db/users.js';

const KEY = 'search.excludedSites';
export const MAX_SITES = 100;
export const MAX_NOTE = 300;

const bad = (message) => Object.assign(new Error(message), { statusCode: 400 });

/**
 * The site a link or domain belongs to, as a lowercase host without "www." ("https://www.example.com/jobs/1" and
 * "Example.com" are both "example.com"); throws a message saying what to enter when it is not a site.
 */
export function siteOf(input) {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw || raw.length > 300) throw bad('Enter a site such as example-jobs.com, or a link to a job on it.');
  let host;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`).hostname;
  } catch {
    host = '';
  }
  host = host.replace(/^www\./, '');
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((l) => /^[a-z0-9-]{1,63}$/.test(l)) || !/^[a-z]{2,}$/.test(labels.at(-1))) {
    throw bad('Enter a site such as example-jobs.com, or a link to a job on it.');
  }
  return host;
}

const read = (db, uid) => {
  const raw = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').pluck().get(uid, KEY);
  if (raw == null) return null;
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((s) => s && typeof s.site === 'string') : [];
  } catch {
    return [];
  }
};

function write(db, uid, list) {
  db.prepare(`INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(uid, KEY, JSON.stringify(list), new Date().toISOString());
}

/**
 * A user's skipped sites, oldest first: { site, note, addedAt }. Someone other than the owner who listed sites in their
 * search settings before this list existed starts with those (legacy), so nothing they skipped comes back.
 */
export function excludedSites(db, uid, { legacy = [] } = {}) {
  const saved = read(db, uid);
  if (saved) return saved;
  return uid === OWNER_ID ? [] : [...new Set(legacy.map((s) => String(s).toLowerCase()))].map((site) => ({ site, note: '', addedAt: null }));
}

/** Adds a site (a link or a domain), or updates its note when it is already listed. Returns { site, list }. */
export function addExcludedSite(db, uid, { site, note = '' }, opts = {}) {
  const host = siteOf(site);
  const text = String(note ?? '').trim().slice(0, MAX_NOTE);
  const list = excludedSites(db, uid, opts);
  const at = list.findIndex((s) => s.site === host);
  if (at >= 0) list[at] = { ...list[at], note: text || list[at].note };
  else {
    if (list.length >= MAX_SITES) throw bad(`You can skip up to ${MAX_SITES} sites.`);
    list.push({ site: host, note: text, addedAt: new Date().toISOString() });
  }
  write(db, uid, list);
  return { site: host, list };
}

/** Changes a listed site's note. */
export function setExcludedSiteNote(db, uid, site, note, opts = {}) {
  const list = excludedSites(db, uid, opts);
  const at = list.findIndex((s) => s.site === site);
  if (at < 0) throw Object.assign(new Error('That site is not on your list.'), { statusCode: 404 });
  list[at] = { ...list[at], note: String(note ?? '').trim().slice(0, MAX_NOTE) };
  write(db, uid, list);
  return list;
}

/** Takes a site off the list; its jobs are found again from the next run on (removed jobs stay removed). */
export function removeExcludedSite(db, uid, site, opts = {}) {
  const list = excludedSites(db, uid, opts);
  const next = list.filter((s) => s.site !== site);
  if (next.length === list.length) throw Object.assign(new Error('That site is not on your list.'), { statusCode: 404 });
  write(db, uid, next);
  return next;
}

/** The config with the user's list added to search.excludedSites (a new object; the base is not changed). */
export function withExcludedSites(db, uid, config) {
  if (!config?.search) return config;
  const base = config.search.excludedSites ?? [];
  // The owner's file entries stay; anyone else's saved-search entries moved into the list (see excludedSites).
  const own = excludedSites(db, uid, { legacy: base }).map((s) => s.site);
  if (uid === OWNER_ID && !own.length) return config; // nothing skipped on Settings: the file as it is
  const sites = uid === OWNER_ID ? [...new Set([...base, ...own])] : own;
  return { ...config, search: { ...config.search, excludedSites: sites } };
}
