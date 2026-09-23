import type { Bet, BetResult, BetTransaction } from '../api/types';

// Fixed lists (like Contacts' CIRCLES) rather than free text, so the
// "performance by sport"/"performance by bet type" breakdowns stay clean
// and comparable instead of fragmenting across "Parlay" vs "3-leg parlay"
// spelling variants — this was a deliberate choice, not a default (see the
// scoping discussion this feature was built from).
export const SPORTS = ['NFL', 'NBA', 'MLB', 'NHL', 'NCAAF', 'NCAAB', 'Soccer', 'Tennis', 'Golf', 'MMA/Boxing', 'Other'];

export const BET_TYPES = ['Moneyline', 'Spread', 'Total (Over/Under)', 'Player Prop', 'Parlay', 'Same Game Parlay', 'SGP+', 'Prop', 'Teaser', 'Futures', 'Other'];

// Only these three ever carry legs (see worker/migrations/0038_bet_legs.sql)
// — a straight bet (including a plain 'Prop') keeps using the single
// pick/odds fields on the bet itself.
export const PARLAY_BET_TYPES = ['Parlay', 'Same Game Parlay', 'SGP+'];

export function isParlayType(betType: string): boolean {
  return PARLAY_BET_TYPES.includes(betType);
}

// A leg reuses the same bet-type vocabulary as a straight bet, minus the
// parlay types themselves (a leg can't contain another parlay).
export const LEG_BET_TYPES = BET_TYPES.filter((t) => !PARLAY_BET_TYPES.includes(t));

// Sportsbook stays free text (unlike sport/bet type) so a one-off entry
// never gets blocked, but the suggestion list itself is exactly the five
// books Mike actually uses — same set as Workspace's Best Bets columns
// (SPORTSBOOK_COLUMNS in BetsWorkspaceTab.tsx) — so dropdowns across
// Banking/Promos/the bet log don't dangle stale or unused books.
export const COMMON_SPORTSBOOKS = ['BetMGM', 'BetRivers', 'DraftKings', 'FanDuel', 'Caesars'];

export const RESULT_OPTIONS: { value: BetResult; label: string }[] = [
  { value: 'win', label: 'Win' },
  { value: 'loss', label: 'Loss' },
  { value: 'push', label: 'Push' },
  { value: 'void', label: 'Void' },
];

export function resultLabel(result: BetResult): string {
  return RESULT_OPTIONS.find((r) => r.value === result)?.label ?? result;
}

/** Straight American-odds payout math: a positive number (e.g. +150) is
 * "win this much per $100 staked", a negative number (e.g. -110) is "stake
 * this much to win $100". Same convention every US sportsbook displays. */
function americanOddsProfit(wager: number, odds: number): number {
  return odds > 0 ? wager * (odds / 100) : wager * (100 / Math.abs(odds));
}

/** The one place profit is computed — never stored, always derived (see
 * migration 0032's comment). `manual_profit` overrides the math entirely
 * when set, for odds boosts/free bets/promos where the actual payout
 * doesn't match a plain calculation from odds+wager. A push or void always
 * returns the stake, so profit is 0 regardless of odds — unless a manual
 * override says otherwise (e.g. a partial void). */
export function computeProfit(bet: Bet): number {
  if (bet.manual_profit != null) return bet.manual_profit;
  if (bet.result === 'win') return americanOddsProfit(bet.wager, bet.odds);
  if (bet.result === 'loss') return -bet.wager;
  return 0; // push | void
}

export function formatOdds(odds: number): string {
  return odds > 0 ? `+${odds}` : String(odds);
}

