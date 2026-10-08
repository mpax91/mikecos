import { check, cents, fmtMoney, mdy, money, round2, UnreadableStatement } from '../common';
import type { ParsedStatement, ParsedTransaction, StatementCheck } from '../common';

/** Template #4 — Ally Bank combined monthly statement, Drive folder
 * "Ally Bank", files "Ally - YYYY.MM.DD - Statement.pdf" (2014-01 → today,
 * one per month, dated the 25th). One PDF covers every Ally account in the
 * relationship, so a statement holds several ACCOUNTS:
 *   Savings  ••4477 (opened 2014-01-01; "Online Savings Account" until
 *            2023, then "Savings" / "Savings Account")
 *   Checking ••5585 (opened 2020-03-25; "Interest Checking" until 2023,
 *            then "Checking" / "Spending Account")
 * Accounts are keyed by their last 4 digits, never by name (Ally renamed
 * both products in 2023). One layout ("STMTCMB100 05/2013") across all
 * years: page 1 lists every account (beginning / ending balance), then one
 * section per account ("Summary For:" … summary block … "Activity" rows).
 * Activity rows: "MM/DD/YYYY <Type>" then description lines then
 * "$credit -$debit $balance" (or all on one line). See
 * docs/statement-templates/ally.md. */

export type AllyAccountKind = 'checking' | 'savings' | 'other';

export interface AllyAccountValues {
  last4: string;
  kind: AllyAccountKind;
  name: string; // section heading as printed ("Savings", "Online Savings Account")
  product: string | null; // "Spending Account", "Online Savings Account"…
  ownership: string | null; // "Joint"
  holders: string | null; // "Michael A Palladino Cornelia C Palladino"
  openDate: string | null;
  periodStart: string;
  periodEnd: string;
  beginning: number;
  deposits: number; // "Deposits and Other Credits" (excludes interest)
  interest: number; // "Interest Paid This Period"
  atmReimbursed: number | null; // checking only
  withdrawals: number; // "Withdrawals and Other Debits" (negative)
  ending: number;
  days: number | null;
  apy: number | null; // Annual Percentage Yield Earned, percent
  avgDailyBalance: number | null;
  interestYtd: number | null;
  overdraftPaidPeriod: number | null;
  overdraftPaidYtd: number | null;
  overdraftReturnedPeriod: number | null;
  overdraftReturnedYtd: number | null;
  txnCount: number;
}

export interface AllyValues {
  statementDate: string;
  accounts: AllyAccountValues[];
  totalBeginning: number;
  totalEnding: number;
}

/** Transaction kinds stored for Ally (statement_transactions.kind). */
export type AllyTxnKind = 'deposit' | 'interest' | 'transfer_in' | 'transfer_out' | 'withdrawal' | 'fee' | 'other';

const AMT = String.raw`-?\$[\d,]+\.\d{2}`;
const ROW_AMOUNTS = new RegExp(String.raw`^(${AMT}) (${AMT}) (${AMT})$`);
const DATE_LINE = /^(\d{2}\/\d{2}\/\d{4}) (.+)$/;

/** Page furniture repeated on every page — never part of a description. */
const NOISE = [
  /^Ally Bank Member FDIC/,
  /STMTCMB100/,
  /^\d{6}-\d{2}-\d{2}$/,
  /^COMBINED CUST/,
  /^Statement Date$/,
  /^\d{2}\/\d{2}\/\d{4}$/,
  /^Page \d+$/,
  /^Customer Care Information$/,
  /^Toll Free 877-247-ALLY/,
  /^www\.ally\.com/,
  /^\d{6}\/\d+\/\/\d+\//,
  /^Activity$/,
  /^Date Description Credits Debits Balance$/,
  /^Ally Bank$/,
  /^®$/,
];
const isNoise = (l: string) => NOISE.some((r) => r.test(l));

export function accountKind(name: string, product: string | null): AllyAccountKind {
  const s = `${name} ${product ?? ''}`;
  if (/checking|spending/i.test(s)) return 'checking';
  if (/savings|money market/i.test(s)) return 'savings';
  return 'other';
}

/** Ally's row type (+ description) → normalized kind. Credits are +, debits −. */
export function txnKind(type: string, desc: string, amount: number): AllyTxnKind {
  const t = type.toLowerCase();
  if (t === 'interest paid') return 'interest';
  if (/fee/.test(t)) return 'fee';
  if (/funds transfer|overdraft transfer/.test(t)) return amount >= 0 ? 'transfer_in' : 'transfer_out';
  if (t === 'now withdrawal' && /requested transfer to/i.test(desc)) return 'transfer_out';
  if (/deposit|ach return/.test(t)) return amount >= 0 ? 'deposit' : 'withdrawal';
  if (/withdrawal|check|wire|purchase|debit/.test(t)) return amount < 0 ? 'withdrawal' : 'deposit';
  return 'other';
}

