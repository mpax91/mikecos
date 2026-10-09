import { check, cents, fmtMoney, mdy, money, round2, UnreadableStatement } from '../common';
import type { ParsedStatement, ParsedTransaction, StatementCheck } from '../common';

/** Template #5 — American Express Bank High Yield Savings (monthly), Drive
 * folder "American Express Bank", files "AMEX FSB - YYYY.MM.DD.pdf"
 * (2011-06 → today, one per month, dated the 10th/11th). One account,
 * Savings ••8815 (printed "151-991881-5" until mid-2013, "xxxxxxxx8815"
 * after). Two text layouts:
 *   Era A  "Statement of Account" (2013-02 → 2013-06-16): MM-DD rows with
 *          signed Additions/Subtractions, "Ending totals" line, no running
 *          balance, no interest YTD.
 *   Era B  "Account Statement For:" (2013-06-17 → today): "Account Summary"
 *          block (inline "label $x" lines, or — 2013-07 → 2020-12 — every
 *          label first and every value after, in the same order) and
 *          "Account Activity" rows "MM/DD/YYYY <Type>", description lines,
 *          then "$amount $balance" with ONE amount column (debit vs credit
 *          is read off the running balance).
 * 2011-06 → 2012-12 are image-only scans (no text) → unreadable.
 * See docs/statement-templates/amexBank.md. */

export interface AmexBankAccountValues {
  last4: string;
  kind: 'savings';
  product: string | null;
  holders: string | null;
  ownership: null;
  ending: number;
  apy: number | null;
}

export interface AmexBankValues {
  era: 'A' | 'B';
  statementDate: string;
  periodStart: string;
  days: number | null;
  last4: string;
  product: string | null;
  holders: string | null;
  beginning: number;
  /** All money in, interest included (Amex's "Total Credits"). */
  credits: number;
  /** All money out, as a positive number ("Total Debits"). */
  debits: number;
  interest: number;
  interestYtd: number | null;
  ending: number;
  /** "Annual Percentage Yield Earned This Period", percent. */
  apyEarned: number | null;
  /** Stated APY in effect on the last day ("Annual Percentage Yield (APY)*"). */
  apy: number | null;
  rate: number | null; // "Annual Interest Rate*"
  avgBalance: number | null; // era A "Average balance for APY"
  txnCount: number;
  accounts: AmexBankAccountValues[];
}

export type AmexBankTxnKind = 'deposit' | 'interest' | 'withdrawal' | 'fee' | 'other';

const AMT = String.raw`\$[\d,]+\.\d{2}`;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** "April 10, 2013" → "2013-04-10". */
export function longDate(raw: string): string {
  const m = raw.trim().match(/^([A-Za-z]+) (\d{1,2}), (\d{4})$/);
  const mi = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  if (!m || mi < 0) throw new UnreadableStatement(`Not a date: "${raw}"`);
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

/** Amex row type (+ direction) → normalized kind. Credits +, debits −. */
export function txnKind(type: string, amount: number): AmexBankTxnKind {
  const t = type.toLowerCase();
  if (/^interest/.test(t)) return 'interest';
  if (/fee/.test(t)) return 'fee';
  if (/deposit|credit/.test(t)) return amount >= 0 ? 'deposit' : 'withdrawal';
  if (/withdrawal|debit/.test(t)) return amount < 0 ? 'withdrawal' : 'deposit';
  return amount >= 0 ? 'deposit' : 'other';
}

/** The counterparty of a stored description ("ACH Deposit · USAA … · Sender…"). */
export function counterparty(description: string): string {
  const parts = description.split(' · ');
  return (parts[1] ?? parts[0]).trim();
}

const last4Of = (acct: string) => acct.replace(/\D/g, '').slice(-4);

interface RawTxn {
  date: string;
  type: string;
  desc: string[];
  amount: number; // signed
  balance: number | null;
}

function finish(v: Omit<AmexBankValues, 'accounts' | 'txnCount'>, txns: RawTxn[], checks: StatementCheck[]): ParsedStatement {
  const values: AmexBankValues = {
    ...v,
    txnCount: txns.length,
    accounts: [{ last4: v.last4, kind: 'savings', product: v.product, holders: v.holders, ownership: null, ending: v.ending, apy: v.apy ?? v.apyEarned }],
  };
  const transactions: ParsedTransaction[] = txns.map((t) => ({
    date: t.date,
    description: [t.type, ...t.desc].join(' · '),
    kind: txnKind(t.type, t.amount),
    amount: round2(t.amount),
    units: null,
    unitPrice: null,
    account: v.last4,
  }));
  // Shared arithmetic checks.
  const credits = round2(txns.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0));
  const debits = round2(-txns.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0));
  const interestRows = round2(txns.filter((t) => /^interest/i.test(t.type)).reduce((s, t) => s + t.amount, 0));
  const expectEnd = round2(v.beginning + v.credits - v.debits);
  checks.push(check('Summary adds up', cents(expectEnd, v.ending), `${fmtMoney(v.beginning)} + ${fmtMoney(v.credits)} − ${fmtMoney(v.debits)} = ${fmtMoney(expectEnd)} vs ending ${fmtMoney(v.ending)}`));
  checks.push(check('Credits match', cents(credits, v.credits), `rows ${fmtMoney(credits)} vs summary ${fmtMoney(v.credits)}`));
  checks.push(check('Debits match', cents(debits, v.debits), `rows ${fmtMoney(debits)} vs summary ${fmtMoney(v.debits)}`));
  checks.push(check('Interest matches', cents(interestRows, v.interest), `rows ${fmtMoney(interestRows)} vs summary ${fmtMoney(v.interest)}`));
  return { periodStart: v.periodStart, periodEnd: v.statementDate, values: values as unknown as Record<string, unknown>, transactions, checks };
}

