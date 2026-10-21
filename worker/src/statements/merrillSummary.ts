import { round2 } from './common';
import type { StatementCheck } from './common';
import type { MlAccount, MlAccountType, MlHolding, MlValues } from './templates/merrill';
import { monthlyReturns } from './market';
import type { MarketMonth } from './market';

/** Finance → Merrill Lynch: everything on the dashboard is computed here on
 * read from the stored statements (no AI) —
 *  - performance: monthly Modified Dietz returns per account (net of the
 *    advisory fee, and gross with it added back), chained into YTD / 1 / 3 /
 *    5-year / since-start time-weighted returns, next to two benchmarks: the
 *    S&P 500 (SPY) and a BLENDED index mix with the account's own stock /
 *    bond / cash split that month (US stocks VTI, international VXUS, bonds
 *    AGG, cash BIL) — "what the same mix would have done in index funds";
 *    plus the dollars gained or lost vs that mix with the same deposits;
 *  - fees: monthly advisory fees, trailing-12-month rate, by year;
 *  - allocation: stock / bond / cash (US vs international) per account and
 *    household, holdings merged across accounts;
 *  - taxes (taxable accounts — CMA, UTMA): realized short / long-term gains
 *    by year, losses harvested, open lots with losses (harvest candidates),
 *    possible wash sales (a loss sale with a buy of the same security within
 *    30 days in ANY account — an IRA buy makes the loss permanent);
 *  - insights (rules with thresholds below) → the CFA question list. */

export interface MlStmtRow {
  id: string;
  fileId: string;
  periodEnd: string; // stored key ("2026-09-30" or "2025-03-31:chase")
  date: string; // YYYY-MM-DD
  values: MlValues;
  checks: StatementCheck[];
}
export interface MlTxnRow {
  date: string;
  description: string;
  kind: string;
  amount: number;
  units: number | null;
  account: string | null;
}

export interface MlContext {
  today: string;
  market: MarketMonth[];
  birthDate: string | null;
  /** Latest filed return's AGI (Finance → Taxes), for the Roth / backdoor rule. */
  agi: { year: number; agi: number } | null;
  /** The plan's retirement age (Settings on the dashboard) — for the glide-path reference. */
  retireAge: number;
}

// ---- thresholds (rules) ----
/** A month's return is only computed when the account held at least this much. */
const MIN_BASE = 1000;
/** Excess return (per year) that counts as clearly ahead / behind the blended mix. */
const EXCESS_BAND = 0.5;
/** Trailing-12-month advisory fee rate considered high (% / year). */
const FEE_HIGH = 1.0;
/** Reference costs for the "what the fee costs over time" math (% / year). */
const ROBO_RATE = 0.25;
const INDEX_RATE = 0.05;
/** Cash above this share of an advisory account is called out. */
const CASH_DRAG = 0.05;
/** One stock above this share of the household is concentration. */
const STOCK_CONC = 0.05;
/** Asset location: taxable bond share this far above the IRA's. */
const LOCATION_GAP = 0.05;
/** Harvest candidates: lots (or funds) down at least this much. */
const HARVEST_MIN = 100;
/** Kiddie tax (2026): the first $1,350 of a child's unearned income is tax-free, the next $1,350 at the child's rate, above $2,700 at the parent's. */
export const KIDDIE_FREE = 1350;
export const KIDDIE_PARENT = 2700;
/** Roth IRA direct-contribution phase-out, married filing jointly (2026). */
const ROTH_MFJ_PHASEOUT_START = 242000;

export const TYPE_LABEL: Record<MlAccountType, string> = { ira: 'Rollover IRA', roth: 'Roth IRA', cma: 'CMA (Taxable)', utma: 'Chase UTMA' };

export interface Returns {
  ytd: number | null;
  y1: number | null;
  y3: number | null;
  y5: number | null;
  since: number | null;
  /** Annualized since start; `sinceMonths` = months chained. */
  sinceMonths: number;
  sinceStart: string | null;
}

export interface SeriesPoint {
  date: string;
  month: string;
  value: number;
  netFlow: number;
  fees: number;
  income: number;
  market: number;
  rNet: number | null;
  rGross: number | null;
  rSpy: number | null;
  rBlend: number | null;
  /** Start-of-month mix used for the blend. */
  mix: { us: number; intl: number; fixed: number; cash: number; other: number } | null;
}

export interface Allocation {
  equity: number;
  us: number;
  intl: number;
  fixed: number;
  cash: number;
  other: number;
}

export interface AccountSummary {
  number: string;
  last4: string;
  type: MlAccountType;
  label: string;
  owner: 'household' | 'chase';
  value: number;
  asOf: string;
  firstDate: string;
  strategy: string | null;
  sleeves: MlAccount['sleeves'];
  objective: string | null;
  allocation: Allocation;
  costBasis: number | null;
  unrealized: number | null;
  estIncome: number | null;
  holdings: MlHolding[];
  fees: FeeSummary;
  income: { ytd: number; last12: number; allTime: number; byYear: { year: number; total: number }[] };
  flows: { allTimeIn: number; allTimeOut: number; byYear: { year: number; in: number; out: number }[] };
  returns: { net: Returns; gross: Returns; spy: Returns; blend: Returns };
  valueAdded: { vsBlend: WindowDollars; vsSpy: WindowDollars };
  series: SeriesPoint[];
  realizedYtd: { st: number; lt: number } | null;
  unrealizedSplit: { st: number; lt: number } | null;
  rollovers: { year: number; amount: number }[];
  tradesPerYear: { year: number; trades: number }[];
}

export interface WindowDollars {
  y1: number | null;
  y3: number | null;
  since: number | null;
}

export interface FeeSummary {
  last: number;
  ytd: number;
  trailing12: number;
  /** Trailing-12 fees ÷ average month-end value, % per year. */
  rate12: number | null;
  allTime: number;
  byYear: { year: number; fees: number; avgValue: number; rate: number | null; months: number }[];
}

export interface Insight {
  key: string;
  severity: 'good' | 'info' | 'warn';
  area: 'performance' | 'fees' | 'allocation' | 'taxes' | 'chase' | 'retirement' | 'data';
  title: string;
  detail: string;
  /** Turned into the CFA question list. */
  question?: string;
}

export interface MerrillSummary {
  asOf: string | null;
  household: AccountSummary | null;
  accounts: AccountSummary[];
  chase: AccountSummary | null;
  total: number;
  holdings: MergedHolding[];
  taxes: TaxSummary;
  insights: Insight[];
  questions: { area: Insight['area']; text: string }[];
  benchmark: { months: number; first: string | null; last: string | null; symbols: string[] };
  retirement: {
    age: number | null;
    birthDate: string | null;
    preTax: number;
    roth: number;
    taxable: number;
    feeRate: number | null;
    historicalNet: number | null;
    historicalBlend: number | null;
  };
  statements: { id: string; date: string; kind: 'household' | 'chase'; total: number | null; partial: boolean; fileId: string; checks: StatementCheck[]; accounts: { last4: string; type: MlAccountType; value: number }[] }[];
}

