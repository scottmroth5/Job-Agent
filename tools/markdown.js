// A small, safe Markdown renderer shared by the web page (job notes, meeting prep) and the server (meeting prep
// Google Docs). Everything is HTML-escaped first, and only the tags below are produced, so text from people or
// from the web can never inject markup. Links open only http, https, and mailto addresses.
// Supported: # headings, - and 1. lists (one nested level), | tables |, > quotes, ---, **bold**, *italic*,
// `code`, [text](url), and bare URLs. A single line break inside a paragraph is kept.

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const SAFE_URL = /^(https?:\/\/|mailto:)/i;
const linkTag = (href, text) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;

/** Inline formatting on one already-split piece of text. */
export function renderInline(raw) {
  const held = [];
  const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
  let s = escapeHtml(raw);
  s = s.replace(/`([^`]+)`/g, (_, code) => hold(`<code>${code}</code>`));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => (SAFE_URL.test(url) ? hold(linkTag(url, text)) : m));
  s = s.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (url) => hold(linkTag(url, url)));
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`);
  s = s.replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?![*\w])|(^|\W)_(?=\S)([^_]*?\S)_(?!\w)/g, (_, p1, a, p2, b) => `${p1 ?? p2}<em>${a ?? b}</em>`);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => held[Number(i)]);
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

function renderList(lines) {
  // Items at the smallest indent are this list; deeper ones nest under the item before them.
  const base = Math.min(...lines.map((l) => LIST_ITEM.exec(l)[1].length));
  const ordered = /\d/.test(LIST_ITEM.exec(lines[0])[2]);
  const items = [];
  for (const line of lines) {
    const [, indent, , text] = LIST_ITEM.exec(line);
    if (indent.length > base && items.length) items.at(-1).children.push(line);
    else items.push({ text, children: [] });
  }
  const tag = ordered ? 'ol' : 'ul';
  return `<${tag}>${items.map((i) => `<li>${renderInline(i.text)}${i.children.length ? renderList(i.children) : ''}</li>`).join('')}</${tag}>`;
}

/** Markdown to safe HTML. */
export function renderMarkdown(md) {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (/^\s*```/.test(line)) {
      // A fenced block (the guides' templates): shown exactly as written, escaped, up to the closing fence.
      const code = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i += 1;
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
    } else if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2].replace(/\s*#+\s*$/, ''))}</h${level}>`);
      i += 1;
    } else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr>');
      i += 1;
    } else if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${renderInline(c)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${head.map((_, k) => `<td>${renderInline(r[k] ?? '')}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`,
      );
    } else if (LIST_ITEM.test(line)) {
      const block = [];
      while (i < lines.length && (LIST_ITEM.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && block.length))) {
        // A wrapped continuation line joins the item above it.
        if (LIST_ITEM.test(lines[i])) block.push(lines[i]);
        else block[block.length - 1] += ` ${lines[i].trim()}`;
        i += 1;
      }
      out.push(renderList(block));
    } else if (/^\s*>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`);
    } else {
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,4})\s/.test(lines[i]) && !/^\s*```/.test(lines[i]) && !LIST_ITEM.test(lines[i]) && !/^\s*>/.test(lines[i]) && !(TABLE_ROW.test(lines[i]) && TABLE_RULE.test(lines[i + 1] ?? ''))) {
        para.push(lines[i++]);
      }
      out.push(`<p>${para.map((p) => renderInline(p.trim())).join('<br>')}</p>`);
    }
  }
  return out.join('\n');
}
