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
/** Automatic: linked to a current Bedford Bee subscriber (gone once they leave). */
export const BEE_LABEL = 'Bee';
/** Automatic: bought from the Bedford Bee merch store (Fourthwall). */
export const MERCH_LABEL = 'Merch';

/** Labels to SHOW: Mike's own, plus the automatic "Voter" for anyone with a
 * voter record (not stored — it follows merges and voter-file re-imports;
 * not editable). */
export function displayLabels(c: Pick<Contact, 'labels' | 'is_voter' | 'is_bee' | 'is_merch'>, hasVoterRecord?: boolean, isBee?: boolean, isMerch?: boolean): string[] {
  const own = contactLabels(c);
  const out = [...own];
  const has = (l: string) => own.some((x) => x.toLowerCase() === l.toLowerCase());
  if ((hasVoterRecord ?? !!c.is_voter) && !has(VOTER_LABEL)) out.push(VOTER_LABEL);
  if ((isBee ?? !!c.is_bee) && !has(BEE_LABEL)) out.push(BEE_LABEL);
  if ((isMerch ?? !!c.is_merch) && !has(MERCH_LABEL)) out.push(MERCH_LABEL);
  return out;
}

/** Automatic labels — shown, never stored or editable. */
export const isAutoLabel = (l: string) => l === VOTER_LABEL || l === BEE_LABEL || l === MERCH_LABEL;
export const autoLabelClass = (l: string) => (l === VOTER_LABEL ? ' contact-label--voter' : l === BEE_LABEL ? ' contact-label--bee' : l === MERCH_LABEL ? ' contact-label--merch' : '');
