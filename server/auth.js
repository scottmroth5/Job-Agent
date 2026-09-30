// Access control. Today the server is for this computer only (AUTH_MODE=none), and it refuses to
// listen anywhere but localhost in that mode. Phone access from anywhere (the cloud move) adds a
// real mode here; routes do not change.

export const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];

/** Throws unless the host is allowed for the auth mode. */
export function assertSafeBinding({ host, mode = 'none' }) {
  if (mode === 'none' && !LOOPBACK.includes(host)) {
    throw new Error(`AUTH_MODE=none only allows localhost; refusing to listen on ${host}. Add a login mode before exposing the server.`);
  }
  if (mode !== 'none') throw new Error(`AUTH_MODE "${mode}" is not implemented yet.`);
}

/** Registers the auth hook. With mode 'none' every request is allowed (the server is loopback-only). */
export function registerAuth(app, { mode = 'none' } = {}) {
  if (mode === 'none') return;
  throw new Error(`AUTH_MODE "${mode}" is not implemented yet.`);
}
