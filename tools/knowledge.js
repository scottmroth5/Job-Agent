// The owner's background for scoring and writing: their About you in the app (Settings) once it is there, else the
// Candidate Knowledge Google Doc (YOUR_KNOWLEDGE_DOC_ID), read here.
import { getGoogleAuth } from './google/auth.js';
import { readDoc } from './google/docs.js';
import { backgroundFor } from '../agents/user-config.js';
import { OWNER_ID } from '../db/users.js';

export const MIN_KNOWLEDGE_CHARS = 500;

/** Reads YOUR_KNOWLEDGE_DOC_ID and returns its text; throws when unset or too short to use (v1's rule). */
export async function loadKnowledge({ auth = getGoogleAuth(), docId = process.env.YOUR_KNOWLEDGE_DOC_ID } = {}) {
  if (!docId) throw new Error('YOUR_KNOWLEDGE_DOC_ID is not set in .env.');
  const { text } = await readDoc(auth, docId);
  if (text.length < MIN_KNOWLEDGE_CHARS) throw new Error(`Candidate Knowledge doc is under ${MIN_KNOWLEDGE_CHARS} characters; aborted.`);
  return text;
}

/** The owner's background for scripts: About you when saved in the app, else the Google Doc (only read when needed). */
export function ownerBackground(store, { auth } = {}) {
  return backgroundFor(store.raw ?? store.db, OWNER_ID, { googleDoc: () => loadKnowledge(auth ? { auth } : {}) });
}
