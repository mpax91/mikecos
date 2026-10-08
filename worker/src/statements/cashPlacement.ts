import type { Env } from '../types';
import { fmtMdy, round2 } from './common';
import type { FolderRow } from './engine';
import { easternToday, syncFlags } from './engine';
import { templateById } from './templates';
import { loadAllyData } from './allyDerive';
import { allyCashStatements } from './allySummary';

/** Cash Placement (Mike, 2026-10-08) — rule-based, no AI, recomputed from
 * the statements every time they change. Two rules:
 *
 *  1. Idle checking cash (per bank). Checking buffer = the bigger of the
 *     median monthly outflow and the largest month over the last 12
 *     statements, + 20% (May 2024 needed a $6,600 overdraft transfer, so
 *     stay conservative). Idle = average checking balance over the last 3
 *     statements − buffer. Gain = idle × (savings APY − checking APY), both
 *     the "APY earned" on the latest statement. Suggest when ≥ $50/yr.
 *  2. Cross-bank savings (needs 2+ banks; American Express Bank plugs in
 *     later). Suggest moving a savings balance to a bank whose savings APY
 *     is higher when it gains ≥ $25/yr — never above $250K at the target
 *     bank (FDIC).
 *
 * A suggestion shows only after it has held on 2 statements in a row
 * (evaluated on the latest statement AND the one before); the amount shown
 * is the smaller of the two. Shown on the Finance page card + an info flag
 * on the account's dashboard — never the Accounts Need Attention badge
 * (`cash_` flags are excluded from attention and the Finance row count).
 * Mike moves the money himself.
 *
 * Plugging in a bank template: add an entry to CASH_SOURCES that returns
 * the folder's statements as CashStatement[] (oldest first). */

export const CASH_FLAG_PREFIX = 'cash_';

const BUFFER_MONTHS = 12;
const MIN_HISTORY_MONTHS = 6;
const BALANCE_MONTHS = 3;
const BUFFER_CUSHION = 1.2;
const MIN_IDLE_GAIN = 50;
const MIN_MOVE_GAIN = 25;
const FDIC_LIMIT = 250_000;
/** A bank whose latest statement is older than this is left out. */
const STALE_DAYS = 60;

export interface CashAccount {
  last4: string;
  kind: 'checking' | 'savings' | 'other';
  label: string; // "Checking ••5585"
  balance: number; // ending balance
  apy: number | null; // APY earned this period, percent
  avgBalance: number | null; // average daily balance this period
  outflow: number; // money that left for outside the bank this period (positive)
}

export interface CashStatement {
  date: string; // statement date
  accounts: CashAccount[];
}

export interface BankCashSource {
  folderId: string;
  bank: string; // "Ally Bank"
  owner: 'household' | 'chase';
  statements: CashStatement[]; // oldest first
}

type Loader = (env: Env, folder: FolderRow) => Promise<CashStatement[]>;
const CASH_SOURCES: Record<string, Loader> = {
  ally: async (env, folder) => {
    const { stmts, txns } = await loadAllyData(env, folder.id);
    return allyCashStatements(stmts, txns);
  },
};
export const isCashTemplate = (templateId: string | null) => !!templateId && templateId in CASH_SOURCES;

