import type { Bet, BetResult } from '../api/types';

// Fixed lists (like Contacts' CIRCLES) rather than free text, so the
// "performance by sport"/"performance by bet type" breakdowns stay clean
// and comparable instead of fragmenting across "Parlay" vs "3-leg parlay"
// spelling variants — this was a deliberate choice, not a default (see the
// scoping discussion this feature was built from).
export const SPORTS = ['NFL', 'NBA', 'MLB', 'NHL', 'NCAAF', 'NCAAB', 'Soccer', 'Tennis', 'Golf', 'MMA/Boxing', 'Other'];

export const BET_TYPES = ['Moneyline', 'Spread', 'Total (Over/Under)', 'Parlay', 'Prop', 'Teaser', 'Futures', 'Other'];

// Sportsbook stays free text (unlike sport/bet type) since the set of books
// Mike actually uses is small and stable in practice, but a hard-coded list
// would go stale the moment a new book runs a promo worth using — this is
// just a convenience suggestion list for the entry form's <datalist>.
export const COMMON_SPORTSBOOKS = ['DraftKings', 'FanDuel', 'BetMGM', 'Caesars', 'ESPN Bet', 'Fanatics', 'Bet365', 'BetRivers'];

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
