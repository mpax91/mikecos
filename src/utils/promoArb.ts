// ---- Promo-arb screener (Mike, 2026-10-23) ----
//
// Turns the day's DraftKings lines (ESPN's odds partner — see
// worker/src/betsEnrichment.ts /slate) plus Mike's active promos into
// specific two-sided plays that lock a profit whichever side wins:
//
//  1. Minimum boost per game — for every two-way market (moneyline, spread,
//     total) and each side, the smallest profit boost on that side that makes
//     it an arb against the other side at DK's price. At −110/−110 that's
//     ≈21%; sharper markets need less.
//  2. Promo plays — (a) two boosts at different books on opposite sides,
//     (b) one boost that clears a game's minimum on its own, (c) a free bet
//     converted to cash by hedging the other side. Sized at the promo's
//     max-bet cap (the smaller cap when two promos limit each other).
//  3. Board arbs — two typed sportsbook cells in Best Bets that already form
//     an arb with no promo at all.
//
// The one assumption: a boosted book's price before the boost ≈ DK's. Every
// play can be re-run with the real numbers in its calculator before betting.
//
// Everything here is pure (no React, no fetch) so it's unit-testable.

import type { BetGameOdds, BetPromo, BetSlateGame } from '../api/types';

export type ArbMarket = 'ml' | 'spread' | 'total';
export type ArbSide = 'away' | 'home' | 'over' | 'under';

/** One side of a two-way market at DK's price. */
export interface MarketSide {
  side: ArbSide;
  label: string; // "MIL ML", "CHI +1.5", "Over 240.5"
  price: number; // American odds
}

export interface MarketPair {
  market: ArbMarket;
  a: MarketSide;
  b: MarketSide;
}

// ---- Odds math ----

export function americanToDecimal(american: number): number {
  return american >= 0 ? 1 + american / 100 : 1 + 100 / -american;
}

export function decimalToAmerican(decimal: number): number {
  if (decimal <= 1) return 0;
  return decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1));
}

export function formatAmerican(american: number): string {
  return american > 0 ? `+${american}` : `${american}`;
}

/** A profit boost multiplies the winnings, not the stake: +100 boosted 50% → +150. */
export function boostedDecimal(decimal: number, boost: number): number {
  return 1 + (decimal - 1) * (1 + boost);
}

/** Smallest profit boost (0.21 = 21%) on a side at `boostedPrice` that makes
 * it an arb against `otherPrice` unboosted. ≤ 0 means the two prices are
 * already an arb with no boost at all. */
export function minBoostToArb(boostedPrice: number, otherPrice: number): number {
  const other = americanToDecimal(otherPrice);
  const target = 1 / (1 - 1 / other); // the boosted side must pay more than this
  return (target - 1) / (americanToDecimal(boostedPrice) - 1) - 1;
}

const signedLine = (n: number) => (n > 0 ? `+${n}` : n === 0 ? 'PK' : `${n}`);

/** Every two-way market DK has priced for a game. */
export function marketPairs(odds: BetGameOdds | null, awayAbbr: string, homeAbbr: string): MarketPair[] {
  if (!odds) return [];
  const pairs: MarketPair[] = [];
  const ml = odds.moneyline;
  if (ml && ml.away.current != null && ml.home.current != null) {
    pairs.push({
      market: 'ml',
      a: { side: 'away', label: `${awayAbbr} ML`, price: ml.away.current },
      b: { side: 'home', label: `${homeAbbr} ML`, price: ml.home.current },
    });
  }
  const sp = odds.spread;
  if (sp && sp.away.current != null && sp.home.current != null && sp.away.price != null && sp.home.price != null) {
    pairs.push({
      market: 'spread',
      a: { side: 'away', label: `${awayAbbr} ${signedLine(sp.away.current)}`, price: sp.away.price },
      b: { side: 'home', label: `${homeAbbr} ${signedLine(sp.home.current)}`, price: sp.home.price },
    });
  }
  const t = odds.total;
  if (t && t.current != null && t.overOdds != null && t.underOdds != null) {
    pairs.push({
      market: 'total',
      a: { side: 'over', label: `Over ${t.current}`, price: t.overOdds },
      b: { side: 'under', label: `Under ${t.current}`, price: t.underOdds },
    });
  }
  return pairs;
}

export interface GameSpot {
  game: BetSlateGame;
  market: ArbMarket;
  boosted: MarketSide; // the side the boost goes on
  other: MarketSide; // bet unboosted at DK's price
  minBoost: number;
}

