import type { Bet, BetLeg, BetLegMarket, BetLinkKind, BetOption, BetOptionCategory, BetResult, BetTransaction } from '../api/types';

// Fixed lists (like Contacts' CIRCLES) rather than free text, so the
// "performance by sport"/"performance by bet type" breakdowns stay clean
// and comparable instead of fragmenting across "Parlay" vs "3-leg parlay"
// spelling variants — this was a deliberate choice, not a default (see the
// scoping discussion this feature was built from).
export const SPORTS = ['NFL', 'NBA', 'MLB', 'NHL', 'NCAAF', 'NCAAB', 'Soccer', 'Tennis', 'Golf', 'MMA/Boxing', 'Other'];

// A parlay's bet-level sport is never picked by hand — it comes from its
// legs: one sport across every leg → that sport; more than one →
// MULTI_SPORT. Deliberately NOT in SPORTS, so it never shows up as a leg's
// sport or in promo/workspace pickers. The worker derives the same value on
// save (deriveParlaySport in worker/src/index.ts) — keep the two in sync.
export const MULTI_SPORT = 'Multi-Sport';

export function parlaySport(legSports: string[]): string | null {
  const distinct = [...new Set(legSports.map((s) => s.trim()).filter(Boolean))];
  if (distinct.length === 0) return null;
  return distinct.length === 1 ? distinct[0] : MULTI_SPORT;
}

// Defaults seeded by worker/migrations/0084_bet_options_tipper_line.sql —
// Bet Type, Tipper, Line, and Result are all Settings-editable now (see
// the Settings tab in BetsPage.tsx and the bet_options table), so these
// arrays are only the starting point / fallback before that list has
// loaded, not the live source of truth. optionLabels()/optionValues()
// below read the fetched list; components should prefer those.
export const BET_TYPES = ['Straight', 'Parlay', 'SGP', 'SGPx', 'Future', 'Prop', 'Teaser'];

// Only these three ever carry legs (see worker/migrations/0038_bet_legs.sql)
// — a straight bet keeps using the single odds/line fields on the bet
// itself. Hardcoded rather than Settings-driven on purpose: whether a bet
// type carries legs is business logic, not a display choice.
export const PARLAY_BET_TYPES = ['Parlay', 'SGP', 'SGPx'];

export function isParlayType(betType: string): boolean {
  return PARLAY_BET_TYPES.includes(betType);
}

// ---- Bet slip (2026-10-15 redesign) ----
// Types that hold several legs; every other type holds one (the slip's
// single pick card). Mirrors MULTI_LEG_BET_TYPES in worker/src/index.ts.
export const MULTI_LEG_BET_TYPES = [...PARLAY_BET_TYPES, 'Teaser'];
export function isMultiLegType(betType: string): boolean {
  return MULTI_LEG_BET_TYPES.includes(betType);
}

export const LEG_MARKETS: BetLegMarket[] = ['ML', 'Spread', 'Total', 'Prop'];
export const MARKET_LABELS: Record<BetLegMarket, string> = { ML: 'Moneyline', Spread: 'Spread', Total: 'Total', Prop: 'Prop' };

/** −110 → 1.909, +150 → 2.5. Null for 0 / non-numbers. */
export function americanToDecimal(odds: number | null | undefined): number | null {
  if (odds == null || !Number.isFinite(odds) || odds === 0) return null;
  return odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds);
}

export function decimalToAmerican(dec: number): number {
  return dec >= 2 ? Math.round((dec - 1) * 100) : -Math.round(100 / (dec - 1));
}

/** A parlay's price from its legs' prices — null if any leg has no odds.
 * Pushed / voided legs drop out, the way books reprice a parlay. */
export function combinedOdds(legs: { odds: number | null; result?: string }[]): number | null {
  const live = legs.filter((l) => l.result !== 'push' && l.result !== 'void');
  if (live.length === 0) return null;
  let dec = 1;
  for (const l of live) {
    const d = americanToDecimal(l.odds);
    if (d == null) return null;
    dec *= d;
  }
  return decimalToAmerican(dec);
}

