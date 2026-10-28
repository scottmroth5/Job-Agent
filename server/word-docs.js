// Word (.docx) copies of a cover letter and a meeting prep, for downloading: users without Google Docs send their
// letters from these, and the owner can use them too. The letter follows the Google Doc's layout (agents/hunt/letters.js
// letterHtml); the prep is its Markdown with headings, bullets, and bold kept. Text is set as text, never as markup.
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { paragraphsOf } from '../tools/text.js';

const FONT = { font: 'Calibri', size: 22 }; // 11 pt

/** "**bold** and plain" as runs. */
function runs(text) {
  return String(text)
    .split(/(\*\*[^*]+\*\*)/)
    .filter(Boolean)
    .map((part) => (/^\*\*[^*]+\*\*$/.test(part) ? new TextRun({ text: part.slice(2, -2), bold: true }) : new TextRun({ text: part.replace(/\*\*/g, '') })));
}

/** The cover letter: name and contact lines, date, the role, greeting, body paragraphs, and sign-off. */
export async function letterDocx({ candidate, company, title, date, body }) {
  const para = (text, opts = {}) => new Paragraph({ children: [new TextRun({ text, ...opts })], spacing: { after: 160 } });
  const paragraphs = paragraphsOf(body);
  const doc = new Document({
    styles: { default: { document: { run: FONT } } },
    sections: [
      {
        children: [
          new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: candidate.name ?? '' })] }),
          ...(candidate.contactLine ? [para(candidate.contactLine, { italics: true })] : []),
          ...(candidate.linkedin ? [para(candidate.linkedin, { italics: true })] : []),
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
export const docxName = (name) => `${String(name).replace(/[^A-Za-z0-9 _.-]+/g, '_').slice(0, 120)}.docx`;
