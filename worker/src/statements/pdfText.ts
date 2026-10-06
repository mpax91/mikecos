import { getDocumentProxy } from 'unpdf';

/** pdf.js text extraction (unpdf 0.12 — its pdf.js 4 serverless build;
 * unpdf 1.x's pdf.js 5 bundle fails to load in workerd). Lines are rebuilt
 * from pdf.js's own end-of-line markers, plus a break whenever an item
 * starts a new baseline, so templates can match label/value lines. Image-
 * only scans come back (nearly) empty and are reported as unreadable. */
export async function pdfToText(bytes: ArrayBuffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const pages: string[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    let line = '';
    const lines: string[] = [];
    let lastY: number | null = null;
    for (const raw of content.items) {
      const item = raw as { str?: string; hasEOL?: boolean; transform?: number[] };
      if (typeof item.str !== 'string') continue;
      const y = item.transform ? Math.round(item.transform[5]) : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && line.trim()) {
        lines.push(line.trim());
        line = '';
      }
      line += line && item.str && !line.endsWith(' ') && !item.str.startsWith(' ') ? ` ${item.str}` : item.str;
      if (y !== null) lastY = y;
      if (item.hasEOL) {
        if (line.trim()) lines.push(line.trim());
        line = '';
      }
    }
    if (line.trim()) lines.push(line.trim());
    pages.push(lines.join('\n'));
  }
  return pages.join('\n');
}
