// Each user's cover letter header (Settings > Cover letter header): name, email, phone, an optional location, the
// sign-off name, and links, in user_settings. Until a user saves one it is built from their settings (the owner's file,
// or their saved search) by tools/letter-header.js fromCandidate, so nothing changes until they edit it. Every letter
// document (Word, PDF, the Google Doc, the pipeline's letters) reads it through letterHeader.
import { getUserSetting, setUserSetting } from '../db/settings.js';
import { fromCandidate, hrefOf, isEmail } from '../tools/letter-header.js';

const KEY = 'letter.header';
export const MAX_LINKS = 6;
const MAX = { name: 120, signoffName: 120, email: 200, phone: 40, location: 120, link: 300 };
const bad = (message) => Object.assign(new Error(message), { statusCode: 400 });

/** The current user's header: their saved one, else one from config.candidate. saved says which. */
export function letterHeader(db, config) {
  const raw = getUserSetting(db, KEY);
  if (raw) {
    try {
      return { ...clean(JSON.parse(raw)), saved: true };
    } catch {
      // A damaged setting falls back to the settings, like no setting.
    }
  }
  return { ...fromCandidate(config?.candidate ?? {}), saved: false };
}

/** The fields as stored: trimmed, with links that are web addresses (https:// added when left off). */
function clean(h = {}) {
  const text = (v, max) => String(v ?? '').trim().slice(0, max);
  return {
    name: text(h.name, MAX.name),
    signoffName: text(h.signoffName, MAX.signoffName),
    email: text(h.email, MAX.email),
    phone: text(h.phone, MAX.phone),
    location: text(h.location, MAX.location),
    links: (Array.isArray(h.links) ? h.links : []).map((l) => text(l, MAX.link)).filter(Boolean).slice(0, MAX_LINKS),
  };
}

/** Saves the current user's header after checking it; returns it as letterHeader does. */
export function saveLetterHeader(db, input) {
  const h = clean(input);
  if (!h.name) throw bad('Enter your name as it should appear on your letters.');
  if (h.email && !isEmail(h.email)) throw bad('That email address does not look right.');
  for (const link of h.links) {
    const url = hrefOf(link);
    if (!url || url.startsWith('mailto:')) throw bad(`"${link}" is not a web address. Use one such as github.com/yourname or https://yoursite.com.`);
  }
  setUserSetting(db, KEY, JSON.stringify(h));
  return { ...h, saved: true };
}
