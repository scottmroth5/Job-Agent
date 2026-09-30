// Headless Chromium for job pages that only render with JavaScript (Workday and similar).
// Playwright is loaded lazily; if the package or its browser is missing, createBrowser()
// returns null and callers skip this step. Install the browser once: npx playwright install chromium

/** Returns { renderPage(url) -> {html, text}, close() } or null when Playwright is unavailable. */
export async function createBrowser({ timeoutMs = 30000 } = {}) {
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
      try {
        browser = await chromium.launch({ headless: true });
      } catch {
        unavailable = true; // browser binary not installed
        return null;
      }
    }
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
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