export interface MergedHolding {
  key: string;
  name: string;
  symbol: string | null;
  section: MlHolding['section'];
  value: number;
  pct: number;
  gain: number | null;
  income: number | null;
  intl: boolean;
  classes: MlHolding['classes'];
  accounts: { last4: string; type: MlAccountType; value: number }[];
}

export interface HarvestLot {
  account: string;
  type: MlAccountType;
  symbol: string;
  name: string;
  acquired: string | null;
  qty: number | null;
  cost: number;
  value: number;
  loss: number;
  term: 'short' | 'long' | null;
  fund: boolean;
}

export interface WashSale {
  account: string;
  type: MlAccountType;
  name: string;
  sold: string;
  loss: number | null;
  merrillFlagged: boolean;
  buys: { date: string; account: string; type: MlAccountType; qty: number | null; amount: number }[];
  permanent: boolean;
}

export interface TaxSummary {
  accounts: string[];
  years: { year: number; st: number; lt: number; lossesHarvested: number; lossSales: number; washMarked: number; taxableIncome: number; exemptIncome: number; partial: boolean }[];
  ytd: { st: number; lt: number; income: number; harvested: number } | null;
  harvest: { lots: HarvestLot[]; total: number; st: number; lt: number };
  washSales: WashSale[];
  unrealizedGain: number;
}

// ---- helpers ----

const ym = (iso: string) => iso.slice(0, 7);
const yearOf = (iso: string) => Number(iso.slice(0, 4));
const addDays = (iso: string, d: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
const fmt = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const pct1 = (n: number) => `${n.toFixed(1)}%`;
const longDate = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

const INTL_RE = /EAFE|EMERG|DEVELOPED|INTL|INTERNATIONAL|WORLD|EUROPE|PACIFIC|JAPAN|CHINA|EX[- ]US|FOREIGN|GLOBAL|ADR\b|MKTS/i;
const INTL_SYMBOLS = new Set(['IEFA', 'IEMG', 'VEA', 'VWO', 'VXUS', 'EFA', 'EEM', 'ACWX', 'IXUS', 'SCHF', 'SCHE', 'VEU', 'VSS', 'EFG', 'EFV']);
const isIntl = (h: MlHolding) => (h.symbol ? INTL_SYMBOLS.has(h.symbol) : false) || INTL_RE.test(h.name);

export function allocationOf(holdings: MlHolding[]): Allocation {
  const total = holdings.reduce((s, h) => s + h.value, 0);
  const a: Allocation = { equity: 0, us: 0, intl: 0, fixed: 0, cash: 0, other: 0 };
  if (total <= 0) return a;
  for (const h of holdings) {
    const w = h.value / total;
    const eq = h.classes.equity * w;
    a.equity += eq;
    if (isIntl(h)) a.intl += eq;
    else a.us += eq;
    a.fixed += h.classes.fixed * w;
    a.cash += h.classes.cash * w;
    a.other += h.classes.other * w;
  }
  return a;
}

/** External money: deposits / transfers / checks / securities moved in or out.
 * Dividends, fees, rebates and cash-in-lieu stay inside the return. */
export function externalFlow(a: MlAccount): number {
  const f = a.flows;
  return round2(f.fundsReceived + f.electronicIn + f.electronicOut + f.checks + f.cardAndAtm + a.transfers);
}

function chain(rs: (number | null)[]): number | null {
  if (!rs.length || rs.some((r) => r === null)) return null;
  return rs.reduce<number>((p, r) => p * (1 + (r as number)), 1) - 1;
}
const annualize = (cum: number | null, months: number) => (cum === null ? null : months >= 12 ? Math.pow(1 + cum, 12 / months) - 1 : cum);

function windows(series: SeriesPoint[], pick: (p: SeriesPoint) => number | null, today: string): Returns {
  const pts = series.filter((p) => p.rNet !== null); // months the account had money in
  const last = pts[pts.length - 1];
  const out: Returns = { ytd: null, y1: null, y3: null, y5: null, since: null, sinceMonths: 0, sinceStart: null };
  if (!last) return out;
  const yr = last.month.slice(0, 4);
  const ytd = pts.filter((p) => p.month.startsWith(yr));
  out.ytd = chain(ytd.map(pick));
  const lastN = (n: number) => {
    const cut = pts.slice(-n);
    // need n months, consecutive ending at the latest
    if (cut.length < n) return null;
    const first = cut[0].month;
    const expected = monthsBetween(first, last.month) + 1;
    if (expected !== n) return null;
    return chain(cut.map(pick));
  };
  out.y1 = lastN(12);
  out.y3 = annualize(lastN(36), 36);
  out.y5 = annualize(lastN(60), 60);
  const all = chain(pts.map(pick));
  out.since = annualize(all, pts.length);
  out.sinceMonths = pts.length;
  out.sinceStart = pts[0].month;
  void today;
  return out;
}

function monthsBetween(a: string, b: string): number {
  return (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));
}

/** Dollars ahead (+) or behind (−) a benchmark with the same deposits, over the last n months (null = since start). */
function dollarsVs(series: SeriesPoint[], pick: (p: SeriesPoint) => number | null, n: number | null): number | null {
  const pts = series.filter((p) => p.rNet !== null);
  if (!pts.length) return null;
  const use = n === null ? pts : pts.slice(-n);
  if (n !== null && (use.length < n || monthsBetween(use[0].month, pts[pts.length - 1].month) + 1 !== n)) return null;
  // Start where the account stood before the window's first month.
  const startIdx = series.indexOf(use[0]);
  const prev = startIdx > 0 ? series[startIdx - 1] : null;
  let b = prev ? prev.value : use[0].value - use[0].netFlow - use[0].market - use[0].income - use[0].fees;
  let v = b;
  for (const p of use) {
    const rb = pick(p);
    if (rb === null || p.rNet === null) return null;
    b = b * (1 + rb) + p.netFlow * (1 + rb / 2);
    v = p.value;
  }
  return round2(v - b);
}

function feeSummary(series: SeriesPoint[], today: string): FeeSummary {
  const yr = today.slice(0, 4);
  const last = series[series.length - 1];
  const last12 = series.slice(-12);
  const t12 = round2(last12.reduce((s, p) => s + p.fees, 0));
  const avg12 = last12.length ? last12.reduce((s, p) => s + p.value, 0) / last12.length : 0;
  const byYearMap = new Map<number, { fees: number; vals: number[] }>();
  for (const p of series) {
    const y = yearOf(p.date);
    const e = byYearMap.get(y) ?? { fees: 0, vals: [] };
    e.fees += p.fees;
    e.vals.push(p.value);
    byYearMap.set(y, e);
  }
  const byYear = [...byYearMap].map(([year, e]) => {
    const avg = e.vals.reduce((s, v) => s + v, 0) / (e.vals.length || 1);
    return { year, fees: round2(e.fees), avgValue: round2(avg), rate: avg > MIN_BASE ? round2(((e.fees / e.vals.length) * 12 * 100) / avg) / 1 : null, months: e.vals.length };
  });
  return {
    last: last ? round2(last.fees) : 0,
    ytd: round2(series.filter((p) => p.date.startsWith(yr)).reduce((s, p) => s + p.fees, 0)),
    trailing12: t12,
    rate12: last12.length >= 6 && avg12 > MIN_BASE ? round2((((t12 / last12.length) * 12) / avg12) * 10000) / 100 : null,
    allTime: round2(series.reduce((s, p) => s + p.fees, 0)),
    byYear,
  };
}

