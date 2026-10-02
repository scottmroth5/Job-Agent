// Sets values in the gitignored .env file without ever printing them. Other lines are kept as they are.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { repoPath } from './paths.js';

export const ENV_PATH = repoPath('.env');

/** Sets each KEY=value (replacing an existing line, or appending). Returns the keys written, never the values. */
export function setEnvValues(values, path = ENV_PATH) {
  for (const [k, v] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new Error(`Invalid .env key: ${k}`);
    if (/[\r\n]/.test(String(v))) throw new Error(`The value for ${k} contains a line break.`);
  }
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [k, v] of Object.entries(values)) {
    const at = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (at >= 0) lines[at] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  }
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 });
  return Object.keys(values);
}

/** True when the .env file already has a non-empty value for key. */
export function hasEnvValue(key, path = ENV_PATH) {
  if (!existsSync(path)) return false;
  return readFileSync(path, 'utf8').split(/\r?\n/).some((l) => l.startsWith(`${key}=`) && l.length > key.length + 1);
}