export async function loadCashSources(env: Env): Promise<BankCashSource[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM statement_folders WHERE status = 'live' ORDER BY folder_name`).all<FolderRow>();
  const out: BankCashSource[] = [];
  for (const row of results ?? []) {
    const load = row.template_id ? CASH_SOURCES[row.template_id] : undefined;
    if (!load) continue;
    out.push({ folderId: row.id, bank: templateById(row.template_id)?.account.nickname ?? row.folder_name, owner: row.owner, statements: await load(env, row) });
  }
  return out;
}

// ---------------------------------------------------------------- math --

export interface IdleCalc {
  asOf: string;
  checking: { last4: string; label: string; apy: number | null };
  savings: { last4: string; label: string; apy: number | null; balance: number } | null;
  months: number; // statements in the buffer window
  medianOutflow: number;
  largestOutflow: number;
  largestMonth: string | null; // statement date of the largest month
  buffer: number;
  avgBalance: number; // average checking balance, last 3 statements
  idle: number; // ≥ 0
  gainPerYear: number;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const ceil100 = (n: number) => Math.ceil(n / 100) * 100;
const floor100 = (n: number) => Math.floor(n / 100) * 100;

/** Rule 1 evaluated on statements[0..end] (inclusive). Null when there's
 * no checking + savings pair or not enough history. */
export function idleCalc(statements: CashStatement[], end = statements.length - 1): IdleCalc | null {
  if (end < 0) return null;
  const cur = statements[end];
  const checking = cur.accounts.find((a) => a.kind === 'checking');
  if (!checking) return null;
  // Best-paying savings account at this bank on this statement.
  const savings = cur.accounts.filter((a) => a.kind === 'savings').sort((a, b) => (b.apy ?? 0) - (a.apy ?? 0))[0] ?? null;
  const window = statements.slice(Math.max(0, end - BUFFER_MONTHS + 1), end + 1);
  const months = window.map((s) => ({ date: s.date, acct: s.accounts.find((a) => a.last4 === checking.last4) })).filter((m) => m.acct);
  if (months.length < MIN_HISTORY_MONTHS) return null;
  // No outflow at all means no transaction data for this account — a $0
  // buffer would call the whole balance idle, so don't guess.
  if (!months.some((m) => m.acct!.outflow > 0)) return null;
  const outs = months.map((m) => m.acct!.outflow);
  const largest = months.reduce((best, m) => (m.acct!.outflow > best.v ? { v: m.acct!.outflow, d: m.date } : best), { v: 0, d: null as string | null });
  const medianOutflow = round2(median(outs));
  const buffer = ceil100(Math.max(medianOutflow, largest.v) * BUFFER_CUSHION);
  const recent = months.slice(-BALANCE_MONTHS).map((m) => m.acct!.avgBalance ?? m.acct!.balance);
  const avgBalance = round2(recent.reduce((a, b) => a + b, 0) / recent.length);
  const idle = Math.max(0, floor100(avgBalance - buffer));
  const spread = savings && savings.apy !== null ? savings.apy - (checking.apy ?? 0) : 0;
  return {
    asOf: cur.date,
    checking: { last4: checking.last4, label: checking.label, apy: checking.apy },
    savings: savings ? { last4: savings.last4, label: savings.label, apy: savings.apy, balance: savings.balance } : null,
    months: months.length,
    medianOutflow,
    largestOutflow: round2(largest.v),
    largestMonth: largest.d,
    buffer,
    avgBalance,
    idle,
    gainPerYear: spread > 0 ? round2((idle * spread) / 100) : 0,
  };
}

export type IdleStatus = 'suggest' | 'not_held' | 'below_threshold' | 'no_idle' | 'no_savings' | 'insufficient_history' | 'stale';

export interface BankPlacement {
  folderId: string;
  bank: string;
  owner: 'household' | 'chase';
  status: IdleStatus;
  current: IdleCalc | null;
  previous: IdleCalc | null;
}

export interface CashSuggestion {
  id: string; // stable per statement: "idle:<folder>:<date>" / "move:<from>:<to>:<date>"
  kind: 'idle' | 'move';
  owner: 'household' | 'chase';
  folderId: string; // where the money is now
  toFolderId: string;
  bank: string;
  toBank: string;
  fromLabel: string;
  toLabel: string;
  fromApy: number;
  toApy: number;
  amount: number;
  gainPerYear: number;
  asOf: string;
  heldSince: string; // the earlier of the two statements it held on
  buffer?: number; // idle only: checking buffer kept
  fdicCapped?: boolean; // move only: amount limited by the $250K FDIC cap
  message: string;
}

export interface CashPlacement {
  today: string;
  rules: { bufferMonths: number; cushionPct: number; minIdleGain: number; minMoveGain: number; fdicLimit: number };
  banks: BankPlacement[];
  suggestions: CashSuggestion[];
}

const pct = (n: number | null) => (n === null ? '—' : `${n.toFixed(2)}%`);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
const money0 = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

/** Pure: every bank's rule-1 evaluation + all suggestions (rules 1 and 2). */
export function computeCashPlacement(sources: BankCashSource[], today: string): CashPlacement {
  const banks: BankPlacement[] = [];
  const suggestions: CashSuggestion[] = [];

  for (const src of sources) {
    const n = src.statements.length;
    const current = idleCalc(src.statements, n - 1);
    const previous = idleCalc(src.statements, n - 2);
    let status: IdleStatus;
    if (!current || !previous) status = 'insufficient_history';
    else if (daysBetween(current.asOf, today) > STALE_DAYS) status = 'stale';
    else if (!current.savings || current.savings.apy === null) status = 'no_savings';
    else if (current.idle <= 0) status = 'no_idle';
    else if (current.gainPerYear < MIN_IDLE_GAIN) status = 'below_threshold';
    else if (previous.idle <= 0 || previous.gainPerYear < MIN_IDLE_GAIN) status = 'not_held';
    else status = 'suggest';
    banks.push({ folderId: src.folderId, bank: src.bank, owner: src.owner, status, current, previous });

    if (status === 'suggest' && current && previous && current.savings) {
      const amount = Math.min(current.idle, previous.idle);
      const spread = current.savings.apy! - (current.checking.apy ?? 0);
      const gain = round2((amount * spread) / 100);
      suggestions.push({
        id: `idle:${src.folderId}:${current.asOf}`,
        kind: 'idle',
        owner: src.owner,
        folderId: src.folderId,
        toFolderId: src.folderId,
        bank: src.bank,
        toBank: src.bank,
        fromLabel: current.checking.label,
        toLabel: current.savings.label,
        fromApy: current.checking.apy ?? 0,
        toApy: current.savings.apy!,
        amount,
        gainPerYear: gain,
        asOf: current.asOf,
        heldSince: previous.asOf,
        buffer: current.buffer,
        message:
          `About ${money0(amount)} in ${src.bank} ${current.checking.label} has sat above its ${money0(current.buffer)} buffer for 2 statements — ` +
          `moving it to ${current.savings.label} (${pct(current.savings.apy)} vs ${pct(current.checking.apy)}) would earn about ${money0(gain)}/yr more.`,
      });
    }
  }

  // ---- Rule 2: savings across banks (same owner only) ----
  const savingsAt = (src: BankCashSource, end: number) => {
    const s = src.statements[end];
    if (!s) return null;
    const best = s.accounts.filter((a) => a.kind === 'savings' && a.apy !== null).sort((a, b) => b.apy! - a.apy!)[0];
    return best ? { date: s.date, acct: best, bankTotal: s.accounts.reduce((t, a) => t + a.balance, 0) } : null;
  };
  const fresh = sources.filter((s) => s.statements.length >= 2 && daysBetween(s.statements[s.statements.length - 1].date, today) <= STALE_DAYS);
  for (const from of fresh) {
    for (const to of fresh) {
      if (from === to || from.owner !== to.owner) continue;
      const evalAt = (back: number) => {
        const f = savingsAt(from, from.statements.length - 1 - back);
        const t = savingsAt(to, to.statements.length - 1 - back);
        if (!f || !t) return null;
        const spread = t.acct.apy! - f.acct.apy!;
        if (spread <= 0 || f.acct.balance <= 0) return null;
        const headroom = Math.max(0, FDIC_LIMIT - t.bankTotal);
        const amount = floor100(Math.min(f.acct.balance, headroom));
        return { f, t, spread, amount, capped: f.acct.balance > headroom, gain: round2((amount * spread) / 100) };
      };
      const now = evalAt(0);
      const before = evalAt(1);
      if (!now || !before || now.gain < MIN_MOVE_GAIN || before.gain < MIN_MOVE_GAIN) continue;
      const amount = Math.min(now.amount, before.amount);
      const gain = round2((amount * now.spread) / 100);
      suggestions.push({
        id: `move:${from.folderId}:${to.folderId}:${now.f.date}`,
        kind: 'move',
        owner: from.owner,
        folderId: from.folderId,
        toFolderId: to.folderId,
        bank: from.bank,
        toBank: to.bank,
        fromLabel: now.f.acct.label,
        toLabel: now.t.acct.label,
        fromApy: now.f.acct.apy!,
        toApy: now.t.acct.apy!,
        amount,
        gainPerYear: gain,
        asOf: now.f.date,
        heldSince: before.f.date,
        fdicCapped: now.capped,
        message:
          `${to.bank} ${now.t.acct.label} has paid more than ${from.bank} ${now.f.acct.label} for 2 statements (${pct(now.t.acct.apy)} vs ${pct(now.f.acct.apy)}) — ` +
          `moving ${money0(amount)} would earn about ${money0(gain)}/yr more${now.capped ? ` (capped to keep ${to.bank} under the $250K FDIC limit)` : ''}.`,
      });
    }
  }
  suggestions.sort((a, b) => b.gainPerYear - a.gainPerYear);
  return {
    today,
    rules: { bufferMonths: BUFFER_MONTHS, cushionPct: Math.round((BUFFER_CUSHION - 1) * 100), minIdleGain: MIN_IDLE_GAIN, minMoveGain: MIN_MOVE_GAIN, fdicLimit: FDIC_LIMIT },
    banks,
    suggestions,
  };
}

export async function getCashPlacement(env: Env): Promise<CashPlacement> {
  return computeCashPlacement(await loadCashSources(env), easternToday());
}

/** Info flags on each bank's own dashboard (scoped to `cash_` keys so the
 * template's own flag sync leaves them alone). Run after any bank folder
 * derives — a cross-bank suggestion depends on the other bank too. */
export async function syncCashPlacementFlags(env: Env): Promise<void> {
  const sources = await loadCashSources(env);
  const placement = computeCashPlacement(sources, easternToday());
  for (const src of sources) {
    const mine = placement.suggestions.filter((s) => s.folderId === src.folderId);
    await syncFlags(
      env,
      src.folderId,
      mine.map((s) => ({
        key: s.kind === 'idle' ? `${CASH_FLAG_PREFIX}idle:${s.asOf}` : `${CASH_FLAG_PREFIX}move:${s.toFolderId}:${s.asOf}`,
        severity: 'info' as const,
        message: `Cash Placement: ${s.message} Held since the ${fmtMdy(s.heldSince)} statement.`,
      })),
      { scope: CASH_FLAG_PREFIX }
    );
  }
}
