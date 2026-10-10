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

export const VOTER_LABEL = 'Voter';

/** Labels to SHOW: Mike's own, plus the automatic "Voter" for anyone with a
 * voter record (not stored — it follows merges and voter-file re-imports;
 * not editable). */
export function displayLabels(c: Pick<Contact, 'labels' | 'is_voter'>, hasVoterRecord?: boolean): string[] {
  const own = contactLabels(c);
  const voter = hasVoterRecord ?? !!c.is_voter;
  if (voter && !own.some((l) => l.toLowerCase() === VOTER_LABEL.toLowerCase())) return [...own, VOTER_LABEL];
  return own;
}
