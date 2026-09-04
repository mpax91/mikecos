/** Extracts a short plain-text preview from a Tiptap JSON document string,
 * for showing on note cards. */
export function extractSnippet(contentJson: string | null, maxLen = 140): string {
  if (!contentJson) return '';
  try {
    const doc = JSON.parse(contentJson);
    const parts: string[] = [];

    function walk(node: unknown) {
      if (!node || typeof node !== 'object') return;
      const n = node as { type?: string; text?: string; content?: unknown[] };
      if (n.type === 'text' && n.text) parts.push(n.text);
      if (Array.isArray(n.content)) {
        for (const child of n.content) walk(child);
        if (n.type && n.type !== 'text') parts.push(' ');
      }
    }
    walk(doc);

    const text = parts.join('').replace(/\s+/g, ' ').trim();
    return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
  } catch {
    return '';
  }
}
