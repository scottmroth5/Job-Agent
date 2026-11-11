// Each user's own job search (multi-user, phase 3) and everyone's knowledge doc, in user_settings rows edited on
// Settings. The owner's search settings stay in data/config/job-search.json; everyone else keeps theirs here too. What a user may set is a fixed list of plain text fields: their own cover letter checks (which are
// regular expressions), Google site search, and private terms stay the owner's, so no user text ever becomes a pattern.
// Code that runs for a user reads the right settings without knowing whose they are: userConfigView (the server) and
// configFor (scripts) pick by the user the request or job runs as (db/scope.ts).
import { AsyncLocalStorage } from 'node:async_hooks';
import { currentUserId } from '../db/scope.ts';
import { OWNER_ID } from '../db/users.ts';
import { validateConfig } from '../tools/config.ts';
import { withExcludedSites } from './excluded-sites.ts';
import type { JobSearchConfig } from '../tools/config.ts';
import type { Db } from '../tools/types.ts';

/** A user's settings: the job-search config, plus ready (complete enough to search) for anyone but the owner. */
export type UserConfig = JobSearchConfig & { ready?: boolean };

/** JSON from a request or a saved setting: every field is checked as it is read. */
type Loose = Record<string, unknown>;

const CONFIG_KEY = 'search.config';
const PROFILE_KEY = 'profile.text';
const SCHEDULE_KEY = 'schedule.pipeline';
export const MIN_PROFILE_CHARS = 500;
export const MAX_PROFILE_CHARS = 50000;
const MAX_ITEMS = 40;
const MAX_TEXT = 200;