/** The game's single cheapest arb: the market + side needing the smallest boost. */
export function bestSpot(game: BetSlateGame): GameSpot | null {
  let best: GameSpot | null = null;
  for (const pair of marketPairs(game.odds, game.awayAbbr, game.homeAbbr)) {
    for (const [boosted, other] of [
      [pair.a, pair.b],
      [pair.b, pair.a],
    ] as const) {
      const minBoost = minBoostToArb(boosted.price, other.price);
      if (!best || minBoost < best.minBoost) best = { game, market: pair.market, boosted, other, minBoost };
    }
  }
  return best;
}

// ---- Two-leg arb solver ----

export interface ArbLegInput {
  price: number; // American odds before any boost
  boost?: number; // 0.5 = 50% profit boost
  freeBet?: boolean; // stake isn't returned and isn't cash out of pocket
  cap?: number | null; // most this leg can be staked (promo max bet)
}

export interface ArbLegResult {
  stake: number;
  effectivePrice: number; // American, after the boost
  payout: number; // what comes back if this leg wins
}

export interface ArbResult {
  legs: [ArbLegResult, ArbLegResult];
  cashStaked: number;
  profit: number; // the same whichever leg wins
  roi: number; // profit ÷ cash staked (Infinity-safe: 0 when nothing cash staked)
  isArb: boolean;
}

/** Per $1 staked, what a winning leg returns (a free bet keeps only the winnings). */
function returnPerDollar(leg: ArbLegInput): number {
  const winnings = (americanToDecimal(leg.price) - 1) * (1 + (leg.boost ?? 0));
  return leg.freeBet ? winnings : 1 + winnings;
}

/** Sizes two opposite-side bets so either result pays the same. The anchor
 * (first leg with a cap, else leg 0) is staked at its cap — or `fallback`
 * with no cap — and the other leg follows; if that breaks the other leg's
 * cap, both scale down to it. Stakes are rounded to the cent. */
export function solveArb(legs: [ArbLegInput, ArbLegInput], fallback = 100): ArbResult {
  const r = legs.map(returnPerDollar) as [number, number];
  const anchor = legs[0].cap != null ? 0 : legs[1].cap != null ? 1 : 0;
  const other = 1 - anchor;
  let sAnchor = legs[anchor].cap ?? fallback;
  let sOther = (sAnchor * r[anchor]) / r[other];
  const otherCap = legs[other].cap;
  if (otherCap != null && sOther > otherCap) {
    sOther = otherCap;
    sAnchor = (sOther * r[other]) / r[anchor];
  }
  const stakes: [number, number] = [0, 0];
  stakes[anchor] = Math.round(sAnchor * 100) / 100;
  stakes[other] = Math.round(sOther * 100) / 100;
  const payouts = [stakes[0] * r[0], stakes[1] * r[1]];
  const cashStaked = legs.reduce((sum, leg, i) => sum + (leg.freeBet ? 0 : stakes[i]), 0);
  const profit = Math.min(payouts[0], payouts[1]) - cashStaked;
  return {
    legs: [0, 1].map((i) => ({
      stake: stakes[i],
      effectivePrice: decimalToAmerican(1 + (americanToDecimal(legs[i].price) - 1) * (1 + (legs[i].boost ?? 0))),
      payout: Math.round(payouts[i] * 100) / 100,
    })) as [ArbLegResult, ArbLegResult],
    cashStaked: Math.round(cashStaked * 100) / 100,
    profit: Math.round(profit * 100) / 100,
    roi: cashStaked > 0 ? profit / cashStaked : 0,
    isArb: profit > 0.005,
  };
}

// ---- Promos ----

export type PromoUse = { kind: 'boost'; boost: number } | { kind: 'freebet'; amount: number };

export interface PromoFit {
  promo: BetPromo;
  use: PromoUse | null;
  minOdds: number | null;
  reason: string | null; // why it can't be used for a straight-bet arb
}

const MULTI_LEG_RE = /parlay|\bsgp|same[\s-]?game|teaser|round[\s-]?robin|multi|accumulator|\d+\s*\+?\s*legs?\b/i;

