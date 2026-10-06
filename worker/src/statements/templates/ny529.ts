import { check, cents, field, fmtMoney, mdy, money, round2, UnreadableStatement } from '../common';
import type { ParsedStatement, ParsedTransaction, StatementCheck } from '../common';

/** Template #2 — NY 529 Direct Plan quarterly statements (Ascensus /
 * Vanguard), Drive folder "529", files "529 - YYYY.MM.DD.pdf". One layout
 * era so far (2026 Q1 onward). Every field below was located against the
 * real Q1/Q2 2026 statements; see docs/statement-templates/529.md. */

export interface Ny529Holding {
  portfolio: string;
  units: number;
  unitPrice: number;
  value: number;
}

export interface Ny529Values {
  owner: string;
  beneficiary: string;
  accountLast: string; // e.g. "2087-01" — never the full number
  accountType: string;
  beginning: number;
  changeInValue: number;
  ending: number;
  principal: number;
  earnings: number;
  quarterContributions: number;
  ytdContributions: number;
  holdings: Ny529Holding[];
}

const AMT = String.raw`(-?\(?-?\$[\d,]+\.\d{2}\)?)`;

export function parseNy529(text: string): ParsedStatement {
  if (!/Account Type:\s*Individual 529|nysaves\.org/i.test(text)) {
    throw new UnreadableStatement('Not a NY 529 Direct Plan statement');
  }
  const period = text.match(/Statement Period:\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
  if (!period) throw new UnreadableStatement('No "Statement Period" line');
  const periodStart = mdy(period[1]);
  const periodEnd = mdy(period[2]);

  const amount = (label: string) => money(field(text, new RegExp(`^${label}\\s+${AMT}\\s*$`, 'm')));
  const beginning = amount('Account Beginning');
  const changeInValue = amount('Change in Value');
  const ending = amount('Account Ending');
  const principal = amount('Principal');
  const earnings = amount('Earnings');

  const contrib = text.match(new RegExp(`^Current Year Contributions - All Sources\\s+${AMT}\\s+${AMT}\\s*$`, 'm'));
  if (!contrib) throw new UnreadableStatement('No "Current Year Contributions" totals');
  const quarterContributions = money(contrib[1]);
  const ytdContributions = money(contrib[2]);

  const acct = field(text, /Account #:\s*([\d-]+)/);
  const values: Ny529Values = {
    owner: field(text, /Account Owner:\s*(.+)/),
    beneficiary: field(text, /Beneficiary:\s*(.+)/),
    accountLast: acct.replace(/^\d+(\d{4}-\d{2})$/, '$1'),
    accountType: field(text, /Account Type:\s*(.+)/),
    beginning,
    changeInValue,
    ending,
    principal,
    earnings,
    quarterContributions,
    ytdContributions,
    holdings: parseHoldings(text),
  };

  const transactions = parseTransactions(text);
  const checks: StatementCheck[] = [
    check('Beginning + Change = Ending', cents(beginning + changeInValue, ending), `${fmtMoney(beginning)} + ${fmtMoney(changeInValue)} vs ${fmtMoney(ending)}`),
    check('Principal + Earnings = Ending', cents(principal + earnings, ending), `${fmtMoney(principal)} + ${fmtMoney(earnings)} vs ${fmtMoney(ending)}`),
  ];
  const holdingsTotal = round2(values.holdings.reduce((s, h) => s + h.value, 0));
  checks.push(check('Holdings Total = Ending', cents(holdingsTotal, ending), `${fmtMoney(holdingsTotal)} vs ${fmtMoney(ending)}`));
  for (const h of values.holdings) {
    // Unit price is printed rounded to the cent, so allow half a cent per unit.
    const ok = Math.abs(h.units * h.unitPrice - h.value) <= h.units * 0.005 + 0.01;
    checks.push(check(`Units × Price = Value (${h.portfolio})`, ok, `${h.units} × ${fmtMoney(h.unitPrice)} vs ${fmtMoney(h.value)}`));
  }
  const contribTxns = round2(transactions.filter((t) => t.kind === 'aip' || t.kind === 'contribution').reduce((s, t) => s + t.amount, 0));
  checks.push(check('Transactions = Quarter Contributions', cents(contribTxns, quarterContributions), `${fmtMoney(contribTxns)} vs ${fmtMoney(quarterContributions)}`));

  return { periodStart, periodEnd, values: values as unknown as Record<string, unknown>, transactions, checks };
}

function parseHoldings(text: string): Ny529Holding[] {
  const start = text.indexOf('INVESTMENT SUMMARY');
  const end = text.indexOf('Total:', start);
  if (start < 0 || end < 0) throw new UnreadableStatement('No investment summary');
  const holdings: Ny529Holding[] = [];
  for (const line of text.slice(start, end).split('\n')) {
    const m = line.trim().match(/^(.+?)\s+([\d,]+\.\d{3,4})\s+\$([\d,]+\.\d{2})\s+\$([\d,]+\.\d{2})$/);
    if (m) holdings.push({ portfolio: m[1], units: Number(m[2].replace(/,/g, '')), unitPrice: money(m[3]), value: money(m[4]) });
  }
  if (!holdings.length) throw new UnreadableStatement('No holdings rows');
  return holdings;
}

function kindOf(desc: string, amount: number): ParsedTransaction['kind'] {
  if (/\bAIP\b/i.test(desc)) return 'aip';
  if (/withdraw|distribution|disbursement/i.test(desc) || amount < 0) return 'withdrawal';
  if (/contribution|deposit|rollover in/i.test(desc)) return 'contribution';
  return 'other';
}

/** Rows look like: "06/12/2026 2026 Contribution AIP" / portfolio name /
 * "50.8748 $16.38 $833.33". Page headers can land between those lines on
 * a long statement, so only the date line and the numbers line matter. */
function parseTransactions(text: string): ParsedTransaction[] {
  const start = text.indexOf('INVESTMENT TRANSACTIONS');
  if (start < 0) return [];
  const endIdx = text.indexOf('DISCLOSURES', start);
  const lines = text.slice(start, endIdx < 0 ? undefined : endIdx).split('\n').map((l) => l.trim());
  const out: ParsedTransaction[] = [];
  let pending: { date: string; description: string } | null = null;
  for (const line of lines) {
    const d = line.match(/^(\d{2}\/\d{2}\/\d{4})\s+(.+)$/);
    if (d) {
      pending = { date: mdy(d[1]), description: d[2] };
      continue;
    }
    const n = line.match(new RegExp(`^(-?[\\d,]+\\.\\d{3,4})\\s+\\$([\\d,]+\\.\\d{2})\\s+${AMT}$`));
    if (n && pending) {
      const amount = money(n[3]);
      out.push({
        date: pending.date,
        description: pending.description,
        kind: kindOf(pending.description, amount),
        amount,
        units: Number(n[1].replace(/,/g, '')),
        unitPrice: money(n[2]),
      });
      pending = null;
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Checks between consecutive statements (sorted by period). */
export function crossCheckNy529(prev: { periodEnd: string; values: Ny529Values } | null, cur: { periodStart: string; periodEnd: string; values: Ny529Values }): StatementCheck[] {
  if (!prev) return [];
  const out: StatementCheck[] = [];
  out.push(check('Prior Ending = This Beginning', cents(prev.values.ending, cur.values.beginning), `${fmtMoney(prev.values.ending)} vs ${fmtMoney(cur.values.beginning)}`));
  const sameYear = prev.periodEnd.slice(0, 4) === cur.periodEnd.slice(0, 4);
  const expectedYtd = sameYear ? prev.values.ytdContributions + cur.values.quarterContributions : cur.values.quarterContributions;
  out.push(check('YTD Contributions Chain', cents(expectedYtd, cur.values.ytdContributions), `${fmtMoney(expectedYtd)} vs ${fmtMoney(cur.values.ytdContributions)}`));
  return out;
}
