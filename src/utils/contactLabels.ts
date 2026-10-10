import type { Contact } from '../api/types';

/** A contact's labels (JSON string[] column; '[]' when none). */
export function contactLabels(c: Pick<Contact, 'labels'>): string[] {
  try {
    const v = JSON.parse(c.labels || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
