import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowser } from '../tools/browser.ts';
/** @import { BrowserType } from 'playwright' */

/**
 * Playwright's launcher with pages that render a fixed paragraph; only what createBrowser calls.
 * @param {{ failChannels?: string[] }} [o]
 */
function fakeChromium({ failChannels = [] } = {}) {
  /** @type {{ launches: string[], closed: number }} */
  const state = { launches: [], closed: 0 };
  const launcher = {
    launch: async (/** @type {{ channel?: string }} */ { channel }) => {
      state.launches.push(channel ?? 'bundled');
      await new Promise((r) => setTimeout(r, 10)); // launching takes time, so concurrent callers overlap
      if (failChannels.includes(channel ?? 'bundled')) throw new Error('not installed');
      return {
        newPage: async () => ({
          goto: async () => {},
          waitForFunction: async () => {},
          content: async () => '<p>x</p>',
          innerText: async () => 'x',
          close: async () => {},
        }),
        close: async () => {
          state.closed += 1;
        },
      };
    },
  };
  return { state, launch: /** @type {Pick<BrowserType, 'launch'>['launch']} */ (/** @type {unknown} */ (launcher.launch)) };
}

test('concurrent pages share one browser, and close() closes it', async () => {
  const chromium = fakeChromium();
  const browser = await createBrowser({ chromium, channel: undefined });
  assert.ok(browser);
  await Promise.all([browser.renderPage('a'), browser.renderPage('b'), browser.renderPage('c')]);
  assert.deepEqual(chromium.state.launches, ['bundled'], 'launched exactly once');
  await browser.close();
  assert.equal(chromium.state.closed, 1);
});

test('falls back to Edge when the bundled browser is missing, and reports unavailable when nothing launches', async () => {
  const edge = fakeChromium({ failChannels: ['bundled'] });
  const b1 = await createBrowser({ chromium: edge, channel: undefined });
  assert.ok(b1);
  await b1.renderPage('a');
  assert.deepEqual(edge.state.launches, ['bundled', 'msedge']);
  await b1.close();

  const none = fakeChromium({ failChannels: ['bundled', 'msedge', 'chrome'] });
  const b2 = await createBrowser({ chromium: none, channel: undefined });
  assert.ok(b2);
  assert.equal(await b2.renderPage('a'), null);
  assert.equal(b2.available, false);
  await b2.close(); // nothing to close, no error
});

test('close() before any page is harmless', async () => {
  const chromium = fakeChromium();
  const browser = await createBrowser({ chromium, channel: undefined });
  assert.ok(browser);
  await browser.close();
  assert.deepEqual(chromium.state.launches, []);
});