export function formatMoney(v: number): string {
  const sign = v < 0 ? '-' : '';
  return `${sign}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ---- Aggregation (breakdowns + period rollups for the Dashboard) ----

export interface BetGroupStat {
  key: string;
  count: number;
  risked: number;
  won: number;
  lost: number;
  net: number;
  wins: number;
  losses: number;
  winRate: number | null; // wins / (wins + losses) — push/void excluded from the denominator, standard convention
}

function emptyGroupStat(key: string): BetGroupStat {
  return { key, count: 0, risked: 0, won: 0, lost: 0, net: 0, wins: 0, losses: 0, winRate: null };
}

function foldBet(stat: BetGroupStat, bet: Bet, profit: number): void {
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

/** Groups an arbitrary set of bets by a key function — used for the "by
 * sport" / "by bet type" / "by sportsbook" breakdown tables. Sorted by net
 * profit descending so the best (and worst) performing groups sit at the
 * top/bottom without Mike having to hunt for them. */
export function groupBets(bets: Bet[], keyOf: (b: Bet) => string): BetGroupStat[] {
  const map = new Map<string, BetGroupStat>();
  for (const bet of bets) {
    const key = keyOf(bet);
    const stat = map.get(key) ?? emptyGroupStat(key);
    foldBet(stat, bet, computeProfit(bet));
    map.set(key, stat);
  }
  return [...map.values()].sort((a, b) => b.net - a.net);
}

export type Granularity = 'week' | 'month' | 'quarter' | 'year';

export interface AggregatedBetPeriod {
  key: string;
  label: string;
  shortLabel: string;
  start: string;
  end: string;
  bets: Bet[];
  risked: number;
  won: number;
  lost: number;
  net: number;
  wins: number;
  losses: number;
  pushes: number;
  voids: number;
  winRate: number | null;
  roi: number | null; // net / risked
  biggestWin: { bet: Bet; profit: number } | null;
  biggestLoss: { bet: Bet; profit: number } | null;
  bySport: BetGroupStat[];
  byBetType: BetGroupStat[];
  bySportsbook: BetGroupStat[];
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// Sunday-start calendar week — unlike Health's "week" granularity (which
// just passes through the source file's own pre-bucketed weeks), a bet has
// only a single date, so this is the one place an actual week boundary
// needs to be computed from scratch.
function startOfWeek(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00`);
  d.setDate(d.getDate() - d.getDay());
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function bucketInfo(dateIso: string, granularity: Granularity): { key: string; label: string; shortLabel: string } {
  const d = new Date(`${dateIso}T00:00:00`);
  const y = d.getFullYear();
  const m = d.getMonth();
  if (granularity === 'week') {
    const start = startOfWeek(dateIso);
    return { key: start, label: `Week of ${shortDate(start)}`, shortLabel: shortDate(start) };
  }
  if (granularity === 'month') {
    return { key: `${y}-${pad2(m + 1)}`, label: d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }), shortLabel: d.toLocaleDateString('en-US', { month: 'short' }) };
  }
  if (granularity === 'quarter') {
    const q = Math.floor(m / 3) + 1;
    return { key: `${y}-Q${q}`, label: `Q${q} ${y}`, shortLabel: `Q${q} '${String(y).slice(2)}` };
  }
  return { key: `${y}`, label: `${y}`, shortLabel: `${y}` };
}

function aggregateBucket(key: string, label: string, shortLabel: string, bucketBets: Bet[]): AggregatedBetPeriod {
  const sorted = [...bucketBets].sort((a, b) => (a.date < b.date ? -1 : 1));
  const dates = sorted.map((b) => b.date);
  const start = dates[0];
  const end = dates[dates.length - 1];

  let biggestWin: { bet: Bet; profit: number } | null = null;
  let biggestLoss: { bet: Bet; profit: number } | null = null;
  let risked = 0;
  let won = 0;
  let lost = 0;
  let net = 0;
  let wins = 0;
  let losses = 0;
  let pushes = 0;
  let voids = 0;

  for (const bet of sorted) {
    const profit = computeProfit(bet);
    risked += bet.wager;
    net += profit;
    if (bet.result === 'win') {
      won += profit;
      wins += 1;
      if (!biggestWin || profit > biggestWin.profit) biggestWin = { bet, profit };
    } else if (bet.result === 'loss') {
      lost += bet.wager;
      losses += 1;
      if (!biggestLoss || profit < biggestLoss.profit) biggestLoss = { bet, profit };
    } else if (bet.result === 'push') {
      pushes += 1;
    } else {
      voids += 1;
    }
  }

  return {
    key,
    label,
    shortLabel,
    start,
    end,
    bets: sorted,
    risked,
    won,
    lost,
    net,
    wins,
    losses,
    pushes,
    voids,
    winRate: wins + losses > 0 ? wins / (wins + losses) : null,
    roi: risked > 0 ? net / risked : null,
    biggestWin,
    biggestLoss,
    bySport: groupBets(sorted, (b) => b.sport),
    byBetType: groupBets(sorted, (b) => b.bet_type),
    bySportsbook: groupBets(sorted, (b) => b.sportsbook),
  };
}

