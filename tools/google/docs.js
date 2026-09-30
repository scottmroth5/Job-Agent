import { docs } from '@googleapis/docs';

/** Plain text of a Docs API document: paragraphs, tables and table of contents, in order. */
export function docText(document) {
  const out = [];
  const walk = (content = []) => {
    for (const el of content) {
      if (el.paragraph) {
        for (const pe of el.paragraph.elements ?? []) if (pe.textRun?.content) out.push(pe.textRun.content);
      } else if (el.table) {
        for (const row of el.table.tableRows ?? []) {
          for (const cell of row.tableCells ?? []) walk(cell.content);
        }
      } else if (el.tableOfContents) {
        walk(el.tableOfContents.content);
      }
    }
  };
  walk(document?.body?.content);
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

/** Fetches a Google Doc and returns { title, text }. */
export async function readDoc(auth, documentId) {
  const { data } = await docs({ version: 'v1', auth }).documents.get({ documentId });
  return { title: data.title ?? '', text: docText(data) };
}