const normName = (s: string) =>
  s
    .toUpperCase()
    .replace(/ · .*$/, '')
    .replace(/\(SHARES TRANSFERRED.*$/, '')
    .replace(/[^A-Z0-9 &]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !['INC', 'CORP', 'CO', 'PLC', 'LTD', 'SHS', 'CL', 'COM', 'NEW', 'REG', 'DEL', 'THE', 'HLDGS', 'HOLDINGS', 'GROUP', 'N', 'V', 'NV'].includes(w))
    .slice(0, 2)
    .join(' ');

// ---- main ----

export function summarizeMerrill(stmts: MlStmtRow[], txns: MlTxnRow[], ctx: MlContext): MerrillSummary {
  const today = ctx.today;
  const rets = monthlyReturns(ctx.market);
  const r = (sym: string, month: string) => rets.get(sym)?.get(month) ?? null;
  const sorted = [...stmts].sort((a, b) => a.date.localeCompare(b.date));

  // ---- per-account series ----
  const acctRows = new Map<string, { stmt: MlStmtRow; acct: MlAccount }[]>();
  for (const s of sorted) for (const a of s.values.accounts) acctRows.set(a.number, [...(acctRows.get(a.number) ?? []), { stmt: s, acct: a }]);
  const householdStmts = sorted.filter((s) => s.values.kind === 'household');

  const blendFor = (mix: SeriesPoint['mix'], month: string): number | null => {
    if (!mix) return null;
    const parts: [number, string][] = [
      [mix.us, 'VTI'],
      [mix.intl, 'VXUS'],
      [mix.fixed + mix.other, 'AGG'],
      [mix.cash, 'BIL'],
    ];
    let out = 0;
    for (const [w, sym] of parts) {
      if (w < 0.0001) continue;
      const x = r(sym, month);
      if (x === null) return null;
      out += w * x;
    }
    return out;
  };

  const buildSeries = (rows: { stmt: MlStmtRow; acct: MlAccount }[], partials: MlStmtRow[]): SeriesPoint[] => {
    const out: SeriesPoint[] = [];
    let prevMix: SeriesPoint['mix'] = null;
    let prev: { stmt: MlStmtRow; acct: MlAccount } | null = null;
    for (const row of rows) {
      const a = row.acct;
      const month = ym(row.stmt.date);
      // A household month whose account pages couldn't be read (scan): fill the
      // gap with the package-level change so the chain isn't broken.
      if (prev) {
        for (const p of partials) {
          if (p.date > prev.stmt.date && p.date < row.stmt.date && p.values.total !== null) {
            const prevTotal = householdTotalOn(prev.stmt);
            const rr = prevTotal ? p.values.total / prevTotal - 1 : null;
            const share = prevTotal ? prev.acct.closing / prevTotal : 0;
            out.push({ date: p.date, month: ym(p.date), value: round2(p.values.total * share), netFlow: 0, fees: 0, income: 0, market: 0, rNet: rr, rGross: rr, rSpy: r('SPY', ym(p.date)), rBlend: blendFor(prevMix, ym(p.date)), mix: prevMix });
          }
        }
      }
      const flow = externalFlow(a);
      const fees = -a.flows.fees;
      const base = a.opening + flow / 2;
      const rNet = base >= MIN_BASE ? (a.closing - a.opening - flow) / base : null;
      const rGross = rNet === null ? null : (a.closing - a.opening - flow + fees) / base;
      const alloc = a.holdings.length ? allocationOf(a.holdings) : null;
      const mixNow = alloc ? { us: alloc.us, intl: alloc.intl, fixed: alloc.fixed, cash: alloc.cash, other: alloc.other } : null;
      const mix = prevMix ?? mixNow;
      out.push({
        date: row.stmt.date,
        month,
        value: a.closing,
        netFlow: flow,
        fees: round2(fees),
        income: a.flows.dividends,
        market: a.market,
        rNet,
        rGross,
        rSpy: r('SPY', month),
        rBlend: blendFor(mix, month),
        mix,
      });
      prevMix = mixNow ?? prevMix;
      prev = row;
    }
    return out;
  };

  function householdTotalOn(s: MlStmtRow): number {
    return s.values.total ?? s.values.accounts.reduce((x, a) => x + a.closing, 0);
  }

  const partials = householdStmts.filter((s) => s.values.partial);
  const accountSummaries: AccountSummary[] = [];
  for (const [number, rows] of acctRows) {
    const last = rows[rows.length - 1];
    const a = last.acct;
    const owner: 'household' | 'chase' = a.type === 'utma' ? 'chase' : 'household';
    const series = buildSeries(rows, owner === 'household' ? partials : []);
    accountSummaries.push(summarizeAccount(number, a, last.stmt.date, rows, series, owner, txns, today));
  }
  const order: MlAccountType[] = ['ira', 'roth', 'cma', 'utma'];
  accountSummaries.sort((x, y) => order.indexOf(x.type) - order.indexOf(y.type));
  const householdAccts = accountSummaries.filter((x) => x.owner === 'household');
  const chase = accountSummaries.find((x) => x.owner === 'chase') ?? null;

  // ---- household combined series ----
  let household: AccountSummary | null = null;
  if (householdStmts.length) {
    const series: SeriesPoint[] = [];
    let prevMix: SeriesPoint['mix'] = null;
    let prevTotal: number | null = null;
    for (const s of householdStmts) {
      const month = ym(s.date);
      if (s.values.partial) {
        const total = s.values.total ?? 0;
        const rr = prevTotal ? total / prevTotal - 1 : null;
        series.push({ date: s.date, month, value: total, netFlow: 0, fees: 0, income: 0, market: 0, rNet: rr, rGross: rr, rSpy: r('SPY', month), rBlend: blendFor(prevMix, month), mix: prevMix });
        prevTotal = total;
        continue;
      }
      const accts = s.values.accounts;
      const opening = accts.reduce((x, a) => x + a.opening, 0);
      const closing = accts.reduce((x, a) => x + a.closing, 0);
      const flow = accts.reduce((x, a) => x + externalFlow(a), 0);
      const fees = -accts.reduce((x, a) => x + a.flows.fees, 0);
      const base = opening + flow / 2;
      const rNet = base >= MIN_BASE ? (closing - opening - flow) / base : null;
      const alloc = allocationOf(accts.flatMap((a) => a.holdings));
      const mixNow = { us: alloc.us, intl: alloc.intl, fixed: alloc.fixed, cash: alloc.cash, other: alloc.other };
      const mix = prevMix ?? mixNow;
      series.push({
        date: s.date,
        month,
        value: round2(closing),
        netFlow: round2(flow),
        fees: round2(fees),
        income: round2(accts.reduce((x, a) => x + a.flows.dividends, 0)),
        market: round2(accts.reduce((x, a) => x + a.market, 0)),
        rNet,
        rGross: rNet === null ? null : (closing - opening - flow + fees) / base,
        rSpy: r('SPY', month),
        rBlend: blendFor(mix, month),
        mix,
      });
      prevMix = mixNow;
      prevTotal = closing;
    }
    const latest = householdStmts.filter((s) => !s.values.partial).slice(-1)[0];
    const holdings = latest ? latest.values.accounts.flatMap((a) => a.holdings) : [];
    const lastA = latest?.values.accounts ?? [];
    household = {
      number: 'household',
      last4: '',
      type: 'cma',
      label: 'All Household Accounts',
      owner: 'household',
      value: series[series.length - 1]?.value ?? 0,
      asOf: series[series.length - 1]?.date ?? '',
      firstDate: series[0]?.date ?? '',
      strategy: null,
      sleeves: [],
      objective: null,
      allocation: allocationOf(holdings),
      costBasis: sumOrNull(lastA.map((a) => a.totals.cost)),
      unrealized: sumOrNull(lastA.map((a) => a.totals.gain)),
      estIncome: sumOrNull(lastA.map((a) => a.totals.income)),
      holdings: [],
      fees: feeSummary(series, today),
      income: incomeOf(series, today),
      flows: flowsOf(series),
      returns: {
        net: windows(series, (p) => p.rNet, today),
        gross: windows(series, (p) => p.rGross, today),
        spy: windows(series, (p) => p.rSpy, today),
        blend: windows(series, (p) => p.rBlend, today),
      },
      valueAdded: {
        vsBlend: { y1: dollarsVs(series, (p) => p.rBlend, 12), y3: dollarsVs(series, (p) => p.rBlend, 36), since: dollarsVs(series, (p) => p.rBlend, null) },
        vsSpy: { y1: dollarsVs(series, (p) => p.rSpy, 12), y3: dollarsVs(series, (p) => p.rSpy, 36), since: dollarsVs(series, (p) => p.rSpy, null) },
      },
      series,
      realizedYtd: null,
      unrealizedSplit: null,
      rollovers: [],
      tradesPerYear: [],
    };
  }

  // ---- merged holdings (household) ----
  const latestHh = householdStmts.filter((s) => !s.values.partial).slice(-1)[0];
  const merged = new Map<string, MergedHolding>();
  const hhTotal = latestHh ? latestHh.values.accounts.reduce((x, a) => x + a.closing, 0) : 0;
  for (const a of latestHh?.values.accounts ?? []) {
    for (const h of a.holdings) {
      const key = h.section === 'cash' ? 'CASH' : h.symbol ?? h.name;
      const m = merged.get(key) ?? { key, name: h.section === 'cash' ? 'Cash & Bank Deposits' : h.name, symbol: h.symbol, section: h.section, value: 0, pct: 0, gain: 0, income: 0, intl: isIntl(h), classes: h.classes, accounts: [] };
      m.value = round2(m.value + h.value);
      m.gain = m.gain === null || h.gain === null ? null : round2(m.gain + h.gain);
      m.income = round2((m.income ?? 0) + (h.income ?? 0));
      m.accounts.push({ last4: a.number.slice(-4), type: a.type, value: h.value });
      merged.set(key, m);
    }
  }
  const holdings = [...merged.values()].map((m) => ({ ...m, pct: hhTotal ? m.value / hhTotal : 0 })).sort((a, b) => b.value - a.value);

  // ---- taxes ----
  const taxes = taxSummary(sorted, txns, today);

  // ---- retirement inputs ----
  const preTax = householdAccts.filter((x) => x.type === 'ira').reduce((s, x) => s + x.value, 0);
  const roth = householdAccts.filter((x) => x.type === 'roth').reduce((s, x) => s + x.value, 0);
  const taxable = householdAccts.filter((x) => x.type === 'cma').reduce((s, x) => s + x.value, 0);
  const age = ctx.birthDate ? ageOn(ctx.birthDate, today) : null;

  const summary: MerrillSummary = {
    asOf: household?.asOf ?? chase?.asOf ?? null,
    household,
    accounts: householdAccts,
    chase,
    total: round2(householdAccts.reduce((s, x) => s + x.value, 0)),
    holdings,
    taxes,
    insights: [],
    questions: [],
    benchmark: benchmarkMeta(ctx.market),
    retirement: {
      age,
      birthDate: ctx.birthDate,
      preTax: round2(preTax),
      roth: round2(roth),
      taxable: round2(taxable),
      feeRate: household?.fees.rate12 ?? null,
      historicalNet: household?.returns.net.since ?? null,
      historicalBlend: household?.returns.blend.since ?? null,
    },
    statements: sorted.map((s) => ({
      id: s.id,
      date: s.date,
      kind: s.values.kind,
      total: s.values.total,
      partial: s.values.partial,
      fileId: s.fileId,
      checks: s.checks,
      accounts: s.values.accounts.map((a) => ({ last4: a.number.slice(-4), type: a.type, value: a.closing })),
    })),
  };
  summary.insights = insightsFor(summary, ctx);
  summary.questions = questionsFor(summary);
  return summary;
}

function sumOrNull(xs: (number | null)[]): number | null {
  if (!xs.length || xs.some((x) => x === null)) return null;
  return round2(xs.reduce<number>((s, x) => s + (x as number), 0));
}

function ageOn(birth: string, iso: string): number {
  const [by, bm, bd] = birth.split('-').map(Number);
  const [y, m, d] = iso.split('-').map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

function incomeOf(series: SeriesPoint[], today: string) {
  const yr = today.slice(0, 4);
  const byYear = new Map<number, number>();
  for (const p of series) byYear.set(yearOf(p.date), round2((byYear.get(yearOf(p.date)) ?? 0) + p.income));
  return {
    ytd: round2(series.filter((p) => p.date.startsWith(yr)).reduce((s, p) => s + p.income, 0)),
    last12: round2(series.slice(-12).reduce((s, p) => s + p.income, 0)),
    allTime: round2(series.reduce((s, p) => s + p.income, 0)),
    byYear: [...byYear].map(([year, total]) => ({ year, total })),
  };
}

function flowsOf(series: SeriesPoint[]) {
  const byYear = new Map<number, { in: number; out: number }>();
  for (const p of series) {
    const e = byYear.get(yearOf(p.date)) ?? { in: 0, out: 0 };
    if (p.netFlow > 0) e.in = round2(e.in + p.netFlow);
    else e.out = round2(e.out + p.netFlow);
    byYear.set(yearOf(p.date), e);
  }
  return {
    allTimeIn: round2(series.filter((p) => p.netFlow > 0).reduce((s, p) => s + p.netFlow, 0)),
    allTimeOut: round2(series.filter((p) => p.netFlow < 0).reduce((s, p) => s + p.netFlow, 0)),
    byYear: [...byYear].map(([year, e]) => ({ year, ...e })),
  };
}

function summarizeAccount(
  number: string,
  a: MlAccount,
  asOf: string,
  rows: { stmt: MlStmtRow; acct: MlAccount }[],
  series: SeriesPoint[],
  owner: 'household' | 'chase',
  txns: MlTxnRow[],
  today: string
): AccountSummary {
  const last4 = number.slice(-4);
  const trades = new Map<number, number>();
  for (const t of txns) if (t.account === last4 && (t.kind === 'buy' || t.kind === 'sell')) trades.set(yearOf(t.date), (trades.get(yearOf(t.date)) ?? 0) + 1);
  const rolloverMap = new Map<number, number>();
  for (const row of rows) for (const ro of row.acct.rollovers) if (ro.amount > 0) rolloverMap.set(ro.year, Math.max(rolloverMap.get(ro.year) ?? 0, ro.amount));
  return {
    number,
    last4,
    type: a.type,
    label: TYPE_LABEL[a.type],
    owner,
    value: a.closing,
    asOf,
    firstDate: rows[0].stmt.date,
    strategy: a.strategy,
    sleeves: a.sleeves,
    objective: a.objective,
    allocation: allocationOf(a.holdings),
    costBasis: a.totals.cost,
    unrealized: a.totals.gain,
    estIncome: a.totals.income,
    holdings: [...a.holdings].sort((x, y) => y.value - x.value),
    fees: feeSummary(series, today),
    income: incomeOf(series, today),
    flows: flowsOf(series),
    returns: {
      net: windows(series, (p) => p.rNet, today),
      gross: windows(series, (p) => p.rGross, today),
      spy: windows(series, (p) => p.rSpy, today),
      blend: windows(series, (p) => p.rBlend, today),
    },
    valueAdded: {
      vsBlend: { y1: dollarsVs(series, (p) => p.rBlend, 12), y3: dollarsVs(series, (p) => p.rBlend, 36), since: dollarsVs(series, (p) => p.rBlend, null) },
      vsSpy: { y1: dollarsVs(series, (p) => p.rSpy, 12), y3: dollarsVs(series, (p) => p.rSpy, 36), since: dollarsVs(series, (p) => p.rSpy, null) },
    },
    series,
    realizedYtd: a.realized ? { st: a.realized.stYtd, lt: a.realized.ltYtd } : null,
    unrealizedSplit: a.unrealized,
    rollovers: [...rolloverMap].map(([year, amount]) => ({ year, amount })).sort((x, y) => x.year - y.year),
    tradesPerYear: [...trades].map(([year, n]) => ({ year, trades: n })).sort((x, y) => x.year - y.year),
  };
}

function taxSummary(stmts: MlStmtRow[], txns: MlTxnRow[], today: string): TaxSummary {
  const taxableNums = new Set<string>();
  const typeOf = new Map<string, MlAccountType>();
  for (const s of stmts)
    for (const a of s.values.accounts) {
      typeOf.set(a.number.slice(-4), a.type);
      if (a.type === 'cma' || a.type === 'utma') taxableNums.add(a.number);
    }
  const years = new Map<number, TaxSummary['years'][number]>();
  const lastOfYear = new Map<string, { date: string; acct: MlAccount }>(); // `${num}:${year}`
  for (const s of stmts) {
    for (const a of s.values.accounts) {
      if (!taxableNums.has(a.number)) continue;
      const y = yearOf(s.date);
      const e = years.get(y) ?? { year: y, st: 0, lt: 0, lossesHarvested: 0, lossSales: 0, washMarked: 0, taxableIncome: 0, exemptIncome: 0, partial: true };
      for (const sale of a.sales) {
        if (sale.gain !== null && sale.gain < 0) {
          e.lossesHarvested = round2(e.lossesHarvested + sale.gain);
          e.lossSales++;
        }
        if (sale.washSale) e.washMarked++;
      }
      years.set(y, e);
      const k = `${a.number}:${y}`;
      const cur = lastOfYear.get(k);
      if (!cur || cur.date < s.date) lastOfYear.set(k, { date: s.date, acct: a });
    }
  }
  for (const [k, { date, acct }] of lastOfYear) {
    const y = Number(k.split(':')[1]);
    const e = years.get(y)!;
    if (acct.realized) {
      e.st = round2(e.st + acct.realized.stYtd);
      e.lt = round2(e.lt + acct.realized.ltYtd);
    } else {
      // single-account statements (UTMA) print no gain summary — sum the lots sold
    }
    if (acct.income) {
      e.taxableIncome = round2(e.taxableIncome + acct.income.ytd.taxableDividends + acct.income.ytd.taxableInterest);
      e.exemptIncome = round2(e.exemptIncome + acct.income.ytd.taxExemptDividends + acct.income.ytd.taxExemptInterest);
    } else {
      e.taxableIncome = round2(e.taxableIncome + acct.flowsYtd.dividends);
    }
    if (date.slice(5, 7) === '12') e.partial = false;
  }
  const yearList = [...years.values()].sort((a, b) => a.year - b.year);
  const thisYear = yearOf(today);
  const ytdRow = yearList.find((y) => y.year === thisYear) ?? null;

  // Harvest candidates: latest statement's taxable lots (and funds with no lots) at a loss.
  const latest = new Map<string, { date: string; acct: MlAccount }>();
  for (const s of stmts) for (const a of s.values.accounts) if (taxableNums.has(a.number)) latest.set(a.number, { date: s.date, acct: a });
  const lots: HarvestLot[] = [];
  for (const [, { date, acct }] of latest) {
    const last4 = acct.number.slice(-4);
    const lotSyms = new Set(acct.lots.map((l) => l.symbol));
    for (const l of acct.lots) {
      if (l.gain >= 0) continue;
      lots.push({ account: last4, type: acct.type, symbol: l.symbol, name: l.name, acquired: l.acquired, qty: l.qty, cost: l.cost, value: l.value, loss: l.gain, term: daysBetween(l.acquired, date) > 365 ? 'long' : 'short', fund: false });
    }
    for (const h of acct.holdings) {
      if (h.section !== 'fund' && h.section !== 'equity') continue;
      if (h.symbol && lotSyms.has(h.symbol)) continue;
      if (h.gain === null || h.gain >= 0 || h.cost === null) continue;
      lots.push({ account: last4, type: acct.type, symbol: h.symbol ?? h.name, name: h.name, acquired: h.initialPurchase, qty: h.qty, cost: h.cost, value: h.value, loss: h.gain, term: null, fund: true });
    }
  }
  // Group lots by account+symbol for the candidate list threshold.
  const bySym = new Map<string, number>();
  for (const l of lots) bySym.set(`${l.account}:${l.symbol}`, (bySym.get(`${l.account}:${l.symbol}`) ?? 0) + l.loss);
  const candidates = lots.filter((l) => -(bySym.get(`${l.account}:${l.symbol}`) ?? 0) >= HARVEST_MIN).sort((a, b) => a.loss - b.loss);
  const unrealizedGain = round2([...latest.values()].reduce((s, { acct }) => s + (acct.totals.gain ?? 0), 0));

  // Wash sales: a loss sale in a taxable account and a buy of the same name within 30 days either side, in any account.
  const buys = txns.filter((t) => t.kind === 'buy').map((t) => ({ ...t, key: normName(t.description) }));
  const wash: WashSale[] = [];
  for (const s of stmts) {
    for (const a of s.values.accounts) {
      if (!taxableNums.has(a.number)) continue;
      for (const sale of a.sales) {
        if (!(sale.washSale || (sale.gain !== null && sale.gain < 0))) continue;
        const key = normName(sale.name);
        if (!key) continue;
        const from = addDays(sale.sold, -30);
        const to = addDays(sale.sold, 30);
        const hits = buys.filter((b) => b.key === key && b.date >= from && b.date <= to && !(b.account === a.number.slice(-4) && b.date === sale.sold));
        if (!hits.length && !sale.washSale) continue;
        // Merrill's own 1099 already adjusts wash sales inside one account; only
        // buys in ANOTHER account (IRA, Roth, UTMA) slip through.
        const otherAcct = hits.filter((b) => b.account !== a.number.slice(-4));
        if (!otherAcct.length) continue;
        const permanent = otherAcct.some((b) => typeOf.get(b.account ?? '') === 'ira' || typeOf.get(b.account ?? '') === 'roth');
        const list = otherAcct;
        wash.push({
          account: a.number.slice(-4),
          type: a.type,
          name: sale.name,
          sold: sale.sold,
          loss: sale.gain,
          merrillFlagged: sale.washSale,
          buys: list.map((b) => ({ date: b.date, account: b.account ?? '', type: typeOf.get(b.account ?? '') ?? 'cma', qty: b.units, amount: Math.abs(b.amount) })),
          permanent,
        });
      }
    }
  }
  const seen = new Set<string>();
  const washSales = wash
    .filter((w) => {
      const k = `${w.account}:${w.name}:${w.sold}:${w.loss}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => b.sold.localeCompare(a.sold));

  return {
    accounts: [...taxableNums].map((n) => n.slice(-4)),
    years: yearList,
    ytd: ytdRow ? { st: ytdRow.st, lt: ytdRow.lt, income: ytdRow.taxableIncome, harvested: ytdRow.lossesHarvested } : null,
    harvest: {
      lots: candidates,
      total: round2(candidates.reduce((s, l) => s + l.loss, 0)),
      st: round2(candidates.filter((l) => l.term === 'short').reduce((s, l) => s + l.loss, 0)),
      lt: round2(candidates.filter((l) => l.term !== 'short').reduce((s, l) => s + l.loss, 0)),
    },
    washSales,
    unrealizedGain,
  };
}

function benchmarkMeta(rows: MarketMonth[]) {
  const months = new Set(rows.filter((r) => r.symbol === 'SPY').map((r) => r.month));
  const list = [...months].sort();
  return { months: list.length, first: list[0] ?? null, last: list[list.length - 1] ?? null, symbols: [...new Set(rows.map((r) => r.symbol))].sort() };
}

/** Reference stock share of a target-date fund N years from retirement
 * (roughly the big fund families' glide paths). */
export function glideEquity(yearsToRetire: number): number {
  const pts: [number, number][] = [
    [40, 0.9],
    [25, 0.9],
    [20, 0.85],
    [15, 0.78],
    [10, 0.68],
    [5, 0.57],
    [0, 0.5],
  ];
  const y = Math.max(0, Math.min(40, yearsToRetire));
  for (let i = 0; i < pts.length - 1; i++) {
    const [y1, e1] = pts[i];
    const [y2, e2] = pts[i + 1];
    if (y <= y1 && y >= y2) return e2 + ((e1 - e2) * (y - y2)) / (y1 - y2 || 1);
  }
  return 0.5;
}

// ---- insights ----

function insightsFor(s: MerrillSummary, ctx: MlContext): Insight[] {
  const out: Insight[] = [];
  const hh = s.household;
  const hhFees = hh?.fees.trailing12 ?? 0;

  // Performance vs the blended mix (3 years if we have it, else since start).
  const perf = (x: AccountSummary, who: string) => {
    const useY3 = x.returns.net.y3 !== null && x.returns.blend.y3 !== null;
    const net = useY3 ? x.returns.net.y3 : x.returns.net.since;
    const blend = useY3 ? x.returns.blend.y3 : x.returns.blend.since;
    const spy = useY3 ? x.returns.spy.y3 : x.returns.spy.since;
    if (net === null || blend === null) return;
    const span = useY3 ? 'the last 3 years' : `since ${x.returns.net.sinceStart ? longDate(`${x.returns.net.sinceStart}-15`).replace(/ \d+,/, '') : 'the start'}`;
    const diff = (net - blend) * 100;
    const dollars = useY3 ? x.valueAdded.vsBlend.y3 : x.valueAdded.vsBlend.since;
    const dTxt = dollars !== null ? ` (${dollars >= 0 ? '+' : '−'}${fmt(Math.abs(dollars))} vs the same deposits in index funds)` : '';
    const spyTxt = spy !== null ? ` The S&P 500 alone did ${pct1(spy * 100)}/yr.` : '';
    if (diff <= -EXCESS_BAND) {
      out.push({
        key: `perf:${x.number}`,
        severity: 'warn',
        area: 'performance',
        title: `${who} is behind an index mix by ${Math.abs(diff).toFixed(1)}%/yr`,
        detail: `Over ${span} it returned ${pct1(net * 100)}/yr after fees vs ${pct1(blend * 100)}/yr for index funds in the same stock/bond/cash mix${dTxt}.${spyTxt}`,
        question: `${who} returned ${pct1(net * 100)}/yr after fees over ${span}, vs ${pct1(blend * 100)}/yr for an index mix with the same stock/bond split. What's the case for the active strategy, and what benchmark do you hold yourselves to?`,
      });
    } else if (diff >= EXCESS_BAND) {
      out.push({ key: `perf:${x.number}`, severity: 'good', area: 'performance', title: `${who} is ahead of an index mix by ${diff.toFixed(1)}%/yr`, detail: `Over ${span}: ${pct1(net * 100)}/yr after fees vs ${pct1(blend * 100)}/yr for the same mix in index funds${dTxt}.${spyTxt}` });
    } else {
      out.push({
        key: `perf:${x.number}`,
        severity: 'info',
        area: 'performance',
        title: `${who} is roughly matching an index mix after fees`,
        detail: `Over ${span}: ${pct1(net * 100)}/yr after fees vs ${pct1(blend * 100)}/yr for index funds in the same mix${dTxt} — the fee is buying about index-level results.${spyTxt}`,
        question: who === 'The household' ? `After fees we're roughly matching a plain index mix. Beyond returns, what are we getting for the fee (planning, tax work, behavior coaching)?` : undefined,
      });
    }
  };
  if (hh) perf(hh, 'The household');
  for (const a of s.accounts) perf(a, a.label);

  // Fees.
  if (hh && hh.fees.rate12 !== null) {
    const rate = hh.fees.rate12;
    const v = hh.value;
    const robo = (v * ROBO_RATE) / 100;
    const idx = (v * INDEX_RATE) / 100;
    const cost20 = feeCostOver(v, 20, 0.065, rate / 100, ROBO_RATE / 100);
    out.push({
      key: 'fees:household',
      severity: rate >= FEE_HIGH ? 'warn' : 'info',
      area: 'fees',
      title: `Advisory fees: ${fmt(hhFees)} over the last 12 months (${rate.toFixed(2)}%/yr)`,
      detail: `On ${fmt(v)} that's about ${fmt((v * rate) / 100)} a year. A robo-advisor at ${ROBO_RATE}% would be ~${fmt(robo)}; index funds alone ~${fmt(idx)} (fund expenses inside the ETFs are on top in every case). Left to compound 20 years at 6.5%, the gap vs ${ROBO_RATE}% grows to roughly ${fmt(cost20)}.`,
      question: `We're paying about ${rate.toFixed(2)}% (${fmt(hhFees)} in the last year). What's our exact fee schedule, are we at a household breakpoint, and would consolidating or a flat fee lower it?`,
    });
  }
  for (const a of [...s.accounts, ...(s.chase ? [s.chase] : [])]) {
    if (a.fees.rate12 !== null && a.fees.rate12 >= FEE_HIGH) {
      out.push({ key: `fees:${a.number}`, severity: 'warn', area: 'fees', title: `${a.label}: ${a.fees.rate12.toFixed(2)}%/yr in advisory fees`, detail: `${fmt(a.fees.trailing12)} over the last 12 months on about ${fmt(a.value)}.` });
    }
  }

  // Allocation vs a target-date reference.
  if (hh && s.retirement.age !== null) {
    const years = ctx.retireAge - s.retirement.age;
    const ref = glideEquity(years);
    const eq = hh.allocation.equity;
    const sev = Math.abs(eq - ref) <= 0.1 ? 'good' : 'info';
    out.push({
      key: 'alloc:glide',
      severity: sev,
      area: 'allocation',
      title: `${Math.round(eq * 100)}% stocks overall — a target-date fund for retiring at ${ctx.retireAge} would hold ~${Math.round(ref * 100)}%`,
      detail: `${years} years to go. Bonds ${Math.round(hh.allocation.fixed * 100)}%, cash ${Math.round(hh.allocation.cash * 100)}%; ${Math.round((hh.allocation.intl / (eq || 1)) * 100)}% of the stocks are international.`,
      question: sev === 'info' ? `We're ${Math.round(eq * 100)}% in stocks with ~${years} years to retirement — a typical glide path says ~${Math.round(ref * 100)}%. Is that deliberate?` : undefined,
    });
  }
  const roth = s.accounts.find((a) => a.type === 'roth');
  const ira = s.accounts.find((a) => a.type === 'ira');
  const cma = s.accounts.find((a) => a.type === 'cma');
  if (roth && roth.allocation.equity < 0.9) {
    out.push({ key: 'alloc:roth', severity: 'info', area: 'allocation', title: `Roth IRA is ${Math.round(roth.allocation.equity * 100)}% stocks`, detail: 'Roth growth is never taxed, so it is usually the place for the most growth — the longest-horizon, highest-expected-return holdings.', question: 'Should the Roth be all stocks, with bonds held in the IRA instead?' });
  } else if (roth) {
    out.push({ key: 'alloc:roth', severity: 'good', area: 'allocation', title: `Roth IRA is ${Math.round(roth.allocation.equity * 100)}% stocks`, detail: 'Good use of tax-free growth — the Roth holds the growth assets.' });
  }
  if (cma && ira && cma.allocation.fixed > ira.allocation.fixed + LOCATION_GAP) {
    out.push({
      key: 'alloc:location',
      severity: 'info',
      area: 'allocation',
      title: `Bonds sit in the taxable CMA (${Math.round(cma.allocation.fixed * 100)}%) more than in the IRA (${Math.round(ira.allocation.fixed * 100)}%)`,
      detail: 'Bond interest is taxed as ordinary income every year in a taxable account; in the IRA it isn’t taxed until withdrawal. Holding bonds in the IRA and more stocks in the CMA ("asset location") usually lowers the tax bill for the same overall mix.',
      question: `The CMA holds ${Math.round(cma.allocation.fixed * 100)}% bonds (taxable interest) while the IRA is ${Math.round(ira.allocation.fixed * 100)}%. Can we manage the accounts as one portfolio and put the bonds in the IRA?`,
    });
  }
  for (const a of s.accounts) {
    if (a.allocation.cash > CASH_DRAG) out.push({ key: `alloc:cash:${a.number}`, severity: 'info', area: 'allocation', title: `${a.label} holds ${Math.round(a.allocation.cash * 100)}% cash`, detail: `About ${fmt(a.value * a.allocation.cash)} uninvested — the advisory fee still applies to it.`, question: `Why is ${Math.round(a.allocation.cash * 100)}% of the ${a.label} in cash, and are we paying the advisory fee on it?` });
  }
  const big = s.holdings.find((h) => h.section === 'equity' && h.pct > STOCK_CONC);
  if (big) out.push({ key: `alloc:conc:${big.key}`, severity: 'warn', area: 'allocation', title: `${big.name} is ${pct1(big.pct * 100)} of the household`, detail: `${fmt(big.value)} in one stock.`, question: `Is ${big.name} at ${pct1(big.pct * 100)} of our money intentional, and what's the plan to diversify it?` });

  // Taxes.
  const t = s.taxes;
  if (t.ytd) {
    if (t.ytd.st > 1000)
      out.push({
        key: 'tax:st',
        severity: 'info',
        area: 'taxes',
        title: `${fmt(t.ytd.st)} of short-term gains realized this year`,
        detail: 'Short-term gains (held a year or less) are taxed as ordinary income — at your bracket plus NY tax.',
        question: `We've realized ${fmt(t.ytd.st)} of short-term gains in the CMA this year. Is the strategy tax-managed, and can trades wait for long-term treatment?`,
      });
    out.push({ key: 'tax:ytd', severity: 'info', area: 'taxes', title: `Taxable accounts this year: ${fmt(t.ytd.st + t.ytd.lt)} realized gains, ${fmt(t.ytd.income)} taxable income`, detail: `Short-term ${fmt(t.ytd.st)} · long-term ${fmt(t.ytd.lt)} · losses harvested ${fmt(-t.ytd.harvested)}.` });
  }
  if (t.harvest.total <= -HARVEST_MIN) {
    const month = Number(ctx.today.slice(5, 7));
    out.push({
      key: 'tax:harvest',
      severity: month >= 10 ? 'warn' : 'info',
      area: 'taxes',
      title: `${fmt(-t.harvest.total)} of unrealized losses could be harvested`,
      detail: `${t.harvest.lots.length} lots in the taxable accounts are down (short-term ${fmt(-t.harvest.st)}, long-term ${fmt(-t.harvest.lt)}). Selling and swapping into a similar (not identical) holding books the loss against this year's ${fmt((t.ytd?.st ?? 0) + (t.ytd?.lt ?? 0))} of gains — mind the 30-day wash-sale window in every account, including the IRA.`,
      question: `There are about ${fmt(-t.harvest.total)} of losses sitting in the CMA. Will you harvest them before year-end, and how do you avoid wash sales with the IRA buying the same stocks?`,
    });
  }
  const recentWash = t.washSales.filter((w) => w.sold >= `${yearOf(ctx.today) - 1}-01-01`);
  if (recentWash.length) {
    const perm = recentWash.filter((w) => w.permanent);
    out.push({
      key: 'wash:recent',
      severity: 'warn',
      area: 'taxes',
      title: `${recentWash.length} possible wash sale${recentWash.length === 1 ? '' : 's'} since last year${perm.length ? ` (${perm.length} with an IRA buy)` : ''}`,
      detail: 'A loss sold in the CMA with the same security bought within 30 days in another account. Merrill’s 1099 only tracks wash sales inside one account; when the buy is in an IRA the loss is lost for good.',
      question: `I see loss sales in the CMA with the same stock bought within 30 days in the IRA (${perm.length || recentWash.length} cases since last year). Who coordinates trades across accounts, and do we need to adjust our tax return?`,
    });
  }
  if (cma) {
    const ty = cma.tradesPerYear.find((x) => x.year === yearOf(ctx.today) - 1) ?? cma.tradesPerYear[cma.tradesPerYear.length - 1];
    if (ty && ty.trades >= 100)
      out.push({ key: 'tax:turnover', severity: 'info', area: 'taxes', title: `The CMA made ${ty.trades} trades in ${ty.year}`, detail: 'Frequent small trades in a taxable account create short-term gains and wash-sale risk.', question: `The CMA had ${ty.trades} trades in ${ty.year}. Would a tax-managed or direct-indexing sleeve do the same job with fewer taxable events?` });
  }
  // Backdoor Roth / pro-rata.
  if (ira && ira.value > 0 && ctx.agi && ctx.agi.agi > ROTH_MFJ_PHASEOUT_START) {
    out.push({
      key: 'retire:backdoor',
      severity: 'info',
      area: 'retirement',
      title: 'Roth contributions: income is over the limit, and the IRA blocks a clean backdoor',
      detail: `Your ${ctx.agi.year} AGI (${fmt(ctx.agi.agi)}) is above the Roth phase-out (${fmt(ROTH_MFJ_PHASEOUT_START)} for joint filers in 2026). A backdoor Roth would be mostly taxable while ${fmt(ira.value)} of pre-tax money sits in the rollover IRA (the pro-rata rule) — unless that IRA is rolled into a workplace 401(k) first.`,
      question: `Can the rollover IRA move into my Birches 401(k) so we can do backdoor Roth contributions ($7,500 each in 2026)? What would we lose in investment options?`,
    });
  }
  // Chase.
  if (s.chase) {
    const c = s.chase;
    const inc = c.income.ytd;
    out.push({
      key: 'chase:summary',
      severity: 'info',
      area: 'chase',
      title: `Chase's UTMA: ${fmt(c.value)} as of ${longDate(c.asOf)}`,
      detail: `Strategy ${c.strategy ?? '—'}. Income this year ${fmt(inc)} (kiddie tax: first ${fmt(KIDDIE_FREE)} tax-free, parents' rate above ${fmt(KIDDIE_PARENT)}).`,
      question: c.fees.rate12 !== null ? `Chase's UTMA pays ${c.fees.rate12.toFixed(2)}% a year to sit in an ETF model. Should it move to a low-cost index fund, his 529, or a Trump Account instead?` : `Chase's UTMA is in an advisory program — does it make sense vs his 529 or a Trump Account?`,
    });
  }
  // Data gaps.
  const lastStmt = s.statements.filter((x) => x.kind === 'household').slice(-1)[0];
  if (lastStmt && daysBetween(lastStmt.date, ctx.today) > 45) out.push({ key: 'data:stale', severity: 'warn', area: 'data', title: `No Merrill statement since ${longDate(lastStmt.date)}`, detail: 'Download the latest from MyMerrill → Statements and drop it in the Drive folder.' });
  if (s.chase && daysBetween(s.chase.asOf, ctx.today) > 45) out.push({ key: 'data:chase', severity: 'info', area: 'data', title: `Chase's statements stop at ${longDate(s.chase.asOf)}`, detail: 'Save his monthly statements as “Merrill Lynch - YYYY.MM.DD - Chase.pdf” in the same folder to track his account.' });
  if (!s.benchmark.months) out.push({ key: 'data:market', severity: 'info', area: 'data', title: 'Benchmark prices haven’t loaded yet', detail: 'Index returns are pulled nightly; until then the comparisons are blank.' });
  return out;
}

/** Extra dollars a lower fee would leave after `years` on today's balance. */
export function feeCostOver(balance: number, years: number, ret: number, fee: number, lowerFee: number): number {
  return round2(balance * (Math.pow(1 + ret - lowerFee, years) - Math.pow(1 + ret - fee, years)));
}

function questionsFor(s: MerrillSummary): { area: Insight['area']; text: string }[] {
  const out = s.insights.filter((i) => i.question).map((i) => ({ area: i.area, text: i.question! }));
  // Standing questions worth asking at every review.
  out.push(
    { area: 'performance', text: 'Can you send our time-weighted returns net of fees by account, and the benchmark you compare each one to?' },
    { area: 'fees', text: 'What do the funds inside the accounts cost on top of the advisory fee (weighted expense ratio, and the JP Morgan SMA rate)?' },
    { area: 'taxes', text: 'What is your tax-loss harvesting policy for the CMA, and do you coordinate it with the IRA and Roth?' },
    { area: 'retirement', text: 'Based on our numbers, what retirement age and spending are realistic, and what would you change to get there sooner?' }
  );
  return out;
}
