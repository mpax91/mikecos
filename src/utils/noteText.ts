/** Notes store their body as a stringified Tiptap/ProseMirror doc, not
 * HTML — walk its node tree collecting text so a card/row can show a plain
 * preview snippet instead of looking blank under the title. Shared by
 * EntityCard (Projects' note cards) and VaultNoteRow (Vault's note list). */
export function extractNoteText(content: string | null, maxLength = 160): string {
  if (!content) return '';
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch {
    return '';
  }
  const parts: string[] = [];
  function walk(node: unknown) {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: string; text?: string; content?: unknown[] };
    if (n.type === 'text' && n.text) parts.push(n.text);
    if (Array.isArray(n.content)) {
      for (const child of n.content) walk(child);
      if (n.type && n.type !== 'text' && parts.length && parts[parts.length - 1] !== ' ') parts.push(' ');
    }
  }
  walk(doc);
  const text = parts.join('').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength).trimEnd()}…` : text;
}
