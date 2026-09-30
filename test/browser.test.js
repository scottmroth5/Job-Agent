import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowser } from '../tools/browser.js';

function fakeChromium({ failChannels = [] } = {}) {
  const state = { launches: [], closed: 0 };
  return {
    state,
    launch: async ({ channel }) => {
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
}

test('concurrent pages share one browser, and close() closes it', async () => {
  const chromium = fakeChromium();
  const browser = await createBrowser({ chromium, channel: undefined });
  await Promise.all([browser.renderPage('a'), browser.renderPage('b'), browser.renderPage('c')]);
  assert.deepEqual(chromium.state.launches, ['bundled'], 'launched exactly once');
  await browser.close();
  assert.equal(chromium.state.closed, 1);
});

test('falls back to Edge when the bundled browser is missing, and reports unavailable when nothing launches', async () => {
  const edge = fakeChromium({ failChannels: ['bundled'] });
  const b1 = await createBrowser({ chromium: edge, channel: undefined });
  await b1.renderPage('a');
  assert.deepEqual(edge.state.launches, ['bundled', 'msedge']);
  await b1.close();

  const none = fakeChromium({ failChannels: ['bundled', 'msedge', 'chrome'] });
  const b2 = await createBrowser({ chromium: none, channel: undefined });
  assert.equal(await b2.renderPage('a'), null);
  assert.equal(b2.available, false);
  await b2.close(); // nothing to close, no error
});

test('close() before any page is harmless', async () => {
  const chromium = fakeChromium();
  const browser = await createBrowser({ chromium, channel: undefined });
  await browser.close();
  assert.deepEqual(chromium.state.launches, []);
});