/** "+2.5" / "−2.5" / "O 47.5" / "U 275.5" / "" (moneyline). */
type LegLike = { sport: string; market: BetLeg['market']; pick: string | null; line: number | null; over_under: BetLeg['over_under']; odds: number | null };

export function formatLegLine(leg: Omit<LegLike, 'sport' | 'pick' | 'odds'>): string {
  if (leg.line == null) return leg.market === 'ML' ? 'ML' : '';
  if (leg.market === 'Total' || leg.market === 'Prop' || leg.over_under) {
    return `${leg.over_under === 'under' ? 'U' : 'O'} ${leg.line}`;
  }
  return leg.line > 0 ? `+${leg.line}` : leg.line < 0 ? `−${Math.abs(leg.line)}` : 'PK';
}

/** One line per leg, e.g. "Texans +2.5 (−105)", "KC @ BUF O 47.5 (−110)",
 * "Bears ML (+140)". */
export function legSummary(leg: LegLike): string {
  const line = formatLegLine(leg);
  const odds = leg.odds != null ? ` (${leg.odds > 0 ? '+' : '−'}${Math.abs(leg.odds)})` : '';
  return `${leg.pick || leg.sport}${line ? ` ${line}` : ''}${odds}`;
}

export type LegMark = null | 'loss' | 'push' | 'void';

/** Leg results that go with a bet result. Won: every leg a hit unless
 * marked push/void. Lost: only once Mike has tapped the leg(s) that
 * missed — the rest are hits; with nothing tapped every leg stays pending
 * (the bet is settled, the legs just aren't graded). Anything else (TBD,
 * push, void, cashed out): marked legs keep their mark, others pending. */
export function legResultsFor(betResult: string, marks: LegMark[]): string[] {
  if (betResult === 'win') return marks.map((m) => (m === 'push' || m === 'void' ? m : 'win'));
  if (betResult === 'loss') {
    const anyLoss = marks.some((m) => m === 'loss');
    return marks.map((m) => m ?? (anyLoss ? 'win' : 'pending'));
  }
  return marks.map((m) => m ?? 'pending');
}

export function markFromLegResult(result: string | null | undefined): LegMark {
  return result === 'loss' || result === 'push' || result === 'void' ? result : null;
}

// A leg reuses the bet-type vocabulary minus the parlay types themselves
// (a leg can't contain another parlay) — pass the live fetched bet_type
// options through this instead of the BET_TYPES default once they've
// loaded.
export function legBetTypes(betTypes: string[] = BET_TYPES): string[] {
  return betTypes.filter((t) => !PARLAY_BET_TYPES.includes(t));
}
export const LEG_BET_TYPES = legBetTypes();

// Sportsbook stays free text (unlike sport/bet type) so a one-off entry
// never gets blocked, but the suggestion list itself is exactly the five
// books Mike actually uses — same set as Workspace's Best Bets columns
// (SPORTSBOOK_COLUMNS in BetsWorkspaceTab.tsx) — so dropdowns across
// Banking/Promos/the bet log don't dangle stale or unused books.
export const COMMON_SPORTSBOOKS = ['BetMGM', 'BetRivers', 'DraftKings', 'FanDuel', 'Caesars'];

/** Badge for a sportsbook in the promos table — a short monogram on the
 * book's own color so rows are identifiable at a glance. Unknown books
 * get initials on a neutral color. */
const SPORTSBOOK_BRANDS: Record<string, { mono: string; color: string }> = {
  fanduel: { mono: 'FD', color: '#1475E1' },
  draftkings: { mono: 'DK', color: '#1E7B3A' },
  betmgm: { mono: 'MGM', color: '#7A6331' },
  betrivers: { mono: 'BR', color: '#1B3D6E' },
  caesars: { mono: 'CZR', color: '#0F4F47' },
  fanatics: { mono: 'FAN', color: '#B3261E' },
  espnbet: { mono: 'ESPN', color: '#C8102E' },
};

