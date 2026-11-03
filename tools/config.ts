import { readFileSync, existsSync } from 'node:fs';
import { dataPath } from './paths.ts';

/** The job-search config (config/job-search.example.json shows one); validateConfig checks a file against it. */
export interface JobSearchConfig {
  candidate: {
    name: string;
    signoffName?: string;
    contactLine?: string;
    linkedin?: string;
    website?: string;
    github?: string;
  };
  search: {
    terms: string[];
    relevantTitleKeywords: string[];
    noiseTitleKeywords?: string[];
    homeAreaLabel?: string;
    localSearchLocation?: string;
    homeLocations: string[];
    fractionalTerms?: string[];
    fractionalTitleKeywords?: string[];
    siteSearch?: boolean;
    excludedSites?: string[];
  };
  fractional?: { targetAnnual: [number, number]; weeksPerYear?: number };
  /** A text pattern, or a sentence with both patterns (each a case-insensitive regular expression). */
  coverLetterChecks: Array<{ label: string; text?: string; sentence?: [string, string] }>;
  privateTerms: string[];
  allowTerms?: string[];
}

/** Default location of the personal config. Gitignored; see config/job-search.example.json for the shape. */
export const CONFIG_PATH = dataPath('config', 'job-search.json');

/**
 * Loads and validates the personal job-search config.
 * Throws with a message naming every problem, so a bad config fails before any run starts.
 */
export function loadConfig(path = CONFIG_PATH): JobSearchConfig {
  if (!existsSync(path)) {
    throw new Error(
      `Config not found at ${path}. Create it with "npm run config:from-v1", ` +
        'or copy config/job-search.example.json and fill it in.',
    );
  }
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Config at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  const problems = validateConfig(config);
  if (problems.length) throw new Error(`Config at ${path} is invalid:\n- ${problems.join('\n- ')}`);
  return config as JobSearchConfig;
}

/**
 * Text for the {{homeLocations}} prompt placeholder: search.homeAreaLabel when set
 * (e.g. "the Anytown area"), otherwise the homeLocations list joined with " or ".
 * homeLocations itself ("City, ST" entries and region phrases) drives the location check in code.
 */
export function homeAreaText(config: Pick<JobSearchConfig, 'search'>) {
  return config.search.homeAreaLabel?.trim() || config.search.homeLocations.join(' or ');
}

/** Returns a list of problems; empty when the config is usable. */
// any: this checks JSON of unknown shape, and every read below is guarded (optional chaining and typeof).
export function validateConfig(config: any): string[] {
  const problems: string[] = [];
  const str = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
  const strList = (v: unknown): v is string[] => Array.isArray(v) && v.every(str);

  if (!str(config?.candidate?.name)) problems.push('candidate.name is required');
  for (const key of ['signoffName', 'contactLine', 'linkedin', 'website', 'github']) {
    if (config?.candidate?.[key] != null && typeof config.candidate[key] !== 'string') {
      problems.push(`candidate.${key} must be a string`);
    }
  }
  for (const key of ['terms', 'relevantTitleKeywords', 'homeLocations']) {
    const v = config?.search?.[key];
    if (!strList(v) || v.length === 0) problems.push(`search.${key} must be a non-empty list of strings`);
  }
  for (const key of ['homeAreaLabel', 'localSearchLocation']) {
    if (config?.search?.[key] != null && !str(config.search[key])) problems.push(`search.${key} must be a non-empty string`);
  }
  if (config?.search?.siteSearch != null && typeof config.search.siteSearch !== 'boolean') problems.push('search.siteSearch must be true or false');
  for (const key of ['fractionalTerms', 'fractionalTitleKeywords', 'excludedSites']) {
    if (config?.search?.[key] != null && !strList(config.search[key])) problems.push(`search.${key} must be a list of strings`);
  }
  const f = config?.fractional;
  if (f != null) {
    const t = f.targetAnnual;
    if (!Array.isArray(t) || t.length !== 2 || !t.every((n: unknown) => typeof n === 'number' && n > 0)) {
      problems.push('fractional.targetAnnual must be [low, high] in dollars');
    }
    if (f.weeksPerYear != null && !(typeof f.weeksPerYear === 'number' && f.weeksPerYear > 0 && f.weeksPerYear <= 52)) {
      problems.push('fractional.weeksPerYear must be a number from 1 to 52');
    }
  }
  if (config?.search?.noiseTitleKeywords != null && !strList(config.search.noiseTitleKeywords)) {
    problems.push('search.noiseTitleKeywords must be a list of strings');
  }
  if (!Array.isArray(config?.coverLetterChecks)) {
    problems.push('coverLetterChecks must be a list (it can be empty)');
  } else {
    // any: one rule from the same unchecked JSON.
    config.coverLetterChecks.forEach((rule: any, i: number) => {
      if (!str(rule?.label)) problems.push(`coverLetterChecks[${i}].label is required`);
      const patterns = rule?.text != null ? [rule.text] : Array.isArray(rule?.sentence) ? rule.sentence : null;
      if (!patterns || (rule.sentence && rule.sentence.length !== 2)) {
        problems.push(`coverLetterChecks[${i}] needs "text" or a two-item "sentence"`);
        return;
      }
      for (const p of patterns) {
        try {
          new RegExp(p, 'i');
        } catch (err) {
          problems.push(`coverLetterChecks[${i}] has an invalid pattern: ${(err as Error).message}`);
        }
      }
    });
  }
  if (!strList(config?.privateTerms)) problems.push('privateTerms must be a list of strings');
  if (config?.allowTerms != null && !strList(config.allowTerms)) problems.push('allowTerms must be a list of strings');
  return problems;
}
