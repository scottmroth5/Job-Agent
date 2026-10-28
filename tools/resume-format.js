// A resume's text laid out as Word (.docx) or PDF, for Settings > Resumes downloads. The text is read into blocks (name,
// contact line, section headings, role lines, bullets, paragraphs) and set in a clean one-column layout: the user's own
// design stays in their original file, which downloads as it was uploaded. The PDF comes from tools/pdf-writer.js.
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { writePdf } from './pdf-writer.js';

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

/** The resume as a PDF (US Letter, Helvetica), paged as needed (tools/pdf-writer.js). */
export function resumePdf(text) {
  return writePdf(
    resumeBlocks(text).map((b) =>
      b.type === 'name' ? { text: b.text, size: 20, bold: true, after: 2 }
      : b.type === 'contact' ? { text: b.text, size: 9.5, gray: true }
      : b.type === 'heading' ? { text: b.text.toUpperCase(), size: 11.5, bold: true, before: 8, keep: 40, rule: true, after: 2 }
      : b.type === 'role' ? { text: b.text, bold: true, before: 3, keep: 40 }
      : b.type === 'bullet' ? { text: b.text, bullet: true }
      : { text: b.text, after: 3 },
    ),
  );
}