function num(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  return money(raw);
}

interface RawTxn {
  date: string;
  type: string;
  desc: string[];
  credit: number;
  debit: number; // negative
  balance: number;
}

function parseSection(lines: string[], start: number, end: number, stmtDate: string): { acct: AllyAccountValues; txns: RawTxn[]; checks: StatementCheck[] } {
  const sec = lines.slice(start, end);
  const name = (lines[start - 1] ?? '').trim();
  const text = sec.join('\n');
  const get = (re: RegExp) => text.match(re)?.[1]?.trim() ?? null;

  const holders = get(/^Summary For: (.+)$/m);
  const last4 = get(/^Account Number: x+(\d{4})\b/m);
  if (!last4) throw new UnreadableStatement(`No account number in the “${name}” section`);
  const openRaw = get(/Open Date: (\d{2}\/\d{2}\/\d{4})/);
  const product = get(/^Product: (.+?)(?: Account Ownership: .+)?$/m);
  const ownership = get(/Account Ownership: (.+)$/m);

  const begin = text.match(new RegExp(String.raw`^Beginning Balance, as of (\d{2}\/\d{2}\/\d{4}) (${AMT})$`, 'm'));
  const endM = text.match(new RegExp(String.raw`^Ending Balance, as of (\d{2}\/\d{2}\/\d{4}) (${AMT})$`, 'm'));
  if (!begin || !endM) throw new UnreadableStatement(`No beginning/ending balance for ••${last4}`);
  const field = (label: string) => {
    const m = text.match(new RegExp(String.raw`^${label} (${AMT})$`, 'm'));
    return m ? money(m[1]) : null;
  };
  const deposits = field('Deposits and Other Credits');
  const withdrawals = field('Withdrawals and Other Debits');
  const interest = field('Interest Paid This Period');
  if (deposits === null || withdrawals === null || interest === null) throw new UnreadableStatement(`Summary block incomplete for ••${last4}`);
  const odPaid = text.match(new RegExp(String.raw`^Overdraft Items Paid (${AMT}) (${AMT})$`, 'm'));
  const odRet = text.match(new RegExp(String.raw`^Overdraft Items Returned (${AMT}) (${AMT})$`, 'm'));
  const apyRaw = get(/^Annual Percentage Yield Earned ([\d.]+)%$/m);
  const daysRaw = get(/^Days In Statement Period (\d+)$/m);

  // ---- Activity rows ----
  const txns: RawTxn[] = [];
  const actStart = sec.findIndex((l) => l === 'Activity');
  let pending: { date: string; type: string; desc: string[] } | null = null;
  let endingRow: number | null = null;
  let beginningRow: number | null = null;
  for (let i = actStart + 1; actStart >= 0 && i < sec.length; i++) {
    const l = sec[i].trim();
    if (!l) continue;
    const d = l.match(DATE_LINE);
    if (d && !pending) {
      const rest = d[2];
      const bal = rest.match(new RegExp(String.raw`^(Beginning|Ending) Balance (${AMT})$`));
      if (bal) {
        if (bal[1] === 'Beginning') beginningRow = money(bal[2]);
        else {
          endingRow = money(bal[2]);
          break; // anything after the Ending Balance row is the back-page form
        }
        continue;
      }
      const one = rest.match(new RegExp(String.raw`^(.*?) (${AMT}) (${AMT}) (${AMT})$`));
      if (one) {
        txns.push({ date: mdy(d[1]), type: one[1].trim(), desc: [], credit: money(one[2]), debit: money(one[3]), balance: money(one[4]) });
      } else {
        pending = { date: mdy(d[1]), type: rest.trim(), desc: [] };
      }
      continue;
    }
    if (pending) {
      const a = l.match(ROW_AMOUNTS);
      if (a) {
        txns.push({ ...pending, credit: money(a[1]), debit: money(a[2]), balance: money(a[3]) });
        pending = null;
      } else if (!isNoise(l)) {
        pending.desc.push(l);
      }
    }
  }
  if (pending) throw new UnreadableStatement(`Unfinished activity row ${pending.date} ${pending.type} (••${last4})`);

  const acct: AllyAccountValues = {
    last4,
    kind: accountKind(name, product),
    name,
    product,
    ownership,
    holders,
    openDate: openRaw ? mdy(openRaw) : null,
    periodStart: mdy(begin[1]),
    periodEnd: mdy(endM[1]),
    beginning: money(begin[2]),
    deposits,
    interest,
    atmReimbursed: field('ATM Fees Reimbursed'),
    withdrawals,
    ending: money(endM[2]),
    days: daysRaw ? Number(daysRaw) : null,
    apy: apyRaw ? Number(apyRaw) : null,
    avgDailyBalance: field('Average Daily Balance This Period'),
    interestYtd: field('Interest Paid Year to Date'),
    overdraftPaidPeriod: odPaid ? money(odPaid[1]) : null,
    overdraftPaidYtd: odPaid ? money(odPaid[2]) : null,
    overdraftReturnedPeriod: odRet ? money(odRet[1]) : null,
    overdraftReturnedYtd: odRet ? money(odRet[2]) : null,
    txnCount: txns.length,
  };

  // ---- Checks (all arithmetic; any failure is flagged, never guessed) ----
  const tag = `••${last4}`;
  const checks: StatementCheck[] = [];
  const sumCredits = round2(txns.filter((t) => t.type !== 'Interest Paid').reduce((s, t) => s + t.credit, 0));
  const sumInterest = round2(txns.filter((t) => t.type === 'Interest Paid').reduce((s, t) => s + t.credit, 0));
  const sumDebits = round2(txns.reduce((s, t) => s + t.debit, 0));
  const expectEnd = round2(acct.beginning + deposits + interest + (acct.atmReimbursed ?? 0) + withdrawals);
  checks.push(check(`${tag} summary adds up`, cents(expectEnd, acct.ending), `${fmtMoney(acct.beginning)} + ${fmtMoney(deposits)} + ${fmtMoney(interest)}${acct.atmReimbursed ? ` + ${fmtMoney(acct.atmReimbursed)}` : ''} ${fmtMoney(withdrawals)} = ${fmtMoney(expectEnd)} vs ending ${fmtMoney(acct.ending)}`));
  checks.push(check(`${tag} credits match`, cents(sumCredits, deposits + (acct.atmReimbursed ?? 0)), `rows ${fmtMoney(sumCredits)} vs summary ${fmtMoney(deposits)}`));
  checks.push(check(`${tag} interest matches`, cents(sumInterest, interest), `rows ${fmtMoney(sumInterest)} vs summary ${fmtMoney(interest)}`));
  checks.push(check(`${tag} debits match`, cents(sumDebits, withdrawals), `rows ${fmtMoney(sumDebits)} vs summary ${fmtMoney(withdrawals)}`));
  let running = beginningRow ?? acct.beginning;
  let chainOk = true;
  let chainDetail = `${txns.length} rows`;
  for (const t of txns) {
    running = round2(running + t.credit + t.debit);
    if (!cents(running, t.balance)) {
      chainOk = false;
      chainDetail = `${t.date} ${t.type}: expected ${fmtMoney(running)}, printed ${fmtMoney(t.balance)}`;
      break;
    }
  }
  checks.push(check(`${tag} running balance`, chainOk, chainDetail));
  if (beginningRow !== null) checks.push(check(`${tag} beginning row`, cents(beginningRow, acct.beginning), `${fmtMoney(beginningRow)} vs ${fmtMoney(acct.beginning)}`));
  if (endingRow !== null) checks.push(check(`${tag} ending row`, cents(endingRow, acct.ending), `${fmtMoney(endingRow)} vs ${fmtMoney(acct.ending)}`));
  checks.push(check(`${tag} period ends on statement date`, acct.periodEnd === stmtDate, `${acct.periodEnd} vs ${stmtDate}`));
  return { acct, txns, checks };
}

