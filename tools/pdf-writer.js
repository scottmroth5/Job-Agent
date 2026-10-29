// A small PDF writer for the app's own downloads (resumes and cover letters): US Letter, Helvetica and Helvetica-Bold,
// WinAnsi text, word wrap from the standard font widths, and pages as needed. It writes text only, never markup, so no
// library or browser is needed and it works in the demo too.
//
// writePdf(lines) takes blocks: { text, size?, bold?, gray?, bullet?, before?, after?, rule?, keep? } where before and
// after are extra points of space, rule draws a line under the block, and keep starts a new page unless that many points
// fit below (to keep a heading with what follows).
import { paragraphsOf, withoutPictographs } from './text.js';
import { headerLines } from './letter-header.js';

// Helvetica advance widths (1/1000 em) for ASCII 32 to 126, from the standard font metrics; bold is a little wider.
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
  584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
  278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
  500, 334, 260, 334, 584,
];

/** Text in WinAnsi (latin-1 plus typographic quotes, dashes, and bullets); anything else becomes "?". */
// Emoji and pictographs have no WinAnsi glyph: they are dropped, not printed as "?".
export function winAnsi(s) {
  const map = { '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '…': 0x85, ' ': 0x20 };
  return [...withoutPictographs(String(s))]
    .map((ch) => {
      const c = ch.codePointAt(0);
      if (map[ch]) return String.fromCharCode(map[ch]);
      if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff)) return ch;
      return '?';
    })
    .join('');
}

const width = (s, size, bold) => [...s].reduce((w, ch) => w + (HELV[ch.charCodeAt(0) - 32] ?? 556), 0) * (bold ? 1.06 : 1) * (size / 1000);
const pdfString = (s) => `(${winAnsi(s).replace(/[\\()]/g, (m) => `\\${m}`)})`;

/** Words into lines no wider than maxWidth points. */
export function wrap(text, size, bold, maxWidth) {
  const out = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && width(winAnsi(next), size, bold) > maxWidth) {
      out.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

/** The blocks as a PDF Buffer. */
export function writePdf(blocks) {
  const W = 612;
  const H = 792;
  const M = 54;
  const pages = [];
  const annots = [[]]; // each page's links: { rect, url }
  let ops = [];
  let y = H - M;
  const newPage = () => {
    pages.push(ops.join('\n'));
    annots.push([]);
    ops = [];
    y = H - M;
  };
  for (const b of blocks) {
    const size = b.size ?? 10.5;
    const bold = Boolean(b.bold);
    y -= b.before ?? 0;
    if (b.keep && y < M + b.keep) newPage();
    // A line of parts ({ text, url }) joined by " | ": links in blue, each a clickable area (header lines are short).
    if (b.parts) {
      if (y < M + size) newPage();
      let x = M;
      b.parts.forEach((p, i) => {
        const pieces = i ? [{ text: ' | ' }, p] : [p];
        for (const piece of pieces) {
          const w = width(winAnsi(piece.text), size, bold);
          const color = piece.url ? '0.07 0.33 0.62 rg' : b.gray ? '0.3 0.3 0.3 rg' : '0 0 0 rg';
          ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${color} ${x.toFixed(1)} ${y.toFixed(1)} Td ${pdfString(piece.text)} Tj ET`);
          if (piece.url) annots.at(-1).push({ rect: [x, y - 2, x + w, y + size - 1].map((n) => n.toFixed(1)), url: piece.url });
          x += w;
        }
      });
      y -= size * 1.32 + (b.after ?? 0);
      continue;
    }
    const indent = b.bullet ? 14 : 0;
    const lines = b.text === '' ? [''] : wrap(b.text, size, bold, W - 2 * M - indent);
    lines.forEach((l, i) => {
      if (y < M + size) newPage();
      if (b.bullet && i === 0) ops.push(`BT /F1 ${size} Tf 0 0 0 rg ${(M + 3).toFixed(1)} ${y.toFixed(1)} Td ${pdfString('•')} Tj ET`);
      if (l) ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${b.gray ? '0.3 0.3 0.3 rg' : '0 0 0 rg'} ${(M + indent).toFixed(1)} ${y.toFixed(1)} Td ${pdfString(l)} Tj ET`);
      y -= size * 1.32;
    });
    if (b.rule) ops.push(`0.6 0.6 0.6 RG 0.6 w ${M} ${(y + size * 1.32 - 3).toFixed(1)} m ${W - M} ${(y + size * 1.32 - 3).toFixed(1)} l S`);
    y -= b.after ?? 0;
  }
  pages.push(ops.join('\n'));

  // Objects: 1 catalog, 2 pages, 3 and 4 fonts, then a page and its content stream for each page.
  const objs = [];
  const font = (name) => `<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`;
  const pageIds = pages.map((_, i) => 5 + i * 2);
  let nextId = 5 + pages.length * 2;
  const annotIds = annots.map((list) => list.map(() => nextId++));
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objs[3] = font('Helvetica');
  objs[4] = font('Helvetica-Bold');
  pages.forEach((content, i) => {
    const id = pageIds[i];
    const links = annotIds[i].length ? ` /Annots [${annotIds[i].map((a) => `${a} 0 R`).join(' ')}]` : '';
    objs[id] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${id + 1} 0 R${links} >>`;
    annots[i].forEach((a, k) => {
      objs[annotIds[i][k]] = `<< /Type /Annot /Subtype /Link /Rect [${a.rect.join(' ')}] /Border [0 0 0] /A << /S /URI /URI ${pdfString(a.url)} >> >>`;
    });
    objs[id + 1] = `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
  });
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  for (let id = 1; id < objs.length; id++) {
    offsets[id] = Buffer.byteLength(out, 'latin1');
    out += `${id} 0 obj\n${objs[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objs.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A cover letter in the Google Doc's layout: name, contact lines, date, the role, greeting, paragraphs, and sign-off. */
export function letterPdf({ candidate, company, title, date, body }) {
  const paragraphs = paragraphsOf(body);
  return writePdf([
    { text: candidate.name ?? '', size: 18, bold: true, after: 2 },
    ...headerLines(candidate).map((parts) => ({ parts, size: 9.5, gray: true })),
    { text: date, before: 18, after: 6 },
    { text: `Re: ${title} at ${company}`, bold: true, after: 10 },
    { text: `Dear ${company} Hiring Team,`, after: 8 },
    ...paragraphs.map((p) => ({ text: p, after: 8 })),
    { text: 'Sincerely,', before: 4 },
    { text: candidate.signoffName || candidate.name || '', before: 14 },
  ]);
}
