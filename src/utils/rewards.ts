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

/** The card that wins by default whenever nothing more specific applies —
 * the highest flat base rate among active cards (Mike's Wells Fargo Active
 * Cash at a flat 2%, for instance). Every category row and every Find
 * result falls back to this when no bonus beats it, and it's always
 * included in cardsToCarry below since it's meant to live in the wallet
 * at all times, not just during a specific quarter. */
export function defaultFlatRateCard(cards: RewardsCard[]): RewardsCard | null {
  const active = cards.filter((c) => c.active);
  if (active.length === 0) return null;
  return active.reduce((best, c) => (c.baseRate > best.baseRate ? c : best));
}

// The three everyday categories Mike actually swipes many times a month
// and wants an answer for every time — as opposed to STAPLE_CATEGORIES
// below, which is the broader list the reference table shows. Only these
// three drive which cards make it into the physical wallet by default.
export const MAJOR_CATEGORIES = ['Dining', 'Gas', 'Groceries'];

export interface CarryPlanEntry {
  card: RewardsCard;
  /** Short labels for why this card made the list — "Dining 5%", "2%
   * everywhere", "Always carry" — joined for display rather than picking
   * just one, since a card can earn its spot more than one way. */
  reasons: string[];
}

/** Cards worth actually carrying, as few as possible, with the reason each
 * one made the cut. The single default flat-rate card (the floor — see
 * defaultFlatRateCard) always makes the list, since it's the fallback for
 * everything else. On top of that, only the single best *in-person* card
 * for each of the 3 major categories gets added — and only when it
 * actually beats the default; if nothing beats 2%, the default already
 * has it covered and no extra card is worth carrying for it. Beyond the
 * 3 majors, any card with its own currently-active in-person rotating
 * bonus that beats the default also earns a slot — Mike's own "if another
 * category pops up, we can consider it" case. Online-only bonuses (see
 * RewardsBonus.onlineOnly — "Online Shopping," Amazon.com, Chase Travel)
 * never earn a card a spot here on their own: an online purchase doesn't
 * need the physical card present, so a card that's only good online
 * belongs in Find, not the wallet. A manual "Always Carry" flag is a
 * deliberate override on top of all of this (perks/points reasons the
 * cashback math alone wouldn't capture), never a replacement for it. */
export function carryPlan(cards: RewardsCard[]): CarryPlanEntry[] {
  const active = cards.filter((c) => c.active);
  const flat = defaultFlatRateCard(active);
  if (!flat) return [];
  const floor = flat.baseRate;

  const cardById = new Map<string, RewardsCard>();
  const reasonsById = new Map<string, string[]>();
  const addReason = (card: RewardsCard, reason: string) => {
    cardById.set(card.id, card);
    const list = reasonsById.get(card.id) ?? [];
    if (!list.includes(reason)) list.push(reason);
    reasonsById.set(card.id, list);
  };

  addReason(flat, `${floor}% everywhere`);

  for (const category of MAJOR_CATEGORIES) {
    const best = bestCardForCategory(active, category, { excludeOnlineOnly: true });
    if (best && best.rate > floor) addReason(best.card, `${category} ${best.rate}%`);
  }

  for (const c of active) {
    for (const b of c.bonuses) {
      if (b.kind === 'rotating' && !b.onlineOnly && isBonusActiveToday(b) && b.rate > floor) {
        addReason(c, `${b.category} ${b.rate}%`);
      }
    }
  }

  for (const c of active) {
    if (c.alwaysCarry) addReason(c, 'Always carry');
  }

  return Array.from(cardById.values()).map((card) => ({ card, reasons: reasonsById.get(card.id) ?? [] }));
}

// The everyday categories worth always showing a "best card" answer for,
// even before any card actually has a bonus in them — gas, dining, and
// groceries are staples Mike spends on many times a month and wants a
// standing answer for, not just whatever happens to be on a card already.
export const STAPLE_CATEGORIES = ['Gas', 'Dining', 'Groceries', 'Travel', 'Drugstores', 'Streaming'];

/** Every category worth a "best card" row on the main screen: the staples
 * above, plus every distinct bonus category (fixed or rotating, active or
 * not) across all active cards — so a card's own "Home Improvement" bonus
 * shows up automatically without Mike having to also declare it a staple.
 * Deduped case-insensitively, keeping whichever casing was seen first. */
export function everydayCategories(cards: RewardsCard[]): string[] {
  const seen = new Map<string, string>();
  for (const cat of STAPLE_CATEGORIES) seen.set(cat.toLowerCase(), cat);
  for (const card of cards) {
    if (!card.active) continue;
    for (const b of card.bonuses) {
      const key = b.category.trim().toLowerCase();
      if (key && !seen.has(key)) seen.set(key, b.category.trim());
    }
  }
  return Array.from(seen.values());
}

