// Plain text from a document someone uploads (a resume, or a file for About you): PDF (unpdf), Word .docx (mammoth),
// or plain text and Markdown. Read here, on the server, with no AI call; the text is what the AI later reads.
// Old Word .doc files and scanned PDFs (pictures of text) have no text to read and are refused with a message saying
// what to upload instead.
import { extractText as pdfText, getDocumentProxy } from 'unpdf';
import mammoth from 'mammoth';

export const MAX_DOC_BYTES = 5 * 1024 * 1024;
export const MAX_DOC_CHARS = 50000;

const bad = (message) => Object.assign(new Error(message), { statusCode: 400 });

/** The kind of document from its name and first bytes: 'pdf', 'docx', or 'text'; refuses anything else. */
export function docKind(filename, bytes) {
  const name = String(filename ?? '').toLowerCase();
  const head = bytes.subarray(0, 5).toString('latin1');
  if (head === '%PDF-') return 'pdf';
  if (head.startsWith('PK') && name.endsWith('.docx')) return 'docx';
  if (/\.(txt|md|markdown|text)$/.test(name)) return 'text';
  if (name.endsWith('.doc')) throw bad('Old Word .doc files cannot be read: save it as .docx or PDF and upload that.');
  throw bad('Upload a PDF, a Word .docx, or a text file.');
}

/** Tidy text: one blank line at most between paragraphs, no trailing spaces, at most MAX_DOC_CHARS. */
export function tidy(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_DOC_CHARS);
}

/** { kind, text } from an uploaded file's bytes and name. */
export async function documentText(bytes, filename) {
  if (!bytes?.length) throw bad('The file is empty.');
  if (bytes.length > MAX_DOC_BYTES) throw bad(`Keep the file under ${MAX_DOC_BYTES / 1024 / 1024} MB.`);
  const kind = docKind(filename, bytes);
  let text = '';
  try {
    if (kind === 'pdf') {
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      text = (await pdfText(pdf, { mergePages: true })).text;
    } else if (kind === 'docx') {
      text = (await mammoth.extractRawText({ buffer: bytes })).value;
    } else {
      text = bytes.toString('utf8');
    }
  } catch {
    throw bad('The file could not be read. Try saving it again as PDF or .docx.');
  }
  text = tidy(text);
  if (text.length < 50) throw bad(kind === 'pdf' ? 'No text found in this PDF (a scanned page?). Upload a PDF with selectable text, or a .docx.' : 'No text found in this file.');
  return { kind, text };
}
