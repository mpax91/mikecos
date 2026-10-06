import { extractText, getDocumentProxy } from 'unpdf';

/** pdf.js (serverless build via unpdf) text extraction — one line per text
 * row, pages joined with newlines. Image-only scans come back (nearly)
 * empty, which the engine reports as unreadable rather than guessing. */
export async function pdfToText(bytes: ArrayBuffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join('\n') : text;
}
