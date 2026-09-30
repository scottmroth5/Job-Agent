// Loads the Candidate Knowledge doc (the system prompt for scoring and writing).
import { getGoogleAuth } from './google/auth.js';
import { readDoc } from './google/docs.js';

export const MIN_KNOWLEDGE_CHARS = 500;

/** Reads YOUR_KNOWLEDGE_DOC_ID and returns its text; throws when unset or too short to use (v1's rule). */
export async function loadKnowledge({ auth = getGoogleAuth(), docId = process.env.YOUR_KNOWLEDGE_DOC_ID } = {}) {
  if (!docId) throw new Error('YOUR_KNOWLEDGE_DOC_ID is not set in .env.');
  const { text } = await readDoc(auth, docId);
  if (text.length < MIN_KNOWLEDGE_CHARS) throw new Error(`Candidate Knowledge doc is under ${MIN_KNOWLEDGE_CHARS} characters; aborted.`);
  return text;
}
