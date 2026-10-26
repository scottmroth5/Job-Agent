// The installable iPhone app: scripts/make-icons.js draws the icons and the committed files match; the manifest and
// page point at them; and with Google sign-in on, iOS can fetch them without the session cookie (nothing else is open).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { BACKGROUND, ICON_SIZES, drawIcon, encodePng } from '../scripts/make-icons.js';
import { openJobStore } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { authSettings } from '../server/auth.js';
import { repoPath } from '../tools/paths.js';

/** The filtered rows of a PNG made by encodePng (one IDAT chunk). */
function pixelsOf(png) {
  const idat = png.indexOf('IDAT');
  return inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
}

test('icons: a valid RGB PNG of the right size, accent background with white lines, and the committed files are current', () => {
  const png = encodePng(32, drawIcon(32));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  assert.equal(png.readUInt32BE(16), 32);
  assert.equal(png.readUInt32BE(20), 32);
  const idat = png.indexOf('IDAT');
  const rows = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
  assert.equal(rows.length, 32 * (32 * 3 + 1));
  const pixels = drawIcon(180);
  assert.deepEqual([...pixels.subarray(0, 3)], BACKGROUND, 'the corner is the accent blue');
  assert.ok(pixels.some((v, i) => i % 3 === 0 && v === 255 && pixels[i + 1] === 255 && pixels[i + 2] === 255), 'white lines are drawn');
  for (const size of ICON_SIZES) {
    // Compared as pixels, not bytes: another zlib version may compress the same image differently.
    assert.ok(pixelsOf(readFileSync(repoPath('web', 'public', `icon-${size}.png`))).equals(pixelsOf(encodePng(size, drawIcon(size)))), `icon-${size}.png is current (run node scripts/make-icons.js)`);
  }
});

test('manifest and page: standalone, starts on Home, and every icon it names exists', () => {
  const manifest = JSON.parse(readFileSync(repoPath('web', 'public', 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/#/');
  for (const icon of manifest.icons) assert.ok(existsSync(repoPath('web', 'public', icon.src)), icon.src);
  const html = readFileSync(repoPath('web', 'index.html'), 'utf8');
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/icon-180\.png"/);
  assert.match(html, /viewport-fit=cover/);
});

test('signed out with Google sign-in on: the manifest and icons load, other files and the API still need a session', async () => {
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
  const icon = await app.inject('/icon-180.png');
  assert.equal(icon.statusCode, 200);
  assert.equal(icon.headers['content-type'], 'image/png');
  assert.equal((await app.inject('/icon-180.png?x=1')).statusCode, 200, 'a query string does not change it');
  for (const path of ['/icon-999.png', '/', '/manifest.webmanifest/../index.html']) {
    assert.equal((await app.inject(path)).statusCode, 302, `${path} sends you to sign in`);
  }
  assert.equal((await app.inject('/api/summary')).statusCode, 401);
  await app.close();
  store.close();
});
