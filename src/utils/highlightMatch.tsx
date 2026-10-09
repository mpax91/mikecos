import type React from 'react';

/** Bolds every case-insensitive occurrence of `query` inside `text` —
 * that's the whole point of a snippet (showing *why* something matched),
 * so the highlight isn't optional polish. */
export function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const q = query.trim();
  const lower = text.toLowerCase();
  const lowerQ = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let idx = lower.indexOf(lowerQ);
  while (idx !== -1) {
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(<mark key={idx}>{text.slice(idx, idx + q.length)}</mark>);
    i = idx + q.length;
    idx = lower.indexOf(lowerQ, i);
  }
  if (i < text.length) parts.push(text.slice(i));
  return parts;
}
