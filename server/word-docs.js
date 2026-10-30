// Word (.docx) copies of a cover letter and a meeting prep, for downloading: users without Google Docs send their
// letters from these, and the owner can use them too. The letter follows the Google Doc's layout (agents/hunt/letters.js
// letterHtml); the prep is its Markdown with headings, bullets, and bold kept. Text is set as text, never as markup.
import { Document, ExternalHyperlink, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { headerLines, SEPARATOR } from '../tools/letter-header.js';
import { fileTitle, paragraphsOf, withoutPictographs } from '../tools/text.js';

// Every run of text, without emoji or pictographs (Word shows them as pictures).
const textRun = (opts) => new TextRun({ ...opts, text: withoutPictographs(opts.text ?? '') });

const FONT = { font: 'Calibri', size: 22 }; // 11 pt

/** "**bold** and plain" as runs. */
function runs(text) {
  return String(text)
    .split(/(\*\*[^*]+\*\*)/)
    .filter(Boolean)
    .map((part) => (/^\*\*[^*]+\*\*$/.test(part) ? textRun({ text: part.slice(2, -2), bold: true }) : textRun({ text: part.replace(/\*\*/g, '') })));
}

/** A header line's parts as runs: plain text, or a clickable link (an email opens a new message). */
function linkRuns(parts) {
  return parts.flatMap((p, i) => [
    ...(i ? [textRun({ text: SEPARATOR, italics: true })] : []),
    p.url ? new ExternalHyperlink({ link: p.url, children: [textRun({ text: p.text, italics: true, color: '0563C1', underline: {} })] }) : textRun({ text: p.text, italics: true }),
  ]);
}

/** The cover letter: name and contact lines, date, the role, greeting, body paragraphs, and sign-off. */
export async function letterDocx({ candidate, company, title, date, body }) {
  const para = (text, opts = {}) => new Paragraph({ children: [textRun({ text, ...opts })], spacing: { after: 160 } });
  const paragraphs = paragraphsOf(body);
  const doc = new Document({
    styles: { default: { document: { run: FONT } } },
    sections: [
      {
        children: [
          new Paragraph({ heading: HeadingLevel.HEADING_1, children: [textRun({ text: candidate.name ?? '' })] }),
          ...headerLines(candidate).map((parts) => new Paragraph({ children: linkRuns(parts), spacing: { after: 160 } })),
          para(''),
          para(date),
          para(`Re: ${title} at ${company}`, { bold: true }),
          para(''),
          para(`Dear ${company} Hiring Team,`),
          ...paragraphs.map((p) => para(p)),
          para(''),
          para('Sincerely,'),
          para(candidate.signoffName || candidate.name || ''),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

/** A meeting prep from its Markdown: # headings, - and * bullets (nested by indent), numbered lines, **bold**. */
export async function prepDocx(markdown) {
  const children = [];
  for (const line of String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim() || /^\s*(-{3,}|\*{3,})\s*$/.test(line)) continue;
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (heading) {
      const level = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4][heading[1].length - 1];
      children.push(new Paragraph({ heading: level, children: runs(heading[2]) }));
    } else if (bullet) {
      children.push(new Paragraph({ bullet: { level: Math.min(3, Math.floor(bullet[1].length / 2)) }, children: runs(bullet[2]) }));
    } else {
      children.push(new Paragraph({ children: runs(line.trim()), spacing: { after: 120 } }));
    }
  }
  const doc = new Document({ styles: { default: { document: { run: FONT } } }, sections: [{ children }] });
  return Packer.toBuffer(doc);
}

/** A file name with only plain characters, for the download. */
export const docxName = (name) => `${fileTitle(name) || 'Document'}.docx`;
