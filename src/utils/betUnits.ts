// ---- Unit size (Mike, 2026-10-23) ----
//
// A "unit" is Mike's typical bet: the average stake of his own cash picks
// (total wagered ÷ number of bets). Decisions (his "go with defaults"):
//  1. What goes into the average: only cash picks. Arb sides, hedge bets
//     and free bets are left out — their size comes from the promo or the
//     arb math, not his confidence, and one big hedge would inflate the
//     unit for weeks. A hedge's ORIGINAL pick is a real pick, so it counts.
//  2. Units then, not now: every bet is measured against the unit as of
//     the moment it was placed (the running average through that bet), so
//     a bet's size in units never changes later as the average moves.
//  3. Average is the headline; the median rides beside it so a few big
//     bets pulling the average up are easy to spot.
//
// Everything is derived on read — nothing about units is stored.

import type { Bet } from '../api/types';
import { computeProfit, countsAsPick, formatMoney, type BetGroupStat } from './bets';

/** Does this bet count toward the unit-size average? */
export function countsTowardUnit(bet: Bet): boolean {
  return countsAsPick(bet) && bet.stake_type !== 'free_bet' && bet.wager > 0;
}

function placedOrder(a: Bet, b: Bet): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface UnitPoint {
  date: string;
  average: number; // running average through this pick
}

export interface UnitIndex {
  /** Unit (in $) each bet was placed at, by bet id. null when no cash pick exists yet. */
  byId: Map<string, number>;
  /** Today's unit: average of every cash pick. */
  average: number | null;
  median: number | null;
  basisCount: number;
  /** Running average after each cash pick, oldest first (one point per pick). */
  history: UnitPoint[];
  /** Unit as of a date — the running average through the last pick on or before it. */
  asOf: (date: string) => number | null;
}

export function buildUnitIndex(bets: Bet[]): UnitIndex {
  const ordered = [...bets].sort(placedOrder);
  const byId = new Map<string, number>();
  const history: UnitPoint[] = [];
  const stakes: number[] = [];
  let total = 0;
  let running: number | null = null;
  for (const bet of ordered) {
    if (countsTowardUnit(bet)) {
      total += bet.wager;
      stakes.push(bet.wager);
      running = total / stakes.length;
      history.push({ date: bet.date, average: running });
    }
    if (running != null) byId.set(bet.id, running);
  }
  // Bets placed before the first cash pick (e.g. an early free bet) are
  // measured against that first pick rather than left without a size.
  const first = history[0]?.average ?? null;
  if (first != null) for (const bet of ordered) if (!byId.has(bet.id)) byId.set(bet.id, first);

  const asOf = (date: string): number | null => {
    let found: number | null = null;
    for (const p of history) {
      if (p.date > date) break;
      found = p.average;
    }
    return found ?? first;
  };

  return { byId, average: running, median: median(stakes), basisCount: stakes.length, history, asOf };
}

/** A copy of each bet with its money in units — wager and any typed profit
 * divided by the unit it was placed at. Odds, results and dates are
 * untouched, so every existing rollup (computeProfit, groupBets, the
 * calendar, linked-group math) works unchanged and simply reads in units. */
export function unitizeBets(bets: Bet[], index: UnitIndex): Bet[] {
  return bets.map((b) => {
    const u = index.byId.get(b.id);
    if (!u) return b;
    return { ...b, wager: b.wager / u, manual_profit: b.manual_profit != null ? b.manual_profit / u : null };
  });
}

/** "1.25u", "-0.8u", "12.5u". */
export function formatUnits(v: number): string {
  const abs = Math.abs(v);
  const digits = abs >= 10 ? 1 : 2;
  const text = abs.toFixed(digits).replace(/\.?0+$/, '');
  return `${v < 0 && text !== '0' ? '-' : ''}${text}u`;
}

export type BetDisplay = 'dollars' | 'units';

export function formatAmount(v: number, display: BetDisplay): string {
  return display === 'units' ? formatUnits(v) : formatMoney(v);
}

const DISPLAY_KEY = 'mikeos.bets.display';

export function loadBetDisplay(): BetDisplay {
  try {
    return localStorage.getItem(DISPLAY_KEY) === 'units' ? 'units' : 'dollars';
  } catch {
    return 'dollars';
  }
}

export function saveBetDisplay(d: BetDisplay): void {
  try {
    localStorage.setItem(DISPLAY_KEY, d);
  } catch {
    /* private window etc. — the switch still works for this visit */
  }
}

// ---- Performance by unit size ----

export const UNIT_BUCKETS: { label: string; test: (u: number) => boolean }[] = [
  { label: 'Under 0.75u', test: (u) => u < 0.75 },
  { label: 'About 1u (0.75–1.5u)', test: (u) => u >= 0.75 && u < 1.5 },
  { label: '1.5–3u', test: (u) => u >= 1.5 && u < 3 },
  { label: '3u+', test: (u) => u >= 3 },
];

export function unitsOf(bet: Bet, index: UnitIndex, original: Bet = bet): number | null {
  const u = index.byId.get(original.id);
  return u ? original.wager / u : null;
}

export function bucketUnits(units: number): string {
  return UNIT_BUCKETS.find((b) => b.test(units))?.label ?? UNIT_BUCKETS[UNIT_BUCKETS.length - 1].label;
}

/** Same shape as the other money breakdowns, in bucket order. `sizeOf`
 * gives each bet's size in units (from the ORIGINAL dollar bet), while the
 * money columns come from whichever bets are passed (dollars or units). */
export function groupByUnitSize(bets: Bet[], sizeOf: (b: Bet) => number | null): BetGroupStat[] {
  const map = new Map<string, BetGroupStat>();
  for (const b of UNIT_BUCKETS) map.set(b.label, { key: b.label, count: 0, risked: 0, won: 0, lost: 0, net: 0, wins: 0, losses: 0, winRate: null });
  for (const bet of bets) {
    if (!countsTowardUnit(bet)) continue; // free bets / arb sides have no "confidence" size
    const size = sizeOf(bet);
    if (size == null) continue;
    const stat = map.get(bucketUnits(size))!;
    const profit = computeProfit(bet);
    stat.count += 1;
    stat.risked += bet.wager;
    stat.net += profit;
    if (bet.result === 'win') {
      stat.won += profit;
      stat.wins += 1;
    } else if (bet.result === 'loss') {
      stat.lost += bet.wager;
      stat.losses += 1;
    }
    stat.winRate = stat.wins + stat.losses > 0 ? stat.wins / (stat.wins + stat.losses) : null;
  }
  return [...map.values()].filter((s) => s.count > 0);
}
