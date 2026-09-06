/** True when a Tiptap JSON document has no meaningful content — no text
 * anywhere, and no self-contained block node (an attachment, a link
 * preview, a table) that would still be worth keeping even without text.
 * Used by the Jots composer to silently discard a jot nobody actually
 * wrote or attached anything to, rather than leaving an empty card behind. */
export function isTiptapDocEmpty(json: string | null | undefined): boolean {
  if (!json) return true;
  try {
    const doc = JSON.parse(json);
    let hasContent = false;
    const selfContained = new Set(['attachment', 'linkPreview', 'table', 'image', 'horizontalRule']);
    const walk = (node: unknown) => {
      if (hasContent || !node || typeof node !== 'object') return;
      const n = node as { type?: string; text?: string; content?: unknown[] };
      if (typeof n.text === 'string' && n.text.trim()) hasContent = true;
      if (n.type && selfContained.has(n.type)) hasContent = true;
      if (Array.isArray(n.content)) n.content.forEach(walk);
    };
    walk(doc);
    return !hasContent;
  } catch {
    return true;
  }
}
