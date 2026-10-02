// Email bodies at rest: AES-256-GCM with a key from .env (EMAIL_ENC_KEY, 32 bytes as base64 or hex).
// Stored form: "v1:<iv>:<tag>:<ciphertext>", each base64. Losing the key makes stored bodies unreadable.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

/** A new random key, base64, for EMAIL_ENC_KEY. */
export const newKey = () => randomBytes(32).toString('base64');

/** The 32-byte key from env, or a clear error. Never includes the key in the message. */
export function loadKey(env = process.env) {
  const raw = env.EMAIL_ENC_KEY;
  if (!raw) throw new Error('EMAIL_ENC_KEY is not set. Run "npm run inbox:auth", which creates one in .env.');
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('EMAIL_ENC_KEY must be 32 bytes (base64 or 64 hex characters).');
  return key;
}

export function encrypt(text, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

/** Throws when the value was changed or the key is wrong (GCM authentication). */
export function decrypt(stored, key) {
  const [version, iv, tag, data] = String(stored).split(':');
  if (version !== VERSION || !iv || !tag || data === undefined) throw new Error('Not an encrypted email body.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