function parseMoney(s: string | null): number | null {
  if (!s) return null;
  const m = s.replace(/,/g, '').match(/\$\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:\$|dollars?\b)/i);
  if (!m) return null;
  const n = Number(m[1] ?? m[2]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parsePercent(s: string | null): number | null {
  if (!s) return null;
  const m = s.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n / 100 : null;
}

/** "+100", "100", "-200 or longer", "EVEN" → American odds; a bare number is plus money. */
export function parseMinOdds(s: string | null): number | null {
  if (!s) return null;
  if (/\beven\b|\bev\b/i.test(s)) return 100;
  const m = s.match(/([-+])?\s*(\d{3,5})/);
  if (!m) return null;
  const n = Number(m[2]) * (m[1] === '-' ? -1 : 1);
  return Number.isFinite(n) ? n : null;
}

/** A longer price is always the higher payout, so compare in decimal. */
export function meetsMinOdds(price: number, min: number | null): boolean {
  return min == null || americanToDecimal(price) >= americanToDecimal(min) - 1e-9;
}

/** Can this promo go on one side of a straight bet, and as what? */
export function promoFit(promo: BetPromo): PromoFit {
  const minOdds = parseMinOdds(promo.odds);
  const legs = promo.legs ? Number(promo.legs.match(/\d+/)?.[0]) : NaN;
  const base = { promo, minOdds };
  if (Number.isFinite(legs) && legs >= 2) return { ...base, use: null, reason: `Needs ${legs}+ legs` };
  if (MULTI_LEG_RE.test(`${promo.description} ${promo.notes ?? ''}`)) return { ...base, use: null, reason: 'Parlay / SGP only' };
  const type = promo.promo_type.toLowerCase();
  if (type.includes('free')) {
    const amount = parseMoney(promo.amount) ?? promo.max_bonus;
    return amount ? { ...base, use: { kind: 'freebet', amount }, reason: null } : { ...base, use: null, reason: 'No free-bet amount' };
  }
  if (type.includes('boost')) {
    const boost = parsePercent(promo.amount) ?? parsePercent(promo.description);
    return boost ? { ...base, use: { kind: 'boost', boost }, reason: null } : { ...base, use: null, reason: 'No boost % in Amount' };
  }
  return { ...base, use: null, reason: `${promo.promo_type} isn't a straight-bet arb` };
}

function promoCoversSport(promo: BetPromo, sport: string): boolean {
  return !promo.sport || promo.sport === sport;
}

// ---- Plays ----

export interface PlayLeg {
  label: string; // "MIL ML"
  price: number; // DK price before the boost
  book: string; // where to place it
  promo: BetPromo | null;
  boost: number; // 0 when unboosted
  freeBet: boolean;
  cap: number | null;
  minBet: number | null;
  minOdds: number | null;
}

export type PlayKind = 'pair' | 'solo' | 'freebet';

export interface ArbPlay {
  id: string;
  kind: PlayKind;
  game: BetSlateGame;
  market: ArbMarket;
  legs: [PlayLeg, PlayLeg];
  result: ArbResult;
  sized: boolean; // false when no cap — stakes shown per $100 on the promo leg
  warnings: string[];
  otherGames: number; // more games where this same promo play also locks a profit
}

export const HEDGE_BOOK = 'Any book';

function legFromPromo(side: MarketSide, fit: PromoFit): PlayLeg {
  const use = fit.use!;
  return {
    label: side.label,
    price: side.price,
    book: fit.promo.sportsbook,
    promo: fit.promo,
    boost: use.kind === 'boost' ? use.boost : 0,
    freeBet: use.kind === 'freebet',
    cap: use.kind === 'freebet' ? use.amount : fit.promo.max_bonus,
    minBet: fit.promo.min_bet,
    minOdds: fit.minOdds,
  };
}

function hedgeLeg(side: MarketSide, promoBook: string): PlayLeg {
  return {
    label: side.label,
    price: side.price,
    book: promoBook === 'DraftKings' ? HEDGE_BOOK : 'DraftKings',
    promo: null,
    boost: 0,
    freeBet: false,
    cap: null,
    minBet: null,
    minOdds: null,
  };
}

export function solvePlayLegs(legs: [PlayLeg, PlayLeg]): ArbResult {
  return solveArb(legs.map((l) => ({ price: l.price, boost: l.boost, freeBet: l.freeBet, cap: l.cap })) as [ArbLegInput, ArbLegInput]);
}

function playWarnings(legs: [PlayLeg, PlayLeg], result: ArbResult): string[] {
  const out: string[] = [];
  legs.forEach((leg, i) => {
    if (leg.minBet != null && result.legs[i].stake + 0.005 < leg.minBet) {
      out.push(`${leg.book}'s promo needs $${leg.minBet}+ — this split stakes $${result.legs[i].stake.toFixed(2)}`);
    }
  });
  return out;
}

function playFor(kind: PlayKind, game: BetSlateGame, market: ArbMarket, legs: [PlayLeg, PlayLeg]): ArbPlay | null {
  const result = solvePlayLegs(legs);
  if (!result.isArb) return null;
  return {
    id: `${kind}:${game.sport}:${game.eventId}:${market}:${legs.map((l) => `${l.promo?.id ?? 'x'}@${l.label}`).join('|')}`,
    kind,
    game,
    market,
    legs,
    result,
    sized: legs.some((l) => l.cap != null),
    warnings: playWarnings(legs, result),
    otherGames: 0,
  };
}

/** The best play for each promo (solo boost / free bet) and each pair of
 * boosts at different books, across every pregame game on the slate, most
 * locked profit first. One row per promo / pair — the count of other games
 * that also work rides along on `otherGames`. */
export function findPromoPlays(games: BetSlateGame[], promos: BetPromo[]): ArbPlay[] {
  const fits = promos.map(promoFit).filter((f) => f.use);
  const pregame = games.filter((g) => g.state === 'pre' && g.odds);
  const best = new Map<string, { play: ArbPlay; games: Set<string> }>();
  const consider = (key: string, play: ArbPlay | null) => {
    if (!play) return;
    const cur = best.get(key);
    if (!cur) best.set(key, { play, games: new Set([play.game.eventId]) });
    else {
      cur.games.add(play.game.eventId);
      if (play.result.profit > cur.play.result.profit) cur.play = play;
    }
  };

  for (const game of pregame) {
    const pairs = marketPairs(game.odds, game.awayAbbr, game.homeAbbr);
    const sportFits = fits.filter((f) => promoCoversSport(f.promo, game.sport));
    for (const pair of pairs) {
      for (const [x, y] of [
        [pair.a, pair.b],
        [pair.b, pair.a],
      ] as const) {
        // One promo on x, the other side bet plain.
        for (const fit of sportFits) {
          if (!meetsMinOdds(x.price, fit.minOdds)) continue;
          const kind: PlayKind = fit.use!.kind === 'freebet' ? 'freebet' : 'solo';
          consider(`one:${fit.promo.id}`, playFor(kind, game, pair.market, [legFromPromo(x, fit), hedgeLeg(y, fit.promo.sportsbook)]));
        }
        // Two boosts at different books, one on each side.
        for (const f1 of sportFits) {
          if (f1.use!.kind !== 'boost' || !meetsMinOdds(x.price, f1.minOdds)) continue;
          for (const f2 of sportFits) {
            if (f2 === f1 || f2.use!.kind !== 'boost' || f2.promo.sportsbook === f1.promo.sportsbook) continue;
            if (!meetsMinOdds(y.price, f2.minOdds)) continue;
            const key = `pair:${[f1.promo.id, f2.promo.id].sort().join('+')}`;
            consider(key, playFor('pair', game, pair.market, [legFromPromo(x, f1), legFromPromo(y, f2)]));
          }
        }
      }
    }
  }

  // A pair only earns its row when it beats both promos used alone — otherwise
  // the solo plays already say it better.
  const soloBest = new Map<string, number>();
  for (const [key, { play }] of best) if (key.startsWith('one:')) soloBest.set(key.slice(4), play.result.profit);
  const out: ArbPlay[] = [];
  for (const [key, { play, games }] of best) {
    if (key.startsWith('pair:')) {
      const ids = key.slice(5).split('+');
      if (ids.every((id) => (soloBest.get(id) ?? -Infinity) >= play.result.profit)) continue;
    }
    out.push({ ...play, otherGames: games.size - 1 });
  }
  return out.sort((a, b) => b.result.profit - a.result.profit);
}

/** Why each active promo isn't in the plays (so nothing silently disappears). */
export function unusablePromos(promos: BetPromo[]): PromoFit[] {
  return promos.map(promoFit).filter((f) => !f.use);
}

// ---- Board arbs: two typed sportsbook cells that already arb ----

export interface ParsedCell {
  market: ArbMarket;
  side: ArbSide;
  line: number | null; // spread from that side's view, or the total
  price: number;
}

const PRICE_RE = /(?<![\d.])([-+])(\d{3,5})(?![\d.])|\b(even|ev)\b/gi;

function lastPrice(value: string): { price: number; index: number } | null {
  let found: { price: number; index: number } | null = null;
  for (const m of value.matchAll(PRICE_RE)) {
    const price = m[3] ? 100 : Number(m[2]) * (m[1] === '-' ? -1 : 1);
    if (Math.abs(price) >= 100) found = { price, index: m.index ?? 0 };
  }
  if (found) return found;
  // A bare 3–5 digit whole number is plus money ("105" = +105), as in Best Bets' own parser.
  for (const m of value.matchAll(/(?<![-+.\d])(\d{3,5})(?![.\d])/g)) found = { price: Number(m[1]), index: m.index ?? 0 };
  return found;
}

function wordMatch(value: string, token: string): boolean {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z])${esc}([^a-z]|$)`, 'i').test(value);
}

/** Reads a free-typed Best Bets cell: "MIL -1.5 (-110)", "CHI ML +105",
 * "o240.5 -108", "Under 221.5 -110". Returns null when it doesn't name a
 * side (a bare "-110" can't be paired — which side is it?). */
export function parseBoardCell(value: string, awayAbbr: string, homeAbbr: string): ParsedCell | null {
  const v = value.trim();
  if (!v) return null;
  const priced = lastPrice(v);
  if (!priced) return null;
  const head = v.slice(0, priced.index);

  const total = head.match(/(?:^|[^a-z])(o|over|u|under)\s*(\d{1,3}(?:\.\d)?)/i);
  if (total) {
    const side: ArbSide = total[1].toLowerCase().startsWith('o') ? 'over' : 'under';
    return { market: 'total', side, line: Number(total[2]), price: priced.price };
  }
  const isAway = wordMatch(head, awayAbbr);
  const isHome = wordMatch(head, homeAbbr);
  if (isAway === isHome) return null; // neither, or both — ambiguous
  const side: ArbSide = isAway ? 'away' : 'home';
  if (/\bml\b|money\s*line/i.test(head)) return { market: 'ml', side, line: null, price: priced.price };
  const spread = head.match(/(?:^|[^\d.])([-+]\d{1,2}(?:\.\d)?|pk|pick)(?![\d])/i);
  if (spread) {
    const line = /pk|pick/i.test(spread[1]) ? 0 : Number(spread[1]);
    return { market: 'spread', side, line, price: priced.price };
  }
  return { market: 'ml', side, line: null, price: priced.price };
}

const OPPOSITE: Record<ArbSide, ArbSide> = { away: 'home', home: 'away', over: 'under', under: 'over' };

/** Do these two cells cover every result? Opposite sides of the same market,
 * with lines that meet or overlap (a gap would be a middle, not an arb). */
function covers(a: ParsedCell, b: ParsedCell): boolean {
  if (a.market !== b.market || OPPOSITE[a.side] !== b.side) return false;
  if (a.market === 'spread') return a.line != null && b.line != null && a.line + b.line >= 0;
  if (a.market === 'total') {
    const over = a.side === 'over' ? a : b;
    const under = a.side === 'over' ? b : a;
    return over.line != null && under.line != null && over.line <= under.line;
  }
  return true;
}

export interface BoardArb {
  books: [string, string];
  cells: [ParsedCell, ParsedCell];
  margin: number; // locked profit as a share of total staked
  result: ArbResult; // sized to $100 on the first book
}

/** The best arb among a row's typed sportsbook cells, if any. */
export function findBoardArb(cells: Map<string, string>, books: string[], awayAbbr: string, homeAbbr: string): BoardArb | null {
  const parsed = books
    .map((book) => ({ book, cell: parseBoardCell(cells.get(book) ?? '', awayAbbr, homeAbbr) }))
    .filter((x): x is { book: string; cell: ParsedCell } => x.cell !== null);
  let best: BoardArb | null = null;
  for (let i = 0; i < parsed.length; i++) {
    for (let j = i + 1; j < parsed.length; j++) {
      const a = parsed[i];
      const b = parsed[j];
      if (!covers(a.cell, b.cell)) continue;
      const inv = 1 / americanToDecimal(a.cell.price) + 1 / americanToDecimal(b.cell.price);
      if (inv >= 1) continue;
      const margin = 1 / inv - 1;
      if (!best || margin > best.margin) {
        best = { books: [a.book, b.book], cells: [a.cell, b.cell], margin, result: solveArb([{ price: a.cell.price }, { price: b.cell.price }]) };
      }
    }
  }
  return best;
}

/** "CHI @ MIL" → ['CHI', 'MIL'] (the board's matchup is always Away @ Home). */
export function splitMatchup(matchup: string): [string, string] | null {
  const [away, home] = matchup.split('@').map((s) => s.trim());
  return away && home ? [away, home] : null;
}
