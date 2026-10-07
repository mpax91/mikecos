import { round2 } from './common';
import type { Ny529Values } from './templates/ny529';

/** Everything the 529 dashboard, Vault note, flags and reminders are built
 * from — computed from the stored statements alone, always following the
 * LATEST statement (backfilled older ones never roll values back). */

export interface Ny529Settings {
  nyLimit: number; // NY deduction cap for this filing status ($10,000 joint)
  limitConfirmedYear: number | null; // year Mike last confirmed the limit
  /** 'auto' (default): projectionReturnPct until there are
   * ACTUAL_RETURN_MIN_YEARS of statement history, then the account's own
   * annualized return — switches by itself. 'fixed': always
   * projectionReturnPct. */
  projectionMode: 'auto' | 'fixed';
  projectionReturnPct: number; // fixed rate / auto fallback; labeled, hypothetical projection only
}

export const DEFAULT_NY529_SETTINGS: Ny529Settings = { nyLimit: 10000, limitConfirmedYear: 2026, projectionMode: 'auto', projectionReturnPct: 6 };

/** Years of history before Auto trusts the account's own return. */
export const ACTUAL_RETURN_MIN_YEARS = 3;

export interface StmtRow {
  id: string;
  fileId: string;
  periodStart: string;
  periodEnd: string;
  values: Ny529Values;
  checks: { name: string; ok: boolean; detail: string }[];
}

export interface TxnRow {
  date: string;
  description: string;
  kind: string;
  amount: number;
  units: number | null;
  unitPrice: number | null;
}

export type MonthState = 'deposited' | 'missed' | 'upcoming' | 'before_start' | 'unknown';

export interface Ny529Summary {
  asOf: string | null;
  value: number;
  principal: number;
  earnings: number;
  gainPct: number | null;
  portfolio: string | null;
  unitPrice: number | null;
  aip: { amount: number; day: number; startedOn: string } | null;
  aipChanges: { date: string; from: number; to: number }[];
  year: number;
  ytdContributions: number;
  ytdAsOf: string | null;
  remainingDrafts: number;
  projectedYearEnd: number;
  limit: number;
  gap: number;
  months: { month: string; state: MonthState; amount: number }[]; // this calendar year, Jan–Dec
  missedMonths: string[]; // YYYY-MM, all time since AIP start, through asOf
  quarters: {
    periodStart: string;
    periodEnd: string;
    beginning: number;
    contributions: number;
    withdrawals: number;
    change: number;
    earnings: number;
    returnPct: number | null;
    ending: number;
    unitPrice: number | null;
    checksOk: boolean;
    fileId: string;
  }[];
  /** Time-weighted return since the first purchase (unit price chain, so
   * deposits don't distort it). Annualized only after a full year. */
  actualReturn: { since: string; years: number; cumulativePct: number; annualizedPct: number | null } | null;
  projection: {
    targetDate: string;
    value: number;
    contributed: number;
    returnPct: number;
    source: 'actual' | 'fallback' | 'fixed';
    actualFrom: string | null; // Auto: date the actual return takes (or took) over
  } | null;
}

const ym = (iso: string) => iso.slice(0, 7);

