// Headless browser for job pages that only render with JavaScript (Workday and similar).
// Playwright is loaded lazily. It uses Playwright's own Chromium when installed
// (npx playwright install chromium), otherwise the installed Microsoft Edge or Google Chrome,
// so no download is needed on Windows. PLAYWRIGHT_CHANNEL (e.g. "msedge") forces one choice.
// If nothing launches, pages are marked needs_browser and the run continues.

const CHANNELS = [undefined, 'msedge', 'chrome']; // undefined = Playwright's bundled Chromium

/** Returns { renderPage(url) -> {html, text}, close() } or null when Playwright is unavailable. */
export async function createBrowser({ timeoutMs = 30000, channel = process.env.PLAYWRIGHT_CHANNEL } = {}) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return null;
  }
  let browser = null;
  let unavailable = false;

  async function renderPage(url) {
    if (unavailable) return null;
    if (!browser) {
      for (const ch of channel ? [channel] : CHANNELS) {
        try {
          browser = await chromium.launch({ headless: true, ...(ch ? { channel: ch } : {}) });
          break;
        } catch {
          // not installed; try the next option
        }
      }
      if (!browser) {
        unavailable = true;
        return null;
      }
    }
    const page = await browser.newPage();
    try {
      // Job apps like Workday never go network-idle; wait for the DOM, then for enough visible text.
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      await page
        .waitForFunction((min) => (document.body?.innerText ?? '').length > min, 800, { timeout: 15000 })
        .catch(() => {}); // thin pages are judged by the caller
      return { html: await page.content(), text: await page.innerText('body') };
    } finally {
      await page.close();
    }
  }

  return {
    renderPage,
    get available() {
      return !unavailable;
    },
    close: async () => browser?.close(),
  };
}
