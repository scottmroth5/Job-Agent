// The public demo on this computer: rebuilds the sample database in demo-data/ and serves it read-only at
// http://localhost:5180, with no sign-in and every outside service off. It never reads .env, so no key or token
// is loaded. npm run demo (run npm run web:build first, or npm run demo after npm run ui once).
process.env.DATA_DIR ||= 'demo-data';
process.env.AUTH_MODE = 'demo';
process.env.PORT ||= '5180';
process.env.HOST ||= '127.0.0.1';

const { main } = await import('./demo-seed.js');
if (main(['--force']) !== 0) process.exit(1);
await import('../server/index.js');