/** Drops Ally's ACH plumbing ("~ Future Amount: 50.73 ~ Tran: ACHDW") and the
 * repeated trailing word it leaves ("CECONY CECONY", "AUTO DEBIT AUTO DEBIT"). */
export function cleanDesc(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/~\s*Future\s*Amount:\s*[\d.,]+\s*~\s*Tran:\s*\w+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(\S+(?: \S+)?)(?: \1)+$/, '$1');
}

export function parseAlly(text: string): ParsedStatement {
  if (!/Ally Bank/.test(text) || !/Summary For:/.test(text)) throw new UnreadableStatement('Not an Ally Bank combined statement');
  const lines = text.split('\n').map((l) => l.trim());
  const dateIdx = lines.findIndex((l) => l === 'Statement Date');
  const stmtRaw = dateIdx >= 0 ? lines.slice(dateIdx + 1, dateIdx + 3).find((l) => /^\d{2}\/\d{2}\/\d{4}$/.test(l)) : null;
  if (!stmtRaw) throw new UnreadableStatement('No statement date');
  const statementDate = mdy(stmtRaw);

  // Page 1: every account with beginning/ending balances.
  const listed = [...text.matchAll(new RegExp(String.raw`^(.+?) x+(\d{4}) (${AMT}) (${AMT})$`, 'gm'))].map((m) => ({
    name: m[1].trim(),
    last4: m[2],
    beginning: money(m[3]),
    ending: money(m[4]),
  }));
  const totals = text.match(new RegExp(String.raw`^Total Account Balances: (${AMT}) (${AMT})$`, 'm'));
  if (!listed.length || !totals) throw new UnreadableStatement('No account list on page 1');

  // One section per account, each opened by "Summary For:".
  const starts = lines.map((l, i) => (l.startsWith('Summary For:') ? i : -1)).filter((i) => i >= 0);
  const accounts: AllyAccountValues[] = [];
  const transactions: ParsedTransaction[] = [];
  const checks: StatementCheck[] = [];
  starts.forEach((s, k) => {
    const { acct, txns, checks: c } = parseSection(lines, s, k + 1 < starts.length ? starts[k + 1] - 1 : lines.length, statementDate);
    accounts.push(acct);
    checks.push(...c);
    for (const t of txns) {
      const amount = round2(t.credit + t.debit);
      const desc = cleanDesc(t.desc.join(' '));
      transactions.push({
        date: t.date,
        description: desc ? `${t.type} · ${desc}` : t.type,
        kind: txnKind(t.type, desc, amount),
        amount,
        units: null,
        unitPrice: null,
        account: acct.last4,
      });
    }
  });

  for (const l of listed) {
    const a = accounts.find((x) => x.last4 === l.last4);
    checks.push(check(`••${l.last4} page 1 matches section`, !!a && cents(a.beginning, l.beginning) && cents(a.ending, l.ending), a ? `${fmtMoney(l.beginning)}→${fmtMoney(l.ending)} vs ${fmtMoney(a.beginning)}→${fmtMoney(a.ending)}` : 'section missing'));
  }
  const totalBeginning = money(totals[1]);
  const totalEnding = money(totals[2]);
  const sumEnd = round2(accounts.reduce((s, a) => s + a.ending, 0));
  checks.push(check('Total balances add up', cents(sumEnd, totalEnding), `${fmtMoney(sumEnd)} vs ${fmtMoney(totalEnding)}`));

  const periodStart = accounts.map((a) => a.periodStart).sort()[0];
  const values: AllyValues = { statementDate, accounts, totalBeginning, totalEnding };
  return { periodStart, periodEnd: statementDate, values: values as unknown as Record<string, unknown>, transactions, checks };
}