/** Rolls the flat bet log up into whatever granularity is selected, oldest
 * first — same shape/conventions as healthPeriods.buildPeriods, so the
 * Dashboard's period-nav UI (Week/Month/Quarter/Year, Prev/Next, "jump to
 * latest") works identically for both life areas. */
export function buildBetPeriods(bets: Bet[], granularity: Granularity): AggregatedBetPeriod[] {
  const buckets = new Map<string, { label: string; shortLabel: string; bets: Bet[] }>();
  for (const bet of bets) {
    const info = bucketInfo(bet.date, granularity);
    const existing = buckets.get(info.key);
    if (existing) existing.bets.push(bet);
    else buckets.set(info.key, { label: info.label, shortLabel: info.shortLabel, bets: [bet] });
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, { label, shortLabel, bets: bucketBets }]) => aggregateBucket(key, label, shortLabel, bucketBets));
}

// ---- Pick accuracy (leg-aware — see worker/migrations/0038_bet_legs.sql) ----

/** Every individual "pick" across a set of bets. A straight bet counts as
 * one pick (its own sport/bet_type/result); a parlay's picks are its legs.
 * Deliberately separate from the money stats above: a parlay is one wager
 * for money purposes, win or lose as a whole, but "was I right about the
 * Mahomes prop" is a per-leg question that shouldn't be erased just
 * because another leg of the same parlay busted. */
export interface Pick {
  sport: string;
  betType: string;
  overUnder: 'over' | 'under' | null;
  result: BetResult;
}

export function picksFromBets(bets: Bet[]): Pick[] {
  const picks: Pick[] = [];
  for (const bet of bets) {
    if (isParlayType(bet.bet_type) && bet.legs.length > 0) {
      for (const leg of bet.legs) {
        picks.push({ sport: leg.sport, betType: leg.bet_type, overUnder: leg.over_under, result: leg.result });
      }
    } else {
      picks.push({ sport: bet.sport, betType: bet.bet_type, overUnder: null, result: bet.result });
    }
  }
  return picks;
}

export interface PickAccuracyStat {
  key: string;
  wins: number;
  losses: number;
  pushes: number;
  voids: number;
  winRate: number | null;
}

function emptyPickStat(key: string): PickAccuracyStat {
  return { key, wins: 0, losses: 0, pushes: 0, voids: 0, winRate: null };
}

function foldPick(stat: PickAccuracyStat, result: BetResult): void {
  if (result === 'win') stat.wins += 1;
  else if (result === 'loss') stat.losses += 1;
  else if (result === 'push') stat.pushes += 1;
  else stat.voids += 1;
  stat.winRate = stat.wins + stat.losses > 0 ? stat.wins / (stat.wins + stat.losses) : null;
}

/** Groups picks (not bets) by an arbitrary key — "am I good at NBA player
 * props" regardless of which parlays those props rode in. Sorted by win
 * rate descending, same convention as groupBets. */
export function groupPickAccuracy(picks: Pick[], keyOf: (p: Pick) => string): PickAccuracyStat[] {
  const map = new Map<string, PickAccuracyStat>();
  for (const p of picks) {
    const key = keyOf(p);
    const stat = map.get(key) ?? emptyPickStat(key);
    foldPick(stat, p.result);
    map.set(key, stat);
  }
  return [...map.values()].sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1));
}

export function pickAccuracyBySport(bets: Bet[]): PickAccuracyStat[] {
  return groupPickAccuracy(picksFromBets(bets), (p) => p.sport);
}

export function pickAccuracyByBetType(bets: Bet[]): PickAccuracyStat[] {
  return groupPickAccuracy(picksFromBets(bets), (p) => p.betType);
}

/** Over vs. under hit rate, pooled across every leg/straight-bet pick that
 * actually has a direction (a moneyline or spread pick has none). */
