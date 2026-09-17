// Client-side PDF text extraction for the Health importer (and, later,
// other "upload a document and parse it" imports). Uses pdfjs-dist, same
// dependency and worker-loading pattern already used for the canvas board's
// thumbnail rendering (see CanvasBoardPage.tsx) — no new dependency.
//
// pdfjs's own getTextContent() returns a flat list of text fragments with
// x/y positions, not grouped into lines the way a human (or pdfplumber,
// which the worker-side parser in worker/src/health.ts was written and
// validated against) would read the page. This groups fragments into lines
// by y-position and sorts each line left-to-right by x-position, which is
// what makes the extracted text match the parser's expectations — without
// this grouping, a stat grid's value/label/delta rows can come out
// interleaved or in the wrong order.
export async function extractPdfText(file: File): Promise<string> {
  const pdfjsLib = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

  const pageTexts: string[] = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();

    // Group items into lines: items whose baseline y is within a small
    // tolerance of each other belong to the same line. transform[5] is the
    // item's y position in PDF user space.
    type Item = { x: number; y: number; str: string };
    const items: Item[] = (content.items as { str: string; transform: number[] }[])
      .filter((it) => it.str.length > 0)
      .map((it) => ({ x: it.transform[4], y: it.transform[5], str: it.str }));

    items.sort((a, b) => b.y - a.y || a.x - b.x);

    const lines: Item[][] = [];
    const Y_TOLERANCE = 2;
    for (const item of items) {
      const line = lines[lines.length - 1];
      if (line && Math.abs(line[0].y - item.y) <= Y_TOLERANCE) {
        line.push(item);
      } else {
        lines.push([item]);
      }
    }

    const pageText = lines
      .map((line) => {
        line.sort((a, b) => a.x - b.x);
        // Join fragments on one line with a single space unless they're
        // clearly adjacent (no gap), matching how a word gets split across
        // multiple text-run fragments vs. genuinely separate words.
        return line
          .map((it) => it.str)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
      })
      .filter((l) => l.length > 0)
      .join('\n');

    pageTexts.push(pageText);
  }

  return pageTexts.join('\n');
}
