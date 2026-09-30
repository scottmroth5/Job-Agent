// Deterministic location check, run before any scoring so role-fit enthusiasm can never
// override a clear location conflict (v1's rule). Results:
//   remote         the source or location says the role is remote
//   home           matches a configured home location
//   unverified     location could not be extracted ("unconfirmed")
//   unknown        blank, or only a country/region such as "United States"
//   remote_signal  a specific other place, but the posting text says the role can be remote
//   conflict       a specific place outside the home area with no sign of remote work

const STATES = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut',
  DE: 'delaware', DC: 'district of columbia', FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois',
  IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland',
  MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana',
  NE: 'nebraska', NV: 'nevada', NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico', NY: 'new york',
  NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania',
  RI: 'rhode island', SC: 'south carolina', SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah',
  VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming',
};

// Locations that name no specific place a commute could conflict with.
const NON_SPECIFIC = /^(united states( of america)?|usa?|u\.s\.a?\.?|north america|americas|worldwide|global|anywhere|earth|various|multiple locations|nationwide)$/i;

// Phrases that mean the role itself can be remote. The bare word "remote" is avoided so
// industry terms like "remote patient monitoring" do not count (v1's list).
const REMOTE_SIGNALS = [
  'open to remote', 'open to it being remote', 'remote for the right', 'can be remote', 'fully remote',
  'remote position', 'remote role', 'remote opportunity', 'remote eligible', 'remote first', 'remote-first',
  'work from home', 'work from anywhere', 'telecommute', 'this is a remote', 'remote (work from home)',
  'remote within the us', 'remote in the us', 'remote, us', 'remote us', 'hiring a remote',
];

/** True when posting text says the role can be done remotely. */
export function hasRemoteSignal(text) {
  const t = String(text ?? '').toLowerCase();
  return REMOTE_SIGNALS.some((s) => t.includes(s));
}

const word = (s) => new RegExp(`(?<![\\p{L}\\p{N}])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu');

/** US states named in a location string, as two-letter codes. */
export function statesIn(location) {
  const s = String(location ?? '');
  const found = new Set();
  for (const [code, name] of Object.entries(STATES)) {
    // Codes must be uppercase in the source text so "in", "me", "or" in prose are not read as states.
    if (new RegExp(`(?<![A-Za-z])${code}(?![A-Za-z])`).test(s) || word(name).test(s)) found.add(code);
  }
  return found;
}

/**
 * Does the location match one home entry? "City, ST" entries need the city as a whole word,
 * and when the location names any state, one of them must be ST. Entries without a state
 * (region phrases such as "Anytown Metro Area") match as whole phrases.
 */
export function matchesHome(location, homeLocations = []) {
  const loc = String(location ?? '');
  const locStates = statesIn(loc);
  return homeLocations.some((entry) => {
    const m = /^(.+?),\s*([A-Za-z]{2})$/.exec(entry.trim());
    if (!m) return word(entry.trim()).test(loc);
    const [, city, state] = m;
    if (!word(city).test(loc)) return false;
    return locStates.size === 0 || locStates.has(state.toUpperCase());
  });
}

/**
 * Classifies a posting's location.
 * @param {{location?: string, workplace?: string, text?: string}} posting  workplace 'remote' when the source says so
 * @param {string[]} homeLocations
 * @returns {'remote'|'home'|'unverified'|'unknown'|'remote_signal'|'conflict'}
 */
export function checkLocation({ location, workplace, text } = {}, homeLocations = []) {
  const loc = String(location ?? '').trim();
  if (workplace === 'remote') return 'remote';
  if (/unconfirmed/i.test(loc)) return 'unverified';
  if (/\bremote\b/i.test(loc)) return 'remote';
  if (loc && matchesHome(loc, homeLocations)) return 'home';
  const parts = loc.split(/[;|]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0 || parts.every((p) => NON_SPECIFIC.test(p))) return 'unknown';
  return hasRemoteSignal(text) ? 'remote_signal' : 'conflict';
}
