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

// ---- Quarter helpers for the rotating-bonus editor. Most rotating
// categories (Bank of America's picked-category, Discover it, Chase
// Freedom) run on plain calendar quarters, so the editor offers "Q1–Q4 of
// <year>" as the fast path — but a card whose rotation doesn't follow the
// calendar (the Amazon Prime Visa's own promo windows, which move on
// Amazon's schedule, not a quarter boundary) still needs real start/end
// dates, so that option stays available too. Either way the stored data
// is just startsOn/endsOn as YYYY-MM-DD — isBonusActiveToday and
// cardsForThisQuarter above don't know or care which path produced them. */
export function currentQuarter(date = new Date()): 1 | 2 | 3 | 4 {
  return (Math.floor(date.getMonth() / 3) + 1) as 1 | 2 | 3 | 4;
}

export function quarterDateRange(quarter: 1 | 2 | 3 | 4, year: number): { startsOn: string; endsOn: string } {
  const startMonth = (quarter - 1) * 3; // 0-indexed
  const endMonth = startMonth + 2;
  const startsOn = `${year}-${String(startMonth + 1).padStart(2, '0')}-01`;
  const lastDay = new Date(year, endMonth + 1, 0).getDate(); // day 0 of next month = last day of endMonth
  const endsOn = `${year}-${String(endMonth + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { startsOn, endsOn };
}

// For display: if a rotating bonus's stored dates exactly match a full
// calendar quarter, show "Q3 2026" instead of the raw range — friendlier
// for the common case, while a non-quarter-aligned window (Amazon-style)
// still shows its real dates since it won't match any quarter exactly.
export function describeRotatingWindow(startsOn: string | null, endsOn: string | null): string | null {
  if (!startsOn || !endsOn) return null;
  const year = parseInt(startsOn.slice(0, 4), 10);
  for (const q of [1, 2, 3, 4] as const) {
    const range = quarterDateRange(q, year);
    if (range.startsOn === startsOn && range.endsOn === endsOn) return `Q${q} ${year}`;
  }
  return `${startsOn} – ${endsOn}`;
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
