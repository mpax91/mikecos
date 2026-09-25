import type { RewardsBonus, RewardsCard } from '../api/types';

/** A rotating bonus counts as "active" only when today falls inside its own
 * start/end dates — no separate quarter/calendar concept anywhere else in
 * the app needs to know about. A fixed bonus is always active. A rotating
 * bonus with no dates set yet (mid-entry) is treated as inactive rather
 * than guessed at. Compared as plain YYYY-MM-DD strings, which sort
 * correctly lexicographically and sidestep timezone conversion entirely. */
export function isBonusActiveToday(bonus: RewardsBonus): boolean {
  if (bonus.kind === 'fixed') return true;
  if (!bonus.startsOn || !bonus.endsOn) return false;
  const today = new Date().toISOString().slice(0, 10);
  return bonus.startsOn <= today && today <= bonus.endsOn;
}

/** Cards worth actually carrying right now: anything Mike has manually
 * flagged "always carry," plus any card whose rotating bonus is active
 * today. This is the deliberately honest version of "the few cards that
 * cover all my bases" — a curated flag plus real dates, not a computed
 * optimization over spend Mike never tracked (quarterly caps are
 * explicitly ignored, per his own call). */
export function cardsForThisQuarter(cards: RewardsCard[]): RewardsCard[] {
  return cards.filter((c) => c.active && (c.alwaysCarry || c.bonuses.some((b) => b.kind === 'rotating' && isBonusActiveToday(b))));
}

export interface RewardsMatch {
  card: RewardsCard;
  bonus: RewardsBonus | null;
  rate: number;
}

/** Ranks every active card for a free-text category query. A card's best
 * applicable rate wins: an active bonus whose category text contains the
 * query beats the card's flat base rate. Substring matching (not a fixed
 * picklist) on purpose — issuer rotating-category names are often
 * idiosyncratic phrases ("Wholesale clubs & select streaming services"),
 * not a clean taxonomy Mike should have to learn. */
export function findBestCardsFor(cards: RewardsCard[], query: string): RewardsMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const matches: RewardsMatch[] = [];
  for (const card of cards) {
    if (!card.active) continue;
    const applicable = card.bonuses.filter((b) => isBonusActiveToday(b) && b.category.toLowerCase().includes(q));
    if (applicable.length > 0) {
      const best = applicable.reduce((a, b) => (b.rate > a.rate ? b : a));
      matches.push({ card, bonus: best, rate: best.rate });
    } else {
      matches.push({ card, bonus: null, rate: card.baseRate });
    }
  }
  return matches.sort((a, b) => b.rate - a.rate);
}