/** Statement-to-statement checks (computed when loading, like ADT): each
 * account's beginning balance = its previous ending balance, and the
 * year-to-date interest carries forward (resetting in January). */
export function crossCheckAlly(prev: { values: AllyValues } | null, cur: { values: AllyValues }): StatementCheck[] {
  if (!prev) return [];
  // A missing month in between is flagged on its own; the carry-forward
  // can't be checked across it.
  const monthIndex = (iso: string) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7));
  if (monthIndex(cur.values.statementDate) - monthIndex(prev.values.statementDate) > 1) return [];
  const out: StatementCheck[] = [];
  for (const a of cur.values.accounts) {
    const p = prev.values.accounts.find((x) => x.last4 === a.last4);
    if (!p) {
      out.push(check(`••${a.last4} new account`, a.beginning === 0 || !!a.openDate && a.openDate >= prev.values.statementDate, a.beginning === 0 ? 'opened this period' : `no previous statement for ••${a.last4}`));
      continue;
    }
    out.push(check(`••${a.last4} carries from last statement`, cents(p.ending, a.beginning), `previous ending ${fmtMoney(p.ending)} vs beginning ${fmtMoney(a.beginning)}`));
    if (a.interestYtd !== null && p.interestYtd !== null) {
      const newYear = a.periodEnd.slice(0, 4) !== p.periodEnd.slice(0, 4);
      const expect = round2((newYear ? 0 : p.interestYtd) + a.interest);
      out.push(check(`••${a.last4} interest YTD`, cents(expect, a.interestYtd), `${fmtMoney(expect)} vs printed ${fmtMoney(a.interestYtd)}`));
    }
  }
  return out;
}
