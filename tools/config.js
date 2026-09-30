import { readFileSync, existsSync } from 'node:fs';
import { repoPath } from './paths.js';

/** Default location of the personal config. Gitignored; see config/job-search.example.json for the shape. */
export const CONFIG_PATH = repoPath('data', 'config', 'job-search.json');

/**
 * Loads and validates the personal job-search config.
 * Throws with a message naming every problem, so a bad config fails before any run starts.
 */
export function loadConfig(path = CONFIG_PATH) {
  if (!existsSync(path)) {
    throw new Error(
      `Config not found at ${path}. Create it with "npm run config:from-v1", ` +
        'or copy config/job-search.example.json and fill it in.',
    );
  }
  let config;
  try {
    config = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Config at ${path} is not valid JSON: ${err.message}`);
  }
  const problems = validateConfig(config);
  if (problems.length) throw new Error(`Config at ${path} is invalid:\n- ${problems.join('\n- ')}`);
  return config;
}

/**
 * Text for the {{homeLocations}} prompt placeholder: search.homeAreaLabel when set
 * (e.g. "the Anytown area"), otherwise the homeLocations list joined with " or ".
 * homeLocations itself ("City, ST" entries and region phrases) drives the location check in code.
 */
export function homeAreaText(config) {
  return config.search.homeAreaLabel?.trim() || config.search.homeLocations.join(' or ');
}

/** Returns a list of problems; empty when the config is usable. */
export function validateConfig(config) {
  const problems = [];
  const str = (v) => typeof v === 'string' && v.trim().length > 0;
  const strList = (v) => Array.isArray(v) && v.every(str);

  if (!str(config?.candidate?.name)) problems.push('candidate.name is required');
  for (const key of ['signoffName', 'contactLine', 'linkedin']) {
    if (config?.candidate?.[key] != null && typeof config.candidate[key] !== 'string') {
      problems.push(`candidate.${key} must be a string`);
    }
  }
  for (const key of ['terms', 'relevantTitleKeywords', 'homeLocations']) {
    const v = config?.search?.[key];
    if (!strList(v) || v.length === 0) problems.push(`search.${key} must be a non-empty list of strings`);
  }
  if (config?.search?.homeAreaLabel != null && !str(config.search.homeAreaLabel)) {
    problems.push('search.homeAreaLabel must be a non-empty string');
  }
  if (config?.search?.noiseTitleKeywords != null && !strList(config.search.noiseTitleKeywords)) {
    problems.push('search.noiseTitleKeywords must be a list of strings');
  }
  if (!Array.isArray(config?.coverLetterChecks)) {
    problems.push('coverLetterChecks must be a list (it can be empty)');
  } else {
    config.coverLetterChecks.forEach((rule, i) => {
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
          problems.push(`coverLetterChecks[${i}] has an invalid pattern: ${err.message}`);
        }
      }
    });
  }
  if (!strList(config?.privateTerms)) problems.push('privateTerms must be a list of strings');
  if (config?.allowTerms != null && !strList(config.allowTerms)) problems.push('allowTerms must be a list of strings');
  return problems;
}