export function overUnderHitRate(bets: Bet[]): { over: PickAccuracyStat; under: PickAccuracyStat } {
  const over = emptyPickStat('Over');
  const under = emptyPickStat('Under');
  for (const p of picksFromBets(bets)) {
    if (p.overUnder === 'over') foldPick(over, p.result);
    else if (p.overUnder === 'under') foldPick(under, p.result);
  }
  return { over, under };
}

export interface ParlaySizeStat extends PickAccuracyStat {
  legCount: number;
}

/** Win rate broken down by number of legs — "am I actually good at 6-leg
 * parlays or am I fooling myself." Money-level (the whole parlay wins or
 * loses), unlike the per-leg pick stats above. */
export function winRateByParlaySize(bets: Bet[]): ParlaySizeStat[] {
  const map = new Map<number, ParlaySizeStat>();
  for (const bet of bets) {
    if (!isParlayType(bet.bet_type) || bet.legs.length === 0) continue;
    const legCount = bet.legs.length;
    const stat = map.get(legCount) ?? { ...emptyPickStat(`${legCount}-leg`), legCount };
    foldPick(stat, bet.result);
    map.set(legCount, stat);
  }
  return [...map.values()].sort((a, b) => a.legCount - b.legCount);
}

export function averageLegsPerParlay(bets: Bet[]): number | null {
  const parlays = bets.filter((b) => isParlayType(b.bet_type) && b.legs.length > 0);
  if (parlays.length === 0) return null;
  return parlays.reduce((sum, b) => sum + b.legs.length, 0) / parlays.length;
}

// ---- Odds-range breakdown ----

const ODDS_BUCKETS: { label: string; test: (odds: number) => boolean }[] = [
  { label: 'Heavy favorite (-200 or shorter)', test: (o) => o <= -200 },
  { label: 'Favorite (-199 to -110)', test: (o) => o < -109 && o > -200 },
  { label: 'Even money (-109 to +109)', test: (o) => o >= -109 && o <= 109 },
  { label: 'Underdog (+110 to +199)', test: (o) => o >= 110 && o <= 199 },
  { label: 'Big underdog (+200 or longer)', test: (o) => o >= 200 },
];

export function bucketOdds(odds: number): string {
  return ODDS_BUCKETS.find((b) => b.test(odds))?.label ?? 'Other';
}

/** Same shape as groupBets, but kept in favorite → underdog order rather
 * than sorted by net — the point of this table is seeing the shape across
 * the odds spectrum, not which bucket happens to be most profitable. */
export function groupByOddsRange(bets: Bet[]): BetGroupStat[] {
  const map = new Map<string, BetGroupStat>();
  for (const bucket of ODDS_BUCKETS) map.set(bucket.label, emptyGroupStat(bucket.label));
  for (const bet of bets) {
    const key = bucketOdds(bet.odds);
    const stat = map.get(key) ?? emptyGroupStat(key);
    foldBet(stat, bet, computeProfit(bet));
    map.set(key, stat);
  }
  return [...map.values()].filter((s) => s.count > 0);
}

// ---- Trends: streaks, day-of-week, favorite/dog split, equity curve ----

export interface StreakInfo {
  currentType: 'win' | 'loss' | null;
  currentLength: number;
  longestWin: number;
  longestLoss: number;
}

/** Streaks only count win/loss — a push or void breaks neither the run nor
 * extends it, since nothing actually happened to the record. Bets must
 * already be sorted oldest-first for "current" to mean anything. */