export function sportsbookBrand(name: string): { mono: string; color: string } {
  const key = name.toLowerCase().replace(/[^a-z]/g, '');
  const known = SPORTSBOOK_BRANDS[key];
  if (known) return known;
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase())
    .join('')
    .slice(0, 3);
  return { mono: initials || '?', color: '#5F564A' };
}

// Leg-level results are NOT Settings-editable (see LEG_RESULTS in
// worker/src/index.ts) — "Cashed Out"/"TBD" only make sense for a whole
// bet, not one leg of a parlay, and bet_legs.result has a DB CHECK
// constraint pinned to exactly these four.
export const LEG_RESULT_OPTIONS: { value: BetResult; label: string }[] = [
  { value: 'win', label: 'Win' },
  { value: 'loss', label: 'Loss' },
  { value: 'push', label: 'Push' },
  { value: 'void', label: 'Void' },
];

// Top-level bet results ARE Settings-editable — these are just the seeded
// defaults (see 0084_bet_options_tipper_line.sql). 'cashed_out'/'tbd' were
// added for exactly the two new cases Mike asked for; computeProfit below
// already treats anything that isn't exactly 'win'/'loss' as a neutral
// push/void-like 0 (so a cashed-out bet needs its actual payout entered
// via the manual profit override — there's no formula for "how much did
// cashing out early actually pay").
export const RESULT_OPTIONS: { value: BetResult; label: string }[] = [
  { value: 'win', label: 'Win' },
  { value: 'loss', label: 'Loss' },
  { value: 'push', label: 'Push' },
  { value: 'void', label: 'Void' },
  { value: 'cashed_out', label: 'Cashed Out' },
  { value: 'tbd', label: 'TBD' },
];

export function resultLabel(result: BetResult): string {
  return RESULT_OPTIONS.find((r) => r.value === result)?.label ?? result;
}

// ---- Bets Settings: live option lists (0084_bet_options_tipper_line.sql) ----

/** Values for one category, in display order, from the live fetched
 * options list — this is what selects should render once options have
 * loaded, instead of the hardcoded defaults above. */
export function optionValues(options: BetOption[], category: BetOptionCategory): string[] {
  return options.filter((o) => o.category === category).map((o) => o.value);
}

export function optionLabel(options: BetOption[], category: BetOptionCategory, value: string): string {
  return options.find((o) => o.category === category && o.value === value)?.label ?? value;
}

/** A select's current value might be an old/removed option (an old bet's
 * bet_type/result/line that predates a Settings edit, or a legacy value
 * from before this field existed) — inject it as an extra choice so
 * editing that bet doesn't silently change what's selected. */
export function withCurrentValue(values: string[], current: string | null | undefined): string[] {
  if (!current || values.includes(current)) return values;
  return [current, ...values];
}

/** Straight American-odds payout math: a positive number (e.g. +150) is
 * "win this much per $100 staked", a negative number (e.g. -110) is "stake
 * this much to win $100". Same convention every US sportsbook displays. */
function americanOddsProfit(wager: number, odds: number): number {
  return odds > 0 ? wager * (odds / 100) : wager * (100 / Math.abs(odds));
}

/** The one place profit is computed — never stored, always derived (see
 * migration 0032's comment). `manual_profit` overrides the math entirely
 * when set, for odds boosts/promos where the actual payout doesn't match a
 * plain calculation from odds+wager. A push or void always returns the
 * stake, so profit is 0 regardless of odds — unless a manual override says
 * otherwise (e.g. a partial void).
 *
 * stake_type ('cash' vs 'free_bet', see 0080_bet_stake_type.sql) only
 * changes the LOSS branch: a free bet's stake was the sportsbook's credit,
 * not Mike's own money, so losing one costs nothing real — 0, not -wager.
 * A won free bet needs no special-casing at all: americanOddsProfit
 * already returns stake-exclusive winnings (never stake+winnings), which
 * is exactly how a free bet actually pays out (stake not returned). */
