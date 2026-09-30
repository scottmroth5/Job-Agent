// Headless browser for job pages that only render with JavaScript (Workday and similar).
// Playwright is loaded lazily. It uses Playwright's own Chromium when installed
// (npx playwright install chromium), otherwise the installed Microsoft Edge or Google Chrome,
// so no download is needed on Windows. PLAYWRIGHT_CHANNEL (e.g. "msedge") forces one choice.
// If nothing launches, pages are marked needs_browser and the run continues.

const CHANNELS = [undefined, 'msedge', 'chrome']; // undefined = Playwright's bundled Chromium

/**
 * Returns { renderPage(url) -> {html, text} | null, available, close() } or null when Playwright is unavailable.
 * The browser starts once, on first use, even when several pages are rendered at the same time;
 * close() must be awaited so no browser process is left running (it would keep Node alive).
 * @param {object} [options]
 * @param {object} [options.chromium]  Playwright's chromium launcher (injectable for tests)
 */
export async function createBrowser({ timeoutMs = 30000, channel = process.env.PLAYWRIGHT_CHANNEL, chromium } = {}) {
  if (!chromium) {
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      return null;
    }
  }
  let launching = null; // one shared launch, so concurrent callers never start a second browser
  let unavailable = false;

  const getBrowser = () =>
    (launching ??= (async () => {
      for (const ch of channel ? [channel] : CHANNELS) {
        try {
          return await chromium.launch({ headless: true, ...(ch ? { channel: ch } : {}) });
        } catch {
          // not installed; try the next option
        }
      }
      unavailable = true;
      return null;
    })());

  async function renderPage(url) {
    if (unavailable) return null;
    const browser = await getBrowser();
    if (!browser) return null;
    const page = await browser.newPage();
    try {
      // Job apps like Workday never go network-idle; wait for the DOM, then for enough visible text.
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      await page
        .waitForFunction((min) => (document.body?.innerText ?? '').length > min, 800, { timeout: 15000 })
        .catch(() => {}); // thin pages are judged by the caller
      return { html: await page.content(), text: await page.innerText('body') };
    } finally {
      await page.close().catch(() => {});
    }
  }

  return {
    renderPage,
    get available() {
      return !unavailable;
    },
    close: async () => {
      const browser = await launching;
      await browser?.close().catch(() => {});
    },
  };
}
