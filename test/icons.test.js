// The app's icons (from assets/app-icon-1024.png): the install icons and favicons are real images at their sizes, the
// manifest and page point at them, and with Google sign-in on, iOS and browsers can fetch them without the session cookie
// (nothing else is open).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { openJobStore } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { authSettings } from '../server/auth.js';
import { repoPath } from '../tools/paths.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const pngSize = (file) => {
  const b = readFileSync(file);
  assert.deepEqual([...b.subarray(0, 8)], PNG_SIGNATURE, `${file} is a PNG`);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

test('icons: each is a PNG of its size; favicon.ico holds icons; the 1024 source is kept but not served', () => {
  for (const [file, size] of [['icon-180.png', 180], ['icon-192.png', 192], ['icon-512.png', 512], ['favicon-32x32.png', 32], ['favicon-16x16.png', 16]]) {
    assert.deepEqual(pngSize(repoPath('web', 'public', file)), [size, size], file);
  }
  const ico = readFileSync(repoPath('web', 'public', 'favicon.ico'));
  assert.deepEqual([ico.readUInt16LE(0), ico.readUInt16LE(2)], [0, 1], 'an ICO header');
  assert.ok(ico.readUInt16LE(4) >= 2, 'at least two sizes inside');
  assert.deepEqual(pngSize(repoPath('assets', 'app-icon-1024.png')), [1024, 1024]);
  assert.match(readFileSync(repoPath('.dockerignore'), 'utf8'), /^assets\/$/m, 'the source stays out of the image');
});

test('manifest and page: standalone, starts on Home, and every icon they name exists', () => {
  const manifest = JSON.parse(readFileSync(repoPath('web', 'public', 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/#/');
  for (const icon of manifest.icons) assert.ok(existsSync(repoPath('web', 'public', icon.src)), icon.src);
  const html = readFileSync(repoPath('web', 'index.html'), 'utf8');
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/icon-180\.png"/);
  for (const href of [...html.matchAll(/rel="icon"[^>]*href="\/([^"]+)"/g)].map((m) => m[1])) assert.ok(existsSync(repoPath('web', 'public', href)), href);
  assert.match(html, /href="\/favicon\.ico"/);
  assert.match(html, /viewport-fit=cover/);
});

test('signed out with Google sign-in on: the manifest, icons, and favicons load; other files and the API still need a session', async () => {
  const settings = authSettings({
    AUTH_MODE: 'google',
    PUBLIC_URL: 'http://localhost:5178',
    GOOGLE_WEB_CLIENT_ID: 'client.apps.example',
    GOOGLE_WEB_CLIENT_SECRET: 'secret',
    AUTH_ALLOWED_EMAILS: 'pat@example.com',
    SESSION_SECRET: randomBytes(48).toString('base64'),
  });
  const store = openJobStore(':memory:');
  const app = await buildApp({
    store,
    config: { search: { homeLocations: [] }, fractional: {} },
    services: { createBrowser: async () => null },
    webDir: repoPath('web', 'public'),
    authMode: 'google',
    auth: { settings, exchange: async () => assert.fail('no sign-in here') },
  });
  const manifest = await app.inject('/manifest.webmanifest');
  assert.equal(manifest.statusCode, 200);
  assert.match(manifest.headers['content-type'], /manifest\+json|json/);
  for (const path of ['/icon-180.png', '/icon-512.png', '/favicon-32x32.png', '/favicon-16x16.png', '/favicon.ico']) {
    assert.equal((await app.inject(path)).statusCode, 200, path);
  }
  assert.equal((await app.inject('/icon-180.png')).headers['content-type'], 'image/png');
  assert.equal((await app.inject('/icon-180.png?x=1')).statusCode, 200, 'a query string does not change it');
  for (const path of ['/icon-999.png', '/favicon-64x64.png', '/', '/manifest.webmanifest/../index.html']) {
    assert.equal((await app.inject(path)).statusCode, 302, `${path} sends you to sign in`);
  }
  assert.equal((await app.inject('/api/summary')).statusCode, 401);
  await app.close();
  store.close();
});

test('dashboard pictures: every name the UI maps is a small PNG in web/public/dash', () => {
  const src = readFileSync(repoPath('web', 'src', 'components', 'DashIcon.jsx'), 'utf8');
  const files = [...src.matchAll(/^\s+\w+: '([\w-]+)',$/gm)].map((m) => m[1]);
  assert.ok(files.length >= 10, 'the map was read');
  for (const file of files) {
    const path = repoPath('web', 'public', 'dash', `${file}.png`);
    assert.deepEqual(pngSize(path), [160, 160], file);
    assert.ok(readFileSync(path).length < 60_000, `${file} stays small`);
  }
});
