/** Tiny builders for TipTap/ProseMirror JSON — the format Vault notes are
 * stored in (see src/components/NoteEditor.tsx: StarterKit + Table +
 * Link + Highlight). Statements writes its auto-updated "Account Details"
 * notes with these. */

type Mark = { type: string; attrs?: Record<string, unknown> };
export type Inline = { type: 'text'; text: string; marks?: Mark[] };
export type Block = Record<string, unknown>;

export const text = (t: string, marks?: Mark[]): Inline => (marks?.length ? { type: 'text', text: t, marks } : { type: 'text', text: t });
export const bold = (t: string) => text(t, [{ type: 'bold' }]);
export const italic = (t: string) => text(t, [{ type: 'italic' }]);
export const link = (t: string, href: string) => text(t, [{ type: 'link', attrs: { href, target: '_blank', rel: 'noopener noreferrer' } }]);

type InlineInput = string | Inline | (string | Inline)[];
const inl = (c: InlineInput): Inline[] =>
  (Array.isArray(c) ? c : [c]).filter((x) => x !== '').map((x) => (typeof x === 'string' ? text(x) : x));

export const heading = (level: 2 | 3, c: InlineInput): Block => ({ type: 'heading', attrs: { level }, content: inl(c) });
export const para = (c: InlineInput): Block => {
  const content = inl(c);
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
};
export const bullets = (items: InlineInput[]): Block => ({
  type: 'bulletList',
  content: items.map((i) => ({ type: 'listItem', content: [para(i)] })),
});

/** Header row + body rows; each cell is inline content. */
export const table = (header: string[] | null, rows: InlineInput[][]): Block => {
  const cell = (type: 'tableCell' | 'tableHeader', c: InlineInput) => ({ type, attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [para(c)] });
  return {
    type: 'table',
    content: [
      ...(header ? [{ type: 'tableRow', content: header.map((h) => cell('tableHeader', h)) }] : []),
      ...rows.map((r) => ({ type: 'tableRow', content: r.map((c) => cell('tableCell', c)) })),
    ],
  };
};

/** Two-column label/value table — the note's "details" block. */
export const kv = (rows: [string, InlineInput][]): Block => table(null, rows.map(([k, v]) => [bold(k), ...[v]] as InlineInput[]));

export const doc = (blocks: Block[]): string => JSON.stringify({ type: 'doc', content: blocks });

/** Plain-text mirror for search_text. */
export function docText(json: string): string {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    const node = n as { text?: string; content?: unknown[] };
    if (typeof node.text === 'string') out.push(node.text);
    node.content?.forEach(walk);
  };
  walk(JSON.parse(json));
  return out.join(' ').replace(/\s+/g, ' ').trim();
}