// ---------------------------------------------------------------- Era A

function parseEraA(text: string, lines: string[]): ParsedStatement {
  const stmt = longDate(text.match(/This statement: ([A-Za-z]+ \d{1,2}, \d{4})/)?.[1] ?? '');
  const last = longDate(text.match(/Last statement: ([A-Za-z]+ \d{1,2}, \d{4})/)?.[1] ?? '');
  const days = Number(text.match(/Total days in statement period: (\d+)/)?.[1] ?? NaN);
  const prod = text.match(new RegExp(String.raw`^(High-Yield Savings) (\d{3}-\d{6}-\d) (${AMT})$`, 'm'));
  if (!prod) throw new UnreadableStatement('No account line');
  const last4 = last4Of(prod[2]);
  const yearOf = (mm: number) => (mm > Number(stmt.slice(5, 7)) ? Number(stmt.slice(0, 4)) - 1 : Number(stmt.slice(0, 4)));
  const iso = (mmdd: string) => {
    const [mm, dd] = mmdd.split('-').map(Number);
    return `${yearOf(mm)}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  };

  const txns: RawTxn[] = [];
  let beginning: number | null = null;
  let totals: { add: number; sub: number; end: number } | null = null;
  const start = lines.findIndex((l) => /^Date Description Additions Subtractions Balance$/.test(l));
  if (start < 0) throw new UnreadableStatement('No activity table');
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    const b = l.match(new RegExp(String.raw`^\d{2}-\d{2} Beginning balance (${AMT})$`));
    if (b) {
      beginning = money(b[1]);
      continue;
    }
    const e = l.match(new RegExp(String.raw`^\d{2}-\d{2} Ending totals (-?[\d,]*\.\d{2}) (-?[\d,]*\.\d{2}) (${AMT})$`));
    if (e) {
      totals = { add: money(e[1]), sub: money(e[2]), end: money(e[3]) };
      break;
    }
    const r = l.match(/^(\d{2}-\d{2}) (?:# )?(.+?) (-?[\d,]*\.\d{2})$/);
    if (r) {
      txns.push({ date: iso(r[1]), type: r[2].trim(), desc: [], amount: money(r[3]), balance: null });
      continue;
    }
    // Continuation lines: keep the first (the counterparty); the rest is ACH plumbing.
    const t = txns[txns.length - 1];
    if (t && t.desc.length === 0 && l) t.desc.push(l.replace(/\s+/g, ' ').trim());
  }
  if (beginning === null || !totals) throw new UnreadableStatement('No beginning balance / ending totals');
  const apyEarned = Number(text.match(/Annual percentage yield earned ([\d.]+) ?%/)?.[1] ?? NaN);
  const avgBal = text.match(new RegExp(String.raw`Average balance for APY (${AMT})`))?.[1];
  const intEarned = text.match(new RegExp(String.raw`Interest earned (${AMT})`))?.[1];
  const interest = round2(txns.filter((t) => /^interest/i.test(t.type)).reduce((s, t) => s + t.amount, 0));
  const checks: StatementCheck[] = [];
  checks.push(check('Ending totals add up', cents(beginning + totals.add + totals.sub, totals.end), `${fmtMoney(beginning)} + ${fmtMoney(totals.add)} ${fmtMoney(totals.sub)} vs ${fmtMoney(totals.end)}`));
  checks.push(check('Account line matches ending', cents(money(prod[3]), totals.end), `${prod[3]} vs ${fmtMoney(totals.end)}`));
  if (intEarned) checks.push(check('Interest earned matches', cents(money(intEarned), interest), `${intEarned} vs rows ${fmtMoney(interest)}`));
  if (Number.isFinite(days)) {
    const span = Math.round((Date.parse(stmt) - Date.parse(last)) / 86400000);
    checks.push(check('Days in period', span === days, `${span} vs printed ${days}`));
  }
  return finish(
    {
      era: 'A',
      statementDate: stmt,
      periodStart: last,
      days: Number.isFinite(days) ? days : null,
      last4,
      product: 'High-Yield Savings',
      holders: text.match(/^Customer Service\n[\d-]+\n(.+)$/m)?.[1]?.trim() ?? null,
      beginning,
      credits: totals.add,
      debits: -totals.sub,
      interest,
      interestYtd: null,
      ending: totals.end,
      apyEarned: Number.isFinite(apyEarned) ? apyEarned : null,
      apy: null,
      rate: null,
      avgBalance: avgBal ? money(avgBal) : null,
    },
    txns,
    checks
  );
}

// ---------------------------------------------------------------- Era B

const SUMMARY_LABELS: [string, RegExp][] = [
  ['begin', /^Balance Last Statement$/],
  ['debits', /^Total Debits This Period$/],
  ['credits', /^Total Credits This Period$/],
  ['accrued', /^Interest Accrued This Period$/],
  ['interest', /^Interest Credited This Period$/],
  ['ytd', /^Interest Credited Year-to-Date$/],
  ['ending', /^Ending Balance$/],
  ['rate', /^Annual Interest Rate\*?$/],
  ['apy', /^Annual Percentage Yield \(APY\)\*?$/],
];

/** Lines that start a page break inside the activity table; everything up
 * to the next column header ("Date Transactions Debits Credits Balance")
 * is page furniture or the back-page notice. */
const PAGE_BREAK = /TAMXDS\d+|^Page \d+ of \d+$|^In Case of Errors/;

function parseEraB(text: string, lines: string[]): ParsedStatement {
  const per = text.match(/Statement Period: ([A-Za-z]+ \d{1,2}, \d{4}) - ([A-Za-z]+ \d{1,2}, \d{4})/);
  if (!per) throw new UnreadableStatement('No statement period');
  const periodStart = longDate(per[1]);
  const stmt = longDate(per[2]);
  const days = Number(text.match(/Number of Days in Statement Period: (\d+)/)?.[1] ?? NaN);
  const prod = text.match(new RegExp(String.raw`^(.+?) x+(\d{4}) (${AMT})$`, 'm'));
  if (!prod) throw new UnreadableStatement('No account line');
  const product = prod[1].trim();
  const last4 = prod[2];
  const holders = text.match(/^Account Owner\(s\): (.+)$/m)?.[1]?.trim() ?? text.match(/^Account Statement For:\n(.+)$/m)?.[1]?.trim() ?? null;

  // ---- Account Summary (inline, else columnar) ----
  const sumStart = lines.findIndex((l) => l === 'Account Summary');
  const sumEnd = lines.findIndex((l, i) => i > sumStart && (/^Account Activity/.test(l) || PAGE_BREAK.test(l)));
  if (sumStart < 0) throw new UnreadableStatement('No account summary');
  const sec = lines.slice(sumStart + 1, sumEnd < 0 ? undefined : sumEnd);
  const vals: Record<string, number> = {};
  const DATED = String.raw`(?:\d{1,2}\/\d{1,2}\/\d{4} )?`;
  for (const [key, re] of SUMMARY_LABELS) {
    const label = re.source.slice(1, -1);
    const m = sec.join('\n').match(new RegExp(String.raw`^${DATED}${label} (${AMT}|[\d.]+%)$`, 'm'));
    if (m) vals[key] = m[1].endsWith('%') ? Number(m[1].slice(0, -1)) : money(m[1]);
  }
  if (vals.begin === undefined) {
    // Columnar: labels in order, then dollar values (and percent values) in
    // the same order, after the account's own header line.
    const labels = sec.map((l) => SUMMARY_LABELS.find(([, re]) => re.test(l))?.[0]).filter((k): k is string => !!k);
    const hdr = sec.findIndex((l) => new RegExp(String.raw`^.+ x+${last4}$|^.+: x+${last4}$`).test(l));
    if (hdr < 0) throw new UnreadableStatement('No account header in summary');
    const dollars: number[] = [];
    const pcts: number[] = [];
    for (const l of sec.slice(hdr + 1)) {
      const d = l.match(new RegExp(String.raw`^${DATED}(${AMT})$`));
      if (d) dollars.push(money(d[1]));
      const p = l.match(/^([\d.]+)%$/);
      if (p) pcts.push(Number(p[1]));
    }
    const moneyLabels = labels.filter((k) => k !== 'rate' && k !== 'apy');
    const pctLabels = labels.filter((k) => k === 'rate' || k === 'apy');
    if (dollars.length !== moneyLabels.length) throw new UnreadableStatement(`Summary has ${moneyLabels.length} labels but ${dollars.length} values`);
    moneyLabels.forEach((k, i) => (vals[k] = dollars[i]));
    if (pcts.length === pctLabels.length) pctLabels.forEach((k, i) => (vals[k] = pcts[i]));
  }
  for (const k of ['begin', 'debits', 'credits', 'interest', 'ending']) if (vals[k] === undefined) throw new UnreadableStatement(`Summary missing ${k}`);
  const apyEarnedRaw = text.match(/^Annual Percentage Yield Earned(?: This Period)? ([\d.]+)%$/m)?.[1];

  // ---- Account Activity ----
  const txns: RawTxn[] = [];
  let beginRow: number | null = null;
  let endRow: number | null = null;
  let pending: { date: string; type: string; desc: string[] } | null = null;
  let skipping = false;
  const actStart = lines.findIndex((l) => l === 'Account Activity');
  if (actStart < 0) throw new UnreadableStatement('No account activity');
  for (let i = actStart + 1; i < lines.length; i++) {
    const l = lines[i];
    if (skipping) {
      if (/^Date Transactions Debits Credits Balance$/.test(l)) skipping = false;
      continue;
    }
    if (PAGE_BREAK.test(l)) {
      skipping = true;
      continue;
    }
    if (/^Date Transactions Debits Credits Balance$/.test(l) || !l) continue;
    const d = l.match(/^(\d{2}\/\d{2}\/\d{4}) (.+)$/);
    if (d && !pending) {
      const rest = d[2];
      const bal = rest.match(new RegExp(String.raw`^(Beginning|Ending) Balance (${AMT})$`));
      if (bal) {
        if (bal[1] === 'Beginning') beginRow = money(bal[2]);
        else {
          endRow = money(bal[2]);
          break;
        }
        continue;
      }
      const one = rest.match(new RegExp(String.raw`^(.*?) (${AMT}) (${AMT})$`));
      if (one) txns.push({ date: mdy(d[1]), type: one[1].trim(), desc: [], amount: money(one[2]), balance: money(one[3]) });
      else pending = { date: mdy(d[1]), type: rest.trim(), desc: [] };
      continue;
    }
    if (pending) {
      const a = l.match(new RegExp(String.raw`^(${AMT}) (${AMT})$`));
      if (a) {
        txns.push({ ...pending, amount: money(a[1]), balance: money(a[2]) });
        pending = null;
      } else pending.desc.push(l.replace(/\s+/g, ' ').trim());
    }
  }
  if (pending) throw new UnreadableStatement(`Unfinished activity row ${pending.date} ${pending.type}`);
  if (beginRow === null || endRow === null) throw new UnreadableStatement('No beginning/ending balance rows');

  // One amount column: the running balance says which way each row went.
  const checks: StatementCheck[] = [];
  let running = beginRow;
  let chainOk = true;
  let chainDetail = `${txns.length} rows`;
  for (const t of txns) {
    const bal = t.balance as number;
    if (cents(running + t.amount, bal)) running = bal;
    else if (cents(running - t.amount, bal)) {
      t.amount = -t.amount;
      running = bal;
    } else {
      chainOk = false;
      chainDetail = `${t.date} ${t.type}: ${fmtMoney(running)} ± ${fmtMoney(t.amount)} ≠ printed ${fmtMoney(bal)}`;
      running = bal;
    }
  }
  checks.push(check('Running balance', chainOk, chainDetail));
  checks.push(check('Beginning row', cents(beginRow, vals.begin), `${fmtMoney(beginRow)} vs ${fmtMoney(vals.begin)}`));
  checks.push(check('Ending row', cents(endRow, vals.ending), `${fmtMoney(endRow)} vs ${fmtMoney(vals.ending)}`));
  checks.push(check('Account line matches ending', cents(money(prod[3]), vals.ending), `${prod[3]} vs ${fmtMoney(vals.ending)}`));
  if (Number.isFinite(days)) {
    const span = Math.round((Date.parse(stmt) - Date.parse(periodStart)) / 86400000) + 1;
    checks.push(check('Days in period', span === days, `${span} vs printed ${days}`));
  }
  return finish(
    {
      era: 'B',
      statementDate: stmt,
      periodStart,
      days: Number.isFinite(days) ? days : null,
      last4,
      product,
      holders,
      beginning: vals.begin,
      credits: vals.credits,
      debits: Math.abs(vals.debits),
      interest: vals.interest,
      interestYtd: vals.ytd ?? null,
      ending: vals.ending,
      apyEarned: apyEarnedRaw ? Number(apyEarnedRaw) : null,
      apy: vals.apy ?? null,
      rate: vals.rate ?? null,
      avgBalance: null,
    },
    txns,
    checks
  );
}

export function parseAmexBank(text: string): ParsedStatement {
  if (!text.trim()) throw new UnreadableStatement('No text (image-only scan)');
  const lines = text.split('\n').map((l) => l.trim());
  if (/^Statement of Account$/m.test(text) && /This statement:/.test(text)) return parseEraA(text, lines);
  if (/Account Statement For:/.test(text) && /Statement Period:/.test(text)) return parseEraB(text, lines);
  throw new UnreadableStatement('Not an American Express Bank savings statement');
}

/** Statement-to-statement checks: beginning = previous ending (when the
 * periods touch), and interest YTD carries forward (resets in January). */
export function crossCheckAmexBank(prev: { values: AmexBankValues } | null, cur: { values: AmexBankValues }): StatementCheck[] {
  if (!prev) return [];
  const out: StatementCheck[] = [];
  const p = prev.values;
  const c = cur.values;
  // A missing statement in between is flagged on its own.
  const gapDays = Math.round((Date.parse(c.periodStart) - Date.parse(p.statementDate)) / 86400000);
  if (gapDays > 1) return [];
  out.push(check('Carries from last statement', cents(p.ending, c.beginning), `previous ending ${fmtMoney(p.ending)} vs beginning ${fmtMoney(c.beginning)}`));
  if (c.interestYtd !== null && p.interestYtd !== null) {
    const newYear = c.statementDate.slice(0, 4) !== p.statementDate.slice(0, 4);
    const expect = round2((newYear ? 0 : p.interestYtd) + c.interest);
    out.push(check('Interest YTD', cents(expect, c.interestYtd), `${fmtMoney(expect)} vs printed ${fmtMoney(c.interestYtd)}`));
  }
  return out;
}
