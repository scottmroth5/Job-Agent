// A resume's text laid out as Word (.docx) or PDF, for Settings > Resumes downloads. The text is read into blocks (name,
// contact line, section headings, role lines, bullets, paragraphs) and set in a clean one-column layout: the user's own
// design stays in their original file, which downloads as it was uploaded. The PDF is written here (Helvetica, US Letter,
// WinAnsi text), so no library or browser is needed and it works in the demo too. Text is always set as text.
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';

const BULLET = /^\s*[-*•●▪]\s+/;
const YEARS = /\b(19|20)\d{2}\b.*\b((19|20)\d{2}|now|present|current)\b/i;

/** Blocks: [{ type: 'name' | 'contact' | 'heading' | 'role' | 'bullet' | 'para', text }], blank lines between paragraphs. */
export function resumeBlocks(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let named = false;
  let contactOpen = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      contactOpen = false;
      continue;
    }
    const plain = line.replace(/^#+\s*/, '').replace(/^\*\*(.*)\*\*$/, '$1');
    if (!named) {
      blocks.push({ type: 'name', text: plain });
      named = true;
      contactOpen = true;
      continue;
    }
    if (contactOpen && /[@|]|\d{3}[-. ]\d{4}|linkedin|\.com/i.test(line)) {
      blocks.push({ type: 'contact', text: plain });
      continue;
    }
    contactOpen = false;
    if (/^#{1,3}\s+/.test(line) || (plain.length <= 40 && /[A-Z]/.test(plain) && !/[a-z]/.test(plain))) {
      blocks.push({ type: 'heading', text: plain });
    } else if (BULLET.test(line)) {
      blocks.push({ type: 'bullet', text: line.replace(BULLET, '') });
    } else if (YEARS.test(line) && line.length <= 120) {
      blocks.push({ type: 'role', text: plain });
    } else {
      blocks.push({ type: 'para', text: plain });
    }
  }
  return blocks;
}

/** The resume as a Word document. */
export async function resumeDocx(text) {
  const children = resumeBlocks(text).map((b) => {
    if (b.type === 'name') return new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: b.text, bold: true, size: 36 })], spacing: { after: 60 } });
    if (b.type === 'contact') return new Paragraph({ children: [new TextRun({ text: b.text, size: 20, color: '444444' })], spacing: { after: 60 } });
    if (b.type === 'heading') return new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: b.text, bold: true })], spacing: { before: 240, after: 80 } });
    if (b.type === 'role') return new Paragraph({ children: [new TextRun({ text: b.text, bold: true })], spacing: { before: 120, after: 40 } });
    if (b.type === 'bullet') return new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: b.text })], spacing: { after: 40 } });
    return new Paragraph({ children: [new TextRun({ text: b.text })], spacing: { after: 100 } });
  });
  const doc = new Document({ styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } }, sections: [{ children }] });
  return Packer.toBuffer(doc);
}

// Helvetica advance widths (1/1000 em) for ASCII 32 to 126, from the standard font metrics; bold is a little wider.
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
  584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
  278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
  500, 334, 260, 334, 584,
];
const width = (s, size, bold) => [...s].reduce((w, ch) => w + (HELV[ch.charCodeAt(0) - 32] ?? 556), 0) * (bold ? 1.06 : 1) * (size / 1000);

/** Text in WinAnsi (latin-1 plus typographic quotes, dashes, and bullets); anything else becomes "?". */
function winAnsi(s) {
  const map = { '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '…': 0x85, ' ': 0x20 };
  return [...String(s)].map((ch) => {
    const c = ch.codePointAt(0);
    if (map[ch]) return String.fromCharCode(map[ch]);
    if (c >= 0x20 && c <= 0x7e) return ch;
    if (c >= 0xa0 && c <= 0xff) return ch;
    return '?';
  }).join('');
}
const pdfString = (s) => `(${winAnsi(s).replace(/[\\()]/g, (m) => `\\${m}`)})`;

function wrap(text, size, bold, maxWidth) {
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

/** The resume as a PDF (US Letter, Helvetica), paged as needed. */
export function resumePdf(text) {
  const W = 612;
  const H = 792;
  const M = 54;
  const maxW = W - 2 * M;
  const pages = [];
  let ops = [];
  let y = H - M;
  const newPage = () => {
    pages.push(ops.join('\n'));
    ops = [];
    y = H - M;
  };
  const put = (str, { size = 10.5, bold = false, x = M, gray = false }) => {
    if (y < M + size) newPage();
    ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${gray ? '0.3 0.3 0.3 rg' : '0 0 0 rg'} ${x.toFixed(1)} ${y.toFixed(1)} Td ${pdfString(str)} Tj ET`);
    y -= size * 1.32;
  };
  for (const b of resumeBlocks(text)) {
    if (b.type === 'name') {
      for (const l of wrap(b.text, 20, true, maxW)) put(l, { size: 20, bold: true });
      y -= 2;
    } else if (b.type === 'contact') {
      for (const l of wrap(b.text, 9.5, false, maxW)) put(l, { size: 9.5, gray: true });
    } else if (b.type === 'heading') {
      y -= 8;
      if (y < M + 40) newPage();
      put(b.text.toUpperCase(), { size: 11.5, bold: true });
      ops.push(`0.6 0.6 0.6 RG 0.6 w ${M} ${(y + 9).toFixed(1)} m ${W - M} ${(y + 9).toFixed(1)} l S`);
      y -= 2;
    } else if (b.type === 'role') {
      y -= 3;
      if (y < M + 40) newPage(); // keep a role with its first lines
      for (const l of wrap(b.text, 10.5, true, maxW)) put(l, { size: 10.5, bold: true });
    } else if (b.type === 'bullet') {
      const lines = wrap(b.text, 10.5, false, maxW - 14);
      lines.forEach((l, i) => {
        if (i === 0) {
          if (y < M + 10.5) newPage();
          ops.push(`BT /F1 10.5 Tf 0 0 0 rg ${(M + 3).toFixed(1)} ${y.toFixed(1)} Td ${pdfString('•')} Tj ET`);
        }
        put(l, { x: M + 14 });
      });
    } else {
      for (const l of wrap(b.text, 10.5, false, maxW)) put(l, {});
      y -= 3;
    }
  }
  pages.push(ops.join('\n'));

  // Objects: 1 catalog, 2 pages, 3 and 4 fonts, then a page and its content stream for each page.
  const objs = [];
  const font = (name) => `<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`;
  const pageIds = pages.map((_, i) => 5 + i * 2);
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objs[3] = font('Helvetica');
  objs[4] = font('Helvetica-Bold');
  pages.forEach((content, i) => {
    const id = pageIds[i];
    objs[id] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${id + 1} 0 R >>`;
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