export function computeStreaks(betsOldestFirst: Bet[]): StreakInfo {
  let longestWin = 0;
  let longestLoss = 0;
  let runType: 'win' | 'loss' | null = null;
  let runLength = 0;
  for (const bet of betsOldestFirst) {
    if (bet.result !== 'win' && bet.result !== 'loss') continue;
    if (bet.result === runType) {
      runLength += 1;
    } else {
      runType = bet.result;
      runLength = 1;
    }
    if (runType === 'win') longestWin = Math.max(longestWin, runLength);
    else longestLoss = Math.max(longestLoss, runLength);
  }
  return { currentType: runType, currentLength: runLength, longestWin, longestLoss };
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function byDayOfWeek(bets: Bet[]): BetGroupStat[] {
  const stats = groupBets(bets, (b) => DAY_NAMES[new Date(`${b.date}T00:00:00`).getDay()]);
  // Sunday→Saturday order, not net-descending — day-of-week trends read
  // naturally in calendar order, unlike the sport/bet-type breakdowns.
  return DAY_NAMES.map((name) => stats.find((s) => s.key === name) ?? emptyGroupStat(name));
}

/** Favorite/underdog split derived free from the odds sign already on
 * every bet — no separate field needed. Parlays are excluded since a
 * parlay's combined odds don't mean "favorite" the way a single leg's do. */
export function favoriteUnderdogSplit(bets: Bet[]): { favorites: BetGroupStat; underdogs: BetGroupStat } {
  const straight = bets.filter((b) => !isParlayType(b.bet_type));
  const favorites = emptyGroupStat('Favorites');
  const underdogs = emptyGroupStat('Underdogs');
  for (const bet of straight) {
    const stat = bet.odds < 0 ? favorites : underdogs;
    foldBet(stat, bet, computeProfit(bet));
  }
  return { favorites, underdogs };
}

export interface EquityPoint {
  date: string;
  net: number; // that day's net
  cumulative: number; // running total through this day
}

/** Bankroll equity curve — cumulative net over time, one point per day that
 * had at least one bet settled. */
export function buildEquityCurve(bets: Bet[]): EquityPoint[] {
  const byDate = new Map<string, number>();
  for (const bet of bets) {
    byDate.set(bet.date, (byDate.get(bet.date) ?? 0) + computeProfit(bet));
  }
  let cumulative = 0;
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, net]) => {
      cumulative += net;
      return { date, net, cumulative };
    });
}

// ---- Banking (0040_bet_workspace.sql) ----
//
// A sportsbook's current balance is never stored — same "D1 is the source
// of truth" rule the rest of this file follows for bet profit. It's
// derived here, live, as that book's transactions (deposits add,
// withdrawals subtract, bonuses add, adjustments add-signed) plus that
// book's net bet profit (money already sitting in the book from wins,
// still owed from losses).

export interface SportsbookBalance {
  sportsbook: string;
  deposited: number;
  withdrawn: number;
  bonuses: number;
  adjustments: number;
  betNet: number;
  balance: number;
}

function emptyBalance(sportsbook: string): SportsbookBalance {
  return { sportsbook, deposited: 0, withdrawn: 0, bonuses: 0, adjustments: 0, betNet: 0, balance: 0 };
}

/** One row per sportsbook that has at least one transaction or bet,
 * sorted by current balance descending. */
export function sportsbookBalances(bets: Bet[], transactions: BetTransaction[]): SportsbookBalance[] {
  const byBook = new Map<string, SportsbookBalance>();
  const get = (name: string) => {
    let row = byBook.get(name);
    if (!row) {
      row = emptyBalance(name);
      byBook.set(name, row);
    }
    return row;
  };
  for (const t of transactions) {
    const row = get(t.sportsbook);
    if (t.type === 'deposit') row.deposited += t.amount;
    else if (t.type === 'withdrawal') row.withdrawn += t.amount;
    else if (t.type === 'bonus') row.bonuses += t.amount;
    else row.adjustments += t.amount;
  }
  for (const bet of bets) {
    get(bet.sportsbook).betNet += computeProfit(bet);
  }
  for (const row of byBook.values()) {
    row.balance = row.deposited - row.withdrawn + row.bonuses + row.adjustments + row.betNet;
  }
  return [...byBook.values()].sort((a, b) => b.balance - a.balance);
}

export interface BankingTotals {
  deposited: number;
  withdrawn: number;
  netDeposited: number; // deposited - withdrawn — "money put in that hasn't come back out"
  totalBalance: number; // sum of every book's current balance
}

export function bankingTotals(balances: SportsbookBalance[]): BankingTotals {
  return balances.reduce(
    (acc, b) => ({
      deposited: acc.deposited + b.deposited,
      withdrawn: acc.withdrawn + b.withdrawn,
      netDeposited: acc.netDeposited + (b.deposited - b.withdrawn),
      totalBalance: acc.totalBalance + b.balance,
    }),
    { deposited: 0, withdrawn: 0, netDeposited: 0, totalBalance: 0 }
  );
}