/** A bet that hasn't been graded yet (Pending in the slip). A manual
 * profit means Mike already typed the outcome, so it counts as settled. */
export function isUnsettled(bet: Bet): boolean {
  return bet.result === 'tbd' && bet.manual_profit == null;
}

export function computeProfit(bet: Bet): number {
  if (bet.manual_profit != null) return bet.manual_profit;
  if (bet.result === 'win') return americanOddsProfit(bet.wager, bet.odds);
  if (bet.result === 'loss') return bet.stake_type === 'free_bet' ? 0 : -bet.wager;
  return 0; // push | void
}

// Shared by the bet log form and the Settings balances panel — a plain
// local-timezone YYYY-MM-DD, not `new Date().toISOString()`'s UTC date
// (which drifts a day off after ~8pm Eastern).
export function todayLocalISODash(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// "I'll most likely come in and log a bet after the day it's placed... so
// the default date on the betslip should be yesterday" — Mike's own
// reasoning. Used only as the NEW-bet default in BetFormModal; editing an
// existing bet always keeps that bet's own date.
export function yesterdayLocalISODash(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function formatOdds(odds: number): string {
  return odds > 0 ? `+${odds}` : String(odds);
}

/** Promo expirations read far better as "Today"/"Tomorrow"/"4D" than a raw
 * YYYY-MM-DD — most of Mike's promos expire same-day, so the common case
 * should be instantly scannable rather than requiring date math every
 * time he glances at the list. Computed as a whole-day difference so DST
 * and time-of-day never shift which bucket a date lands in. */
export function formatExpiryLabel(expiresAt: string, today: string = todayLocalISODash()): string {
  const [ey, em, ed] = expiresAt.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  const diffDays = Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(ty, tm - 1, td)) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays === -1) return 'Yesterday';
  if (diffDays > 1) return `${diffDays} Days`;
  return `${Math.abs(diffDays)} Days Ago`;
}