function addMonths(ymStr: string, n: number): string {
  const [y, m] = ymStr.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function daysInMonth(ymStr: string): number {
  const [y, m] = ymStr.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** `today` is a US-Eastern YYYY-MM-DD. */
export function summarizeNy529(stmts: StmtRow[], txns: TxnRow[], settings: Ny529Settings, today: string): Ny529Summary {
  const sorted = [...stmts].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  const latest = sorted[sorted.length - 1] ?? null;
  const asOf = latest?.periodEnd ?? null;
  const year = Number(today.slice(0, 4));

  const aipTxns = txns.filter((t) => t.kind === 'aip').sort((a, b) => a.date.localeCompare(b.date));
  const aipChanges: Ny529Summary['aipChanges'] = [];
  for (let i = 1; i < aipTxns.length; i++) {
    if (Math.abs(aipTxns[i].amount - aipTxns[i - 1].amount) >= 0.01) aipChanges.push({ date: aipTxns[i].date, from: aipTxns[i - 1].amount, to: aipTxns[i].amount });
  }
  const lastAip = aipTxns[aipTxns.length - 1];
  // The draft day drifts a day or two around weekends — use the latest
  // weekday-agnostic max of recent drafts as "the day" (13th/14th → 14).
  const recentDays = aipTxns.slice(-3).map((t) => Number(t.date.slice(8, 10)));
  const aip = lastAip ? { amount: lastAip.amount, day: Math.max(...recentDays), startedOn: aipTxns[0].date } : null;

  // AIP months covered by statements: first AIP month → asOf month.
  const aipMonths = new Set(aipTxns.map((t) => ym(t.date)));
  const missedMonths: string[] = [];
  if (aip && asOf) {
    for (let m = ym(aip.startedOn); m <= ym(asOf); m = addMonths(m, 1)) {
      if (!aipMonths.has(m)) missedMonths.push(m);
    }
  }

  // This year's contributions: the latest statement's YTD if it's from this
  // year (statements are the source of truth for the deduction).
  const latestThisYear = [...sorted].reverse().find((s) => s.periodEnd.startsWith(String(year))) ?? null;
  const ytdContributions = latestThisYear?.values.ytdContributions ?? 0;
  const ytdAsOf = latestThisYear?.periodEnd ?? null;

  // Drafts this year after the latest statement's cutoff, assuming the
  // current AIP keeps running (drafts already made but not yet on a
  // statement count here too — they aren't in the YTD figure yet).
  let remainingDrafts = 0;
  if (aip) {
    const cutoff = ytdAsOf ?? `${year - 1}-12-31`;
    for (let m = `${year}-01`; m <= `${year}-12`; m = addMonths(m, 1)) {
      const draft = `${m}-${String(Math.min(aip.day, daysInMonth(m))).padStart(2, '0')}`;
      if (draft > cutoff) remainingDrafts++;
    }
  }
  const projectedYearEnd = round2(ytdContributions + remainingDrafts * (aip?.amount ?? 0));
  const gap = Math.max(0, round2(settings.nyLimit - projectedYearEnd));

  // Jan–Dec dots for this year.
  const months: Ny529Summary['months'] = [];
  for (let i = 0; i < 12; i++) {
    const m = `${year}-${String(i + 1).padStart(2, '0')}`;
    const amount = round2(txns.filter((t) => (t.kind === 'aip' || t.kind === 'contribution') && ym(t.date) === m).reduce((s, t) => s + t.amount, 0));
    let state: MonthState;
    if (aipMonths.has(m)) state = 'deposited';
    else if (!aip || m < ym(aip.startedOn)) state = amount > 0 ? 'deposited' : 'before_start';
    else if (asOf && m <= ym(asOf)) state = 'missed';
    else if (m >= ym(today)) state = 'upcoming';
    else state = 'unknown'; // past, but no statement covers it yet
    months.push({ month: m, state, amount });
  }

  const quarters: Ny529Summary['quarters'] = sorted.map((s, i) => {
    const inPeriod = txns.filter((t) => t.date >= s.periodStart && t.date <= s.periodEnd);
    const withdrawals = round2(-inPeriod.filter((t) => t.kind === 'withdrawal').reduce((acc, t) => acc + t.amount, 0));
    const contributions = s.values.quarterContributions;
    const quarterEarnings = round2(s.values.changeInValue - contributions + withdrawals);
    // Modified Dietz with mid-period cash flows — good enough for a
    // quarterly read; an empty starting balance has no meaningful return.
    const base = s.values.beginning + (contributions - withdrawals) / 2;
    // Single-portfolio account: the unit-price change IS the time-weighted
    // return (deposits don't distort it). Fall back to Dietz otherwise.
    const prevH = i > 0 ? sorted[i - 1].values.holdings : null;
    const curH = s.values.holdings;
    const twr =
      prevH && prevH.length === 1 && curH.length === 1 && prevH[0].portfolio === curH[0].portfolio && prevH[0].unitPrice > 0
        ? round2((curH[0].unitPrice / prevH[0].unitPrice - 1) * 100)
        : null;
    return {
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
      beginning: s.values.beginning,
      contributions,
      withdrawals,
      change: s.values.changeInValue,
      earnings: quarterEarnings,
      returnPct: twr ?? (s.values.beginning > 0 && base > 0 ? round2((quarterEarnings / base) * 100) : null),
      ending: s.values.ending,
      unitPrice: s.values.holdings[0]?.unitPrice ?? null,
      checksOk: s.checks.every((c) => c.ok),
      fileId: s.fileId,
    };
  });

  const portfolio = latest?.values.holdings[0]?.portfolio ?? null;
  const actualReturn = computeActualReturn(sorted, txns, quarters);

  // Rate for the projection. Auto switches itself once there's enough
  // history — nothing for Mike to remember.
  let returnPct = settings.projectionReturnPct;
  let source: 'actual' | 'fallback' | 'fixed' = settings.projectionMode === 'fixed' ? 'fixed' : 'fallback';
  const actualFrom = actualReturn ? addYears(actualReturn.since, ACTUAL_RETURN_MIN_YEARS) : null;
  if (settings.projectionMode !== 'fixed' && actualReturn?.annualizedPct != null && actualReturn.years >= ACTUAL_RETURN_MIN_YEARS) {
    returnPct = actualReturn.annualizedPct;
    source = 'actual';
  }

  let projection: Ny529Summary['projection'] = null;
  const targetYear = portfolio?.match(/(20\d{2})/)?.[1];
  if (latest && targetYear) {
    // Hypothetical: monthly compounding at the chosen return, current AIP
    // continuing until the September of the enrollment year.
    const targetDate = `${targetYear}-09-01`;
    const r = Math.pow(1 + returnPct / 100, 1 / 12) - 1;
    let v = latest.values.ending;
    let contributed = latest.values.principal;
    for (let m = addMonths(ym(latest.periodEnd), 1); `${m}-01` < targetDate; m = addMonths(m, 1)) {
      v = v * (1 + r) + (aip?.amount ?? 0);
      contributed += aip?.amount ?? 0;
    }
    projection = { targetDate, value: round2(v), contributed: round2(contributed), returnPct, source, actualFrom: settings.projectionMode === 'fixed' ? null : actualFrom };
  }

  return {
    asOf,
    value: latest?.values.ending ?? 0,
    principal: latest?.values.principal ?? 0,
    earnings: latest?.values.earnings ?? 0,
    gainPct: latest && latest.values.principal > 0 ? round2((latest.values.earnings / latest.values.principal) * 100) : null,
    portfolio,
    unitPrice: latest?.values.holdings[0]?.unitPrice ?? null,
    aip,
    aipChanges,
    year,
    ytdContributions,
    ytdAsOf,
    remainingDrafts,
    projectedYearEnd,
    limit: settings.nyLimit,
    gap,
    months,
    missedMonths,
    quarters,
    actualReturn,
    projection,
  };
}

function addYears(iso: string, n: number): string {
  return `${Number(iso.slice(0, 4)) + n}${iso.slice(4)}`;
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);

/** Single portfolio throughout: latest unit price ÷ first purchase price.
 * Otherwise chain the quarterly returns. */
function computeActualReturn(sorted: StmtRow[], txns: TxnRow[], quarters: Ny529Summary['quarters']): Ny529Summary['actualReturn'] {
  const latest = sorted[sorted.length - 1];
  if (!latest) return null;
  const names = new Set(sorted.flatMap((s) => s.values.holdings.map((h) => h.portfolio)));
  const firstBuy = [...txns].filter((t) => t.unitPrice && t.unitPrice > 0 && t.amount > 0).sort((a, b) => a.date.localeCompare(b.date))[0];
  let since: string;
  let growth: number;
  if (names.size === 1 && latest.values.holdings.length === 1 && firstBuy) {
    since = firstBuy.date;
    growth = latest.values.holdings[0].unitPrice / firstBuy.unitPrice!;
  } else {
    const qs = quarters.filter((q) => q.returnPct !== null);
    if (!qs.length) return null;
    since = qs[0].periodStart;
    growth = qs.reduce((g, q) => g * (1 + q.returnPct! / 100), 1);
  }
  const days = daysBetween(since, latest.periodEnd);
  if (days <= 0) return null;
  const years = days / 365.25;
  return {
    since,
    years: round2(years),
    cumulativePct: round2((growth - 1) * 100),
    annualizedPct: years >= 1 ? round2((Math.pow(growth, 1 / years) - 1) * 100) : null,
  };
}
