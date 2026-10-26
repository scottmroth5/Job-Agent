// The public privacy policy and terms (/privacy, /terms), from PRIVACY.md and TERMS.md through the app's one safe
// Markdown renderer. Open without sign-in: the request-access page links to them, and Google's consent screen needs
// the privacy policy.
import { readFileSync } from 'node:fs';
import { renderMarkdown } from '../tools/markdown.js';
import { repoPath } from '../tools/paths.js';
import { withSupport } from '../tools/support.js';

const PAGES = { '/privacy': ['Privacy policy', 'PRIVACY.md'], '/terms': ['Terms', 'TERMS.md'] };

export function registerPages(app) {
  for (const [path, [title, file]] of Object.entries(PAGES)) {
    const body = renderMarkdown(withSupport(readFileSync(repoPath(file), 'utf8')));
    const html =
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>` +
      '<style>body{font:16px/1.6 system-ui,sans-serif;margin:0;background:#f6f7f9;color:#1d2330}main{max-width:720px;margin:0 auto;padding:24px 16px}' +
      '@media (prefers-color-scheme: dark){body{background:#12151b;color:#e6e9ef}a{color:#7fb3d9}}</style></head>' +
      `<body><main>${body}</main></body></html>`;
    app.get(path, { schema: { hide: true } }, async (req, reply) => reply.type('text/html').send(html));
  }
}
