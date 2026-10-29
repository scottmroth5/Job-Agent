// Each user's own job search (multi-user, phase 3) and everyone's knowledge doc, in user_settings rows edited on
// Settings. The owner's search settings stay in data/config/job-search.json; everyone else keeps theirs here too. What a user may set is a fixed list of plain text fields: their own cover letter checks (which are
// regular expressions), Google site search, and private terms stay the owner's, so no user text ever becomes a pattern.
// Code that runs for a user reads the right settings without knowing whose they are: userConfigView (the server) and
// configFor (scripts) pick by the user the request or job runs as (db/scope.js).
import { currentUserId } from '../db/scope.js';
import { OWNER_ID } from '../db/users.js';
import { validateConfig } from '../tools/config.js';
import { withExcludedSites } from './excluded-sites.js';

const CONFIG_KEY = 'search.config';
const PROFILE_KEY = 'profile.text';
const SCHEDULE_KEY = 'schedule.pipeline';
export const MIN_PROFILE_CHARS = 500;
export const MAX_PROFILE_CHARS = 50000;
const MAX_ITEMS = 40;
const MAX_TEXT = 200;

const readSetting = (db, uid, key) => db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').pluck().get(uid, key) ?? null;
function writeSetting(db, uid, key, value) {
  db.prepare(`INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(uid, key, value, new Date().toISOString());
}

const text = (v, max = MAX_TEXT) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v) => (Array.isArray(v) ? v.map((s) => text(s)).filter(Boolean).slice(0, MAX_ITEMS) : []);
const money = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : null);

/** A user's settings before they have saved any: their name, and nothing to search for yet. */
export function blankConfig(name = '') {
  return {
    candidate: { name: text(name) || 'Job seeker', signoffName: '', contactLine: '', linkedin: '', website: '', github: '' },
    search: {
      terms: [], relevantTitleKeywords: [], noiseTitleKeywords: [], homeLocations: [],
      fractionalTerms: [], fractionalTitleKeywords: [], siteSearch: false, excludedSites: [],
    },
    // No fractional target until they set one (the config check wants [low, high] whenever fractional is present).
    coverLetterChecks: [],
    privateTerms: [],
    ready: false,
  };
}

/** Only the fields a user may set, cleaned; everything else comes from blankConfig. */
export function cleanConfig(input = {}, name = '') {
  const base = blankConfig(name);
  const c = input.candidate ?? {};
  const s = input.search ?? {};
  const f = input.fractional ?? {};
  const target = Array.isArray(f.targetAnnual) ? f.targetAnnual.map(money).filter(Boolean).slice(0, 2) : [];
  const config = {
    ...base,
    candidate: { name: text(c.name) || base.candidate.name, signoffName: text(c.signoffName), contactLine: text(c.contactLine), linkedin: text(c.linkedin), website: text(c.website), github: text(c.github) },
    search: {
      ...base.search,
      terms: list(s.terms),
      relevantTitleKeywords: list(s.relevantTitleKeywords),
      noiseTitleKeywords: list(s.noiseTitleKeywords),
      homeAreaLabel: text(s.homeAreaLabel),
      localSearchLocation: text(s.localSearchLocation),
      homeLocations: list(s.homeLocations),
      fractionalTerms: list(s.fractionalTerms),
      fractionalTitleKeywords: list(s.fractionalTitleKeywords),
      excludedSites: list(s.excludedSites),
    },
  };
  if (target.length === 2) {
    config.fractional = { targetAnnual: [Math.min(...target), Math.max(...target)], weeksPerYear: Math.min(52, Math.max(1, Number(f.weeksPerYear) || 48)) };
  }
  // Empty optional strings are left out, as in the owner's file (the config check wants them set or absent).
  for (const k of ['homeAreaLabel', 'localSearchLocation']) if (!config.search[k]) delete config.search[k];
  config.ready = validateConfig(config).length === 0;
  return config;
}

/** A user's search settings (never the owner's: callers use the owner's file for them). */
export function userConfig(db, uid, name = '') {
  const saved = readSetting(db, uid, CONFIG_KEY);
  if (!saved) return blankConfig(name);
  try {
    return cleanConfig(JSON.parse(saved), name);
  } catch {
    return blankConfig(name);
  }
}

/** Saves a user's search settings; returns them with ready (complete enough to search) and the problems left. */
export function saveUserConfig(db, uid, input, name = '') {
  if (uid === OWNER_ID) throw Object.assign(new Error('Your search settings live in data/config/job-search.json.'), { statusCode: 400 });
  const config = cleanConfig(input, name);
  writeSetting(db, uid, CONFIG_KEY, JSON.stringify(config));
  views.clear();
  return { config, problems: validateConfig(config) };
}

/** A user's knowledge doc (Settings), or ''. Everyone's, the owner's included. */
export const userProfile = (db, uid) => readSetting(db, uid, PROFILE_KEY) ?? '';

export function saveUserProfile(db, uid, value) {
  const body = String(value ?? '').trim();
  if (body.length > MAX_PROFILE_CHARS) throw Object.assign(new Error(`Keep it under ${MAX_PROFILE_CHARS} characters.`), { statusCode: 400 });
  writeSetting(db, uid, PROFILE_KEY, body);
  return body;
}

/** The background for scoring and writing; throws a message that says how to fix it when it is too short. */
export function profileForAI(db, uid) {
  const body = userProfile(db, uid);
  if (body.length < MIN_PROFILE_CHARS) {
    throw Object.assign(new Error(`Write your knowledge doc (at least ${MIN_PROFILE_CHARS} characters) under Settings before using AI.`), { statusCode: 400 });
  }
  return body;
}

/**
 * The background scoring and writing read for a user: their knowledge doc (Settings) when it is long enough, else
 * profileForAI's message saying how to fix it. fallback is for tests only: a stand-in for the owner's knowledge doc.
 */
export async function backgroundFor(db, uid, { fallback = null } = {}) {
  const body = userProfile(db, uid);
  if (body.length >= MIN_PROFILE_CHARS) return body;
  if (uid === OWNER_ID && fallback) return fallback();
  return profileForAI(db, uid);
}

/** Whether a user's pipeline runs on the owner's schedule too. */
export const scheduledForUser = (db, uid) => readSetting(db, uid, SCHEDULE_KEY) === 'on';
export const setScheduledForUser = (db, uid, on) => writeSetting(db, uid, SCHEDULE_KEY, on ? 'on' : 'off');

/** Active users (not the owner) who asked for their pipeline to run on the schedule. */
export function scheduledUsers(db) {
  return db
    .prepare(`SELECT s.user_id FROM user_settings s JOIN users u ON u.id = s.user_id
      WHERE s.key = ? AND s.value = 'on' AND u.status = 'active' AND u.id != ? ORDER BY u.id`)
    .pluck()
    .all(SCHEDULE_KEY, OWNER_ID);
}

const views = new Map(); // uid -> { base, db, config }, cleared when anyone saves settings or skipped sites
export const clearConfigViews = () => views.clear();

/**
 * The settings for whoever this runs as: the owner's file for the owner, else the user's own; either way with the
 * user's skipped sites (Settings) added to search.excludedSites.
 */
export function configFor(db, uid, ownerConfig) {
  const base = uid === OWNER_ID ? ownerConfig : null;
  const seen = views.get(uid);
  if (seen && seen.base === base && seen.db === db) return seen.config;
  let config = base;
  if (uid !== OWNER_ID) {
    const name = db.prepare('SELECT name FROM users WHERE id = ?').pluck().get(uid) ?? '';
    config = userConfig(db, uid, name);
  }
  config = withExcludedSites(db, uid, config);
  views.set(uid, { base, db, config });
  return config;
}

/**
 * A config object for the server that reads as the current user's settings (owner: ownerConfig). Every route keeps
 * taking `config`; which settings it sees follows the request's user, like store.db.
 */
export function userConfigView(ownerConfig, db) {
  const current = () => configFor(db, currentUserId() ?? OWNER_ID, ownerConfig);
  return new Proxy(
    {},
    {
      get: (_, prop) => current()[prop],
      has: (_, prop) => prop in current(),
      ownKeys: () => Reflect.ownKeys(current()),
      getOwnPropertyDescriptor: (_, prop) => {
        const d = Object.getOwnPropertyDescriptor(current(), prop);
        return d ? { ...d, configurable: true } : undefined;
      },
    },
  );
}