const readSetting = async (db: Db, uid: number, key: string) =>
  (await db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').pluck().get(uid, key) as string | null | undefined) ?? null;
async function writeSetting(db: Db, uid: number, key: string, value: string) {
  await db.prepare(`INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(uid, key, value, new Date().toISOString());
}

const text = (v: unknown, max = MAX_TEXT) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v: unknown) => (Array.isArray(v) ? v.map((s) => text(s)).filter(Boolean).slice(0, MAX_ITEMS) : []);
const money = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : null);

/** A user's settings before they have saved any: their name, and nothing to search for yet. */
export function blankConfig(name = ''): UserConfig & { ready: boolean } {
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
export function cleanConfig(input: Loose = {}, name = '') {
  const base = blankConfig(name);
  const c = (input.candidate ?? {}) as Loose;
  const s = (input.search ?? {}) as Loose;
  const f = (input.fractional ?? {}) as Loose;
  const target = (Array.isArray(f.targetAnnual) ? f.targetAnnual.map(money).filter(Boolean).slice(0, 2) : []) as number[];
  const config: UserConfig & { ready: boolean } = {
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
  for (const k of ['homeAreaLabel', 'localSearchLocation'] as const) if (!config.search[k]) delete config.search[k];
  config.ready = validateConfig(config).length === 0;
  return config;
}

/** A user's search settings (never the owner's: callers use the owner's file for them). */
export async function userConfig(db: Db, uid: number, name = '') {
  const saved = await readSetting(db, uid, CONFIG_KEY);
  if (!saved) return blankConfig(name);
  try {
    return cleanConfig(JSON.parse(saved), name);
  } catch {
    return blankConfig(name);
  }
}

/** Saves a user's search settings; returns them with ready (complete enough to search) and the problems left. */
export async function saveUserConfig(db: Db, uid: number, input: Loose, name = '') {
  if (uid === OWNER_ID) throw Object.assign(new Error('Your search settings live in data/config/job-search.json.'), { statusCode: 400 });
  const config = cleanConfig(input, name);
  await writeSetting(db, uid, CONFIG_KEY, JSON.stringify(config));
  await clearConfigViews();
  return { config, problems: validateConfig(config) };
}

/** A user's knowledge doc (Settings), or ''. Everyone's, the owner's included. */
export const userProfile = async (db: Db, uid: number) => await readSetting(db, uid, PROFILE_KEY) ?? '';

/**
 * Saves a user's knowledge doc as a new version; the earlier ones are kept (profileVersions, newest first, at most
 * MAX_PROFILE_VERSIONS). source says how it came: typed, file (filled from a document), draft, or restore.
 */
export async function saveUserProfile(db: Db, uid: number, value: unknown, { source = 'typed', now = new Date() }: { source?: string; now?: Date } = {}) {
  // The versions are read and written in one transaction, so two saves at once keep both versions.
  return db.tx(async () => {
    const body = String(value ?? '').trim();
    if (body.length > MAX_PROFILE_CHARS) throw Object.assign(new Error(`Keep it under ${MAX_PROFILE_CHARS} characters.`), { statusCode: 400 });
    const versions = await profileVersions(db, uid);
    if (body && body !== versions[0]?.text) {
      const next = [{ text: body, savedAt: now.toISOString(), source: PROFILE_SOURCES.includes(source) ? source : 'typed' }, ...versions];
      await writeSetting(db, uid, VERSIONS_KEY, JSON.stringify(next.slice(0, MAX_PROFILE_VERSIONS)));
    }
    await writeSetting(db, uid, PROFILE_KEY, body);
    return body;
  });
}

export const MAX_PROFILE_VERSIONS = 20;
export const PROFILE_SOURCES = ['typed', 'file', 'draft', 'restore'];
const VERSIONS_KEY = 'profile.versions';

/** One saved version of a knowledge doc; savedAt is null for one saved before versions were dated. */
export interface ProfileVersion {
  text: string;
  savedAt: string | null;
  source: string;
}

/**
 * A user's saved knowledge doc versions, newest first. A doc saved before versions were kept
 * starts the list as its one earlier version (source earlier), so the first new save never loses it.
 */
export async function profileVersions(db: Db, uid: number): Promise<ProfileVersion[]> {
  let list: ProfileVersion[] = [];
  try {
    list = JSON.parse(await readSetting(db, uid, VERSIONS_KEY) ?? '[]');
  } catch {
    list = [];
  }
  list = Array.isArray(list) ? list.filter((v) => typeof v?.text === 'string') : [];
  const current = await userProfile(db, uid);
  if (!list.length && current) {
    const at = await db.prepare('SELECT updated_at FROM user_settings WHERE user_id = ? AND key = ?').pluck().get(uid, PROFILE_KEY) as string | undefined;
    list = [{ text: current, savedAt: at ?? null, source: 'earlier' }];
  }
  return list;
}

/** The background for scoring and writing; throws a message that says how to fix it when it is too short. */
export async function profileForAI(db: Db, uid: number) {
  const body = await userProfile(db, uid);
  if (body.length < MIN_PROFILE_CHARS) {
    throw Object.assign(new Error(`Write your knowledge doc (at least ${MIN_PROFILE_CHARS} characters) under Settings before using AI.`), { statusCode: 400 });
  }
  return body;
}

/**
 * The background scoring and writing read for a user: their knowledge doc (Settings) when it is long enough, else
 * profileForAI's message saying how to fix it. fallback is for tests only: a stand-in for the owner's knowledge doc.
 */
export async function backgroundFor(db: Db, uid: number, { fallback = null }: { fallback?: (() => string | Promise<string>) | null } = {}) {
  const body = await userProfile(db, uid);
  if (body.length >= MIN_PROFILE_CHARS) return body;
  if (uid === OWNER_ID && fallback) return fallback();
  return await profileForAI(db, uid);
}

/** Whether a user's pipeline runs on the owner's schedule too. */
export const scheduledForUser = async (db: Db, uid: number) => await readSetting(db, uid, SCHEDULE_KEY) === 'on';
export const setScheduledForUser = async (db: Db, uid: number, on: unknown) => await writeSetting(db, uid, SCHEDULE_KEY, on ? 'on' : 'off');

/** Active users (not the owner) who asked for their pipeline to run on the schedule. */
export async function scheduledUsers(db: Db): Promise<number[]> {
  return await db
    .prepare(`SELECT s.user_id FROM user_settings s JOIN users u ON u.id = s.user_id
      WHERE s.key = ? AND s.value = 'on' AND u.status = 'active' AND u.id != ? ORDER BY u.id`)
    .pluck()
    .all(SCHEDULE_KEY, OWNER_ID) as number[];
}

const views = new Map<number, { base: JobSearchConfig | null; db: Db; config: UserConfig }>(); // uid -> { base, db, config }, cleared when anyone saves settings or skipped sites
/**
 * The settings loaded for the current request or job (withUserConfig), which userConfigView answers from. A Proxy
 * must answer at once, so the settings are read before the route runs, never during a read.
 */
const loaded = new AsyncLocalStorage<{ uid: number; db: Db; ownerConfig: JobSearchConfig; config: UserConfig }>();

/** Drops the cached settings after a save, and reloads the current request's, so the rest of it sees the save. */
export async function clearConfigViews() {
  views.clear();
  const current = loaded.getStore();
  if (current) current.config = await configFor(current.db, current.uid, current.ownerConfig);
}

/** Runs fn with uid's settings loaded (configFor), so userConfigView answers from them for everything fn starts. */
export async function withUserConfig<T>(db: Db, uid: number, ownerConfig: JobSearchConfig, fn: () => T): Promise<Awaited<T>> {
  const config = await configFor(db, uid, ownerConfig);
  return await loaded.run({ uid, db, ownerConfig, config }, fn);
}

/**
 * The settings for whoever this runs as: the owner's file for the owner, else the user's own; either way with the
 * user's skipped sites (Settings) added to search.excludedSites.
 */
export async function configFor(db: Db, uid: number, ownerConfig: JobSearchConfig): Promise<UserConfig> {
  const base = uid === OWNER_ID ? ownerConfig : null;
  const seen = views.get(uid);
  if (seen && seen.base === base && seen.db === db) return seen.config;
  let config: UserConfig | null = base;
  if (uid !== OWNER_ID) {
    const name = (await db.prepare('SELECT name FROM users WHERE id = ?').pluck().get(uid) as string | null | undefined) ?? '';
    config = await userConfig(db, uid, name);
  }
  // config is set: the owner has ownerConfig, anyone else their own settings.
  config = await withExcludedSites(db, uid, config as UserConfig);
  views.set(uid, { base, db, config });
  return config;
}

/**
 * A config object for the server that reads as the current user's settings (owner: ownerConfig). Every route keeps
 * taking `config`; which settings it sees follows the request's user, like store.db. The settings are the ones
 * withUserConfig loaded for this request or job (the server's preHandler does it), else the cached ones for this user.
 */
export function userConfigView(ownerConfig: JobSearchConfig, db: Db): UserConfig {
  const current = (): UserConfig => {
    const uid = currentUserId() ?? OWNER_ID;
    const here = loaded.getStore();
    if (here && here.uid === uid && here.db === db) return here.config;
    const seen = views.get(uid);
    if (seen && seen.base === (uid === OWNER_ID ? ownerConfig : null) && seen.db === db) return seen.config;
    throw new Error('The settings were read before they were loaded: run this inside withUserConfig (agents/user-config.ts).');
  };
  // The proxy answers every read from the current user's settings, so it is used as their config.
  return new Proxy(
    {},
    {
      get: (_, prop) => (current() as unknown as Record<string | symbol, unknown>)[prop],
      has: (_, prop) => prop in current(),
      ownKeys: () => Reflect.ownKeys(current()),
      getOwnPropertyDescriptor: (_, prop) => {
        const d = Object.getOwnPropertyDescriptor(current(), prop);
        return d ? { ...d, configurable: true } : undefined;
      },
    },
  ) as UserConfig;
}