/** A rotating bonus whose window has fully lapsed with nothing queued up
 * to replace it — the "Q3 ended, Q4 hasn't been set yet" state. A bonus
 * that's merely upcoming (starts in the future) doesn't count; only when
 * every one of a card's rotating windows ends in the past does the card
 * need attention. A card with no rotating bonuses at all (a flat-rate
 * card like Wells Fargo Active Cash) never needs this — it has nothing to
 * rotate. */
export function needsQuarterUpdate(card: RewardsCard): boolean {
  const rotating = card.bonuses.filter((b) => b.kind === 'rotating' && b.startsOn && b.endsOn);
  if (rotating.length === 0) return false;
  const today = new Date().toISOString().slice(0, 10);
  return !rotating.some((b) => b.endsOn! >= today);
}

export function cardsNeedingQuarterUpdate(cards: RewardsCard[]): RewardsCard[] {
  return cards.filter((c) => c.active && needsQuarterUpdate(c));
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

// Alphanumeric-only, lowercased — for comparing a typed merchant name
// ("Rhoback.com") against a stored keyword ("rhoback") regardless of
// punctuation either side happens to have.
function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Does this bonus apply to a free-text query — either a category name
 * ("groceries") or a merchant someone actually shops at ("Rhoback.com")?
 * Category matching stays plain substring (issuer category names are
 * often idiosyncratic phrases, not a clean taxonomy Mike should have to
 * learn). Keyword matching is looser on purpose: Mike's own merchant
 * aliases ("amazon, rhoback, etsy") are short single words, and a typed
 * query often carries extra punctuation (".com") or is itself a substring
 * of what he stored, so it checks containment both directions on
 * alphanumeric-only text. */
function bonusMatchesQuery(bonus: RewardsBonus, rawQuery: string, normQuery: string): boolean {
  if (bonus.category.toLowerCase().includes(rawQuery)) return true;
  if (!bonus.keywords) return false;
  return bonus.keywords
    .split(',')
    .map((k) => normalizeForMatch(k))
    .filter(Boolean)
    .some((k) => normQuery.includes(k) || k.includes(normQuery));
}

export interface FindOptions {
  /** Ignore online-only bonuses (see RewardsBonus.onlineOnly) — used by
   * carryPlan's physical-wallet selection, since an online-only bonus
   * shouldn't be the reason a card earns a spot in the wallet. Find and
   * the category table leave this off, since both are meant to answer
   * "what's my best card for X," online or not. */
  excludeOnlineOnly?: boolean;
}

/** Ranks every active card for a free-text query — a category ("dining")
 * or a merchant ("Home Depot", "Rhoback.com"). A card's best applicable
 * rate wins: an active bonus that matches (by category text or a stored
 * merchant keyword — see bonusMatchesQuery) beats the card's flat base
 * rate. A card with no match at all still shows up at its base rate, so
 * the ranking always surfaces the honest fallback (e.g. a flat 2% card)
 * rather than only cards with a specific bonus. */
export function findBestCardsFor(cards: RewardsCard[], query: string, opts: FindOptions = {}): RewardsMatch[] {
  const rawQuery = query.trim().toLowerCase();
  if (!rawQuery) return [];
  const normQuery = normalizeForMatch(rawQuery);
  const matches: RewardsMatch[] = [];
  for (const card of cards) {
    if (!card.active) continue;
    const applicable = card.bonuses.filter(
      (b) => isBonusActiveToday(b) && bonusMatchesQuery(b, rawQuery, normQuery) && !(opts.excludeOnlineOnly && b.onlineOnly)
    );
    if (applicable.length > 0) {
      const best = applicable.reduce((a, b) => (b.rate > a.rate ? b : a));
      matches.push({ card, bonus: best, rate: best.rate });
    } else {
      matches.push({ card, bonus: null, rate: card.baseRate });
    }
  }
  return matches.sort((a, b) => b.rate - a.rate);
}

/** The single best card for one known category — same ranking as
 * findBestCardsFor, just the top result, for the main screen's
 * category-by-category reference table. */
export function bestCardForCategory(cards: RewardsCard[], category: string, opts: FindOptions = {}): RewardsMatch | null {
  return findBestCardsFor(cards, category, opts)[0] ?? null;
}

/** Cards whose best applicable answer right now is specifically an
 * online-only bonus (Amazon.com, "Online Shopping," Chase Travel) — Find's
 * "if this is an online purchase" callout. Deliberately not merchant-
 * specific (Mike doesn't want to maintain a database of every e-commerce
 * site): whenever the query doesn't hit a more specific match, this is the
 * generic fallback for "well, it's probably online, so use this instead
 * of your everyday default." */
export function onlineEligibleCards(cards: RewardsCard[]): RewardsMatch[] {
  const matches: RewardsMatch[] = [];
  for (const card of cards) {
    if (!card.active) continue;
    const applicable = card.bonuses.filter((b) => b.onlineOnly && isBonusActiveToday(b));
    if (applicable.length === 0) continue;
    const best = applicable.reduce((a, b) => (b.rate > a.rate ? b : a));
    matches.push({ card, bonus: best, rate: best.rate });
  }
  return matches.sort((a, b) => b.rate - a.rate);
}