export function formatMoney(v: number): string {
  const sign = v < 0 ? '-' : '';
  return `${sign}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ---- Arb / Hedge links (worker/migrations/0143_bet_links.sql) ----
//
// An arb is one side on each of two books for the same game, placed to
// lock a profit (usually off promos); a hedge is a later bet against an
// open one. Every side stays its own bet (it moves money on its own book),
// but the sides of a group aren't picks: an arb is a win + a loss by
// construction, so counting them would drag the win rate toward 50% and
// say nothing about Mike's handicapping. Rule: linked bets always count
// toward MONEY (net, risked, ROI, bankroll, balances); only unlinked bets
// and a hedge's original pick count toward the RECORD (W-L, win rate, pick
// accuracy, streaks, parlay-size win rate).

export function countsAsPick(bet: Bet): boolean {
  return !bet.link_id || bet.link_role === 'original';
}

/** One-line name for a bet — the Log's row title. */
export function betTitle(bet: Bet): string {
  const multi = isMultiLegType(bet.bet_type) && bet.legs.length > 0;
  if (multi) return `${bet.legs.length}-Leg ${bet.bet_type}`;
  return bet.legs[0] ? legSummary(bet.legs[0]) : bet.pick || `${bet.sport} ${bet.bet_type}`;
}

export const LINK_KIND_LABELS: Record<BetLinkKind, string> = { arb: 'Arb', hedge: 'Hedge' };

/** Dashboard slicer: everything, just Mike's own picks, or just the linked groups. */
export type BetView = 'all' | 'picks' | 'linked';

export function filterBetView(bets: Bet[], view: BetView): Bet[] {
  if (view === 'picks') return bets.filter(countsAsPick);
  if (view === 'linked') return bets.filter((b) => !!b.link_id);
  return bets;
}

/** What a bet would pay if it won — its manual profit if Mike typed one
 * (a boost), else the odds math. Stake-exclusive, like computeProfit. */
export function profitIfWin(bet: Bet): number {
  if (bet.manual_profit != null && bet.result === 'win') return bet.manual_profit;
  return americanOddsProfit(bet.wager, bet.odds);
}

/** What a bet costs if it loses — nothing for a free bet. */
export function profitIfLoss(bet: Bet): number {
  return bet.stake_type === 'free_bet' ? 0 : -bet.wager;
}

export interface LinkScenario {
  winner: Bet;
  net: number;
}

/** One outcome per side: that side wins, every other side loses — the
 * shape of a two-way arb or hedge. The worst of these is the locked-in
 * profit (or the most it can lose). */
export function linkScenarios(bets: Bet[]): LinkScenario[] {
  return bets.map((winner) => ({
    winner,
    net: bets.reduce((sum, b) => sum + (b === winner ? profitIfWin(b) : profitIfLoss(b)), 0),
  }));
}

export interface LinkGroup {
  id: string;
  kind: BetLinkKind;
  bets: Bet[]; // oldest first
  date: string; // latest member's date — where the group sits in the log
  books: string[];
  cashStaked: number;
  freeBetStaked: number;
  settled: boolean;
  net: number; // actual, once settled (sum of computeProfit)
  worst: number; // worst scenario — the locked profit when ≥ 0
  best: number;
}

export function summarizeLinkGroup(id: string, bets: Bet[]): LinkGroup {
  const sorted = [...bets].sort((a, b) => (a.date === b.date ? (a.created_at < b.created_at ? -1 : 1) : a.date < b.date ? -1 : 1));
  const scenarios = linkScenarios(sorted);
  const nets = scenarios.map((s) => s.net);
  return {
    id,
    kind: (sorted.find((b) => b.link_kind)?.link_kind ?? 'arb') as BetLinkKind,
    bets: sorted,
    date: sorted[sorted.length - 1].date,
    books: [...new Set(sorted.map((b) => b.sportsbook))],
    cashStaked: sorted.filter((b) => b.stake_type !== 'free_bet').reduce((s, b) => s + b.wager, 0),
    freeBetStaked: sorted.filter((b) => b.stake_type === 'free_bet').reduce((s, b) => s + b.wager, 0),
    settled: sorted.every((b) => !isUnsettled(b)),
    net: sorted.reduce((s, b) => s + computeProfit(b), 0),
    worst: nets.length ? Math.min(...nets) : 0,
    best: nets.length ? Math.max(...nets) : 0,
  };
}

/** Every linked group in a bet list, newest first. */
export function buildLinkGroups(bets: Bet[]): LinkGroup[] {
  const byId = new Map<string, Bet[]>();
  for (const b of bets) {
    if (!b.link_id) continue;
    const list = byId.get(b.link_id) ?? [];
    list.push(b);
    byId.set(b.link_id, list);
  }
  return [...byId.entries()].map(([id, list]) => summarizeLinkGroup(id, list)).sort((a, b) => (a.date < b.date ? 1 : -1));
}

export interface LinkTotals {
  groups: number;
  settled: number;
  net: number; // settled groups only
  avgNet: number | null;
  cashStaked: number;
  roi: number | null; // net / cash staked
  freeBetStaked: number;
  freeBetNet: number;
  conversion: number | null; // net from groups that used a free bet ÷ free-bet stake
  pendingLocked: number; // worst-case profit already locked in on unsettled groups
}

export function linkTotals(groups: LinkGroup[]): LinkTotals {
  const settled = groups.filter((g) => g.settled);
  const net = settled.reduce((s, g) => s + g.net, 0);
  const cashStaked = settled.reduce((s, g) => s + g.cashStaked, 0);
  const promo = settled.filter((g) => g.freeBetStaked > 0);
  const freeBetStaked = promo.reduce((s, g) => s + g.freeBetStaked, 0);
  const freeBetNet = promo.reduce((s, g) => s + g.net, 0);
  return {
    groups: groups.length,
    settled: settled.length,
    net,
    avgNet: settled.length ? net / settled.length : null,
    cashStaked,
    roi: cashStaked > 0 ? net / cashStaked : null,
    freeBetStaked,
    freeBetNet,
    conversion: freeBetStaked > 0 ? freeBetNet / freeBetStaked : null,
    pendingLocked: groups.filter((g) => !g.settled).reduce((s, g) => s + g.worst, 0),
  };
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
  const pick = countsAsPick(bet);
  if (bet.result === 'win') {
    stat.won += profit;
    if (pick) stat.wins += 1;
  } else if (bet.result === 'loss') {
    stat.lost += bet.wager;
    if (pick) stat.losses += 1;
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
    if (!countsAsPick(bet)) {
      // Arb sides / hedge bets: money only — see countsAsPick.
      if (bet.result === 'win') won += profit;
      else if (bet.result === 'loss') lost += bet.wager;
      continue;
    }
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
    } else if (bet.result === 'void') {
      voids += 1;
    }
    // 'cashed_out' / 'tbd' / any other custom result (Settings-editable,
    // see 0084_bet_options_tipper_line.sql) counts toward net/risked above
    // but isn't tallied into wins/losses/pushes/voids here — same
    // treatment as computeStreaks, which skips anything non-win/non-loss.
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
    if (!countsAsPick(bet)) continue;
    if (isMultiLegType(bet.bet_type) && bet.legs.length > 0) {
      for (const leg of bet.legs) {
        if (leg.result === 'pending') continue; // not graded yet
        picks.push({ sport: leg.sport, betType: leg.market ?? leg.bet_type ?? 'Other', overUnder: leg.over_under, result: leg.result });
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
  else if (result === 'void') stat.voids += 1;
  // Leg-level results are never 'cashed_out'/'tbd' (not Settings-editable
  // — see LEG_RESULT_OPTIONS), so this is just future-proofing.
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
    if (!isParlayType(bet.bet_type) || bet.legs.length === 0 || !countsAsPick(bet)) continue;
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

/** "How certain tippers I've been listening to have been performing" —
 * Mike's own words for why the Tipper field exists. Only bets with a
 * tipper set are included (most of the log predates this field and has
 * none). Same shape/sort as the other money breakdowns. */
export function groupByTipper(bets: Bet[]): BetGroupStat[] {
  return groupBets(bets.filter((b) => b.tipper), (b) => b.tipper as string);
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
    if (!countsAsPick(bet)) continue;
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
// still owed from losses), minus the cash stake of every bet that hasn't
// settled yet (result 'tbd') — the book takes the stake the moment the bet
// is placed, so a pending $15 bet shows $15 less right away. Settling it
// swaps that hold for the bet's profit (win: +stake +winnings back, loss:
// stays gone, push/void: stake back). Free-bet stakes are the book's credit,
// so a pending free bet holds nothing.

export interface SportsbookBalance {
  sportsbook: string;
  deposited: number;
  withdrawn: number;
  bonuses: number;
  adjustments: number;
  betNet: number;
  pending: number; // cash stakes on bets not settled yet (held by the book)
  balance: number;
}

function emptyBalance(sportsbook: string): SportsbookBalance {
  return { sportsbook, deposited: 0, withdrawn: 0, bonuses: 0, adjustments: 0, betNet: 0, pending: 0, balance: 0 };
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
    const row = get(bet.sportsbook);
    if (isUnsettled(bet)) {
      if (bet.stake_type !== 'free_bet') row.pending += bet.wager;
    } else row.betNet += computeProfit(bet);
  }
  for (const row of byBook.values()) {
    row.balance = row.deposited - row.withdrawn + row.bonuses + row.adjustments + row.betNet - row.pending;
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
