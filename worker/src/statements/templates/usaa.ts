import { check, cents, fmtMoney, round2, UnreadableStatement } from '../common';
import type { ParsedStatement, ParsedTransaction, StatementCheck } from '../common';

/** Template — USAA Federal Savings Bank checking (Mike's main checking
 * account), Drive folder "USAA Checking Account", files
 * "USAA FSB - YYYY.MM.DD.pdf" (Nov 2007 → today, one a month). One account
 * per statement, keyed by its last 4 digits (the full number is never
 * stored). Two layouts:
 *
 *  classic (Nov 2007 → Jan 2021) — a columnar summary line (balance last
 *    statement · no. of debits · total debits · no. of deposits · total
 *    deposits · service charges · balance this statement), then sections
 *    DEPOSITS AND OTHER CREDITS / CHECKS / OTHER DEBITS / ACCOUNT BALANCE
 *    SUMMARY (end-of-day balances) and the interest paragraph (APY earned,
 *    YTD interest). pdf.js often reads these letter by letter
 *    ("0 8 / 2 9 2 , 0 1 6 . 7 3"), so dates and amounts are matched with
 *    optional spaces and the summary line is split by its own arithmetic.
 *  modern (Feb 2021 → today) — "Activity Summary" block, a fees table, and
 *    "Transactions" rows `MM/DD description…` ending with
 *    `<debit|0> <credit|0> <running balance>` spread over a few lines.
 *
 * Every number is checked by arithmetic (summary, row totals and counts,
 * running / end-of-day balances); nothing is guessed. See
 * docs/statement-templates/usaa.md. */

export type UsaaTxnKind = 'deposit' | 'interest' | 'transfer_in' | 'transfer_out' | 'payment' | 'withdrawal' | 'fee';

export interface UsaaValues {
  era: 'classic' | 'modern';
  statementDate: string;
  periodStart: string;
  periodEnd: string;
  last4: string;
  product: string | null; // "USAA Classic Checking"
  holder: string | null;
  beginning: number;
  credits: number; // deposits and other credits, interest included (as printed)
  creditCount: number | null;
  debits: number; // withdrawals and other debits (positive)
  debitCount: number | null;
  serviceCharges: number;
  ending: number;
  interest: number;
  interestYtd: number | null; // classic only
  apy: number | null; // annual percentage yield earned, percent
  days: number | null;
  avgDailyBalance: number | null;
  lowBalance: number | null;
  lowDate: string | null;
  odFees: number | null; // modern fees table (null = "N/A")
  odFeesYtd: number | null;
  nsfFees: number | null;
  nsfFeesYtd: number | null;
  checks: { number: string; date: string; amount: number }[];
  /** Wallet bank-account shape (see paymentCards statementAccountsByLast4). */
  accounts: { last4: string; kind: 'checking'; product: string | null; holders: string | null; ending: number; apy: number | null }[];
}

interface RawRow {
  date: string; // YYYY-MM-DD
  type: string; // first line, as printed
  desc: string[];
  amount: number; // + credit, − debit
  balance: number | null; // modern only
  check?: string;
}

// ------------------------------------------------------------- helpers --

const MONEY = /^-?\d{1,3}(?:,\d{3})*\.\d{2}$/;
const num = (s: string) => {
  const neg = s.includes('-');
  const n = Number(s.replace(/[^0-9.]/g, ''));
  return neg ? -n : n;
};
const despace = (s: string) => s.replace(/\s+/g, '');
const titleCase = (s: string) =>
  s
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/\bUsaa\b/g, 'USAA')
    .replace(/\bAch\b/g, 'ACH')
    .replace(/\bAtm\b/g, 'ATM')
    .replace(/\bNsf\b/g, 'NSF');

/** "N i s s a n A u t o L e a s e" → "NissanAutoLease"; normal words stay. */
export function unspaceLetters(s: string): string {
  return s
    .replace(/(?:\b\S ){3,}\S\b/g, (run) => run.replace(/ /g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Year for an MM/DD inside a statement that ends on `end` (YYYY-MM-DD). */
function withYear(mmdd: string, end: string): string {
  const [m, d] = mmdd.split('/');
  let y = Number(end.slice(0, 4));
  if (Number(m) > Number(end.slice(5, 7))) y -= 1;
  return `${y}-${m}-${d}`;
}

const mdyFull = (s: string) => {
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) throw new UnreadableStatement(`Not a date: "${s}"`);
  return `${m[3]}-${m[1]}-${m[2]}`;
};

/** Description cleanup: drop masked account strings and long reference
 * numbers, join the lines. */
export function cleanUsaaDesc(parts: string[]): string {
  return unspaceLetters(parts.join(' '))
    .replace(/(?:\*\s?){4,}\s*(?:\S\s?){0,4}$/g, ' ')
    .replace(/(?:\*\s?){4,}\s*\S*/g, ' ')
    .replace(/\b\d{7,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The printed transaction type → a tidy label ("ACH DEBIT 031522" →
 * "ACH Withdrawal"). */
export function typeLabel(raw: string): string {
  const t = unspaceLetters(raw)
    .replace(/\s+\d{6}(\s+\d+)?$/, '')
    .trim()
    .toUpperCase();
  if (/^ACH (CREDIT|DEP)/.test(t)) return 'ACH Deposit';
  if (/^ACH (DEBIT|WITHDRAWAL)/.test(t)) return 'ACH Withdrawal';
  if (/^(IOD )?INTEREST PAID/.test(t)) return 'Interest Paid';
  if (/^CHECK\b/.test(t)) return 'Check';
  return titleCase(t);
}

/** Normalized kind from the type + description and the sign. */
export function usaaKind(type: string, desc: string, amount: number): UsaaTxnKind {
  const u = `${type} ${desc}`.toUpperCase();
  // Promotional credits are paid as interest (they count in USAA's YTD interest).
  if (/INTEREST PAID|PROMOTIONAL CREDIT/.test(u)) return 'interest';
  if (amount < 0 && (/\bFEE\b|SERVICE CHARGE|OD CHARGE|\bNSF\b|OVERDRAFT CHARGE/.test(u))) return 'fee';
  // Mike's own accounts elsewhere: USAA savings, Ally, Amex savings, Schwab, Robinhood, PayPal balance.
  if (/USAA FUNDS TRANSFER|FUNDS TRANSFER (CR|DB)|ALLY BANK|AMERICAN ?EXPRESS TRANSFER|SCHWAB BANK|ROBINHOOD|REQUESTED TRANSFER|PAYPAL TRANSFER/.test(u)) {
    return amount >= 0 ? 'transfer_in' : 'transfer_out';
  }
  if (amount < 0 && /CREDIT CARD WEB PYMT|U\.?S\.? BANK WEB PYMT|HOME DEPOT ONLINE PMT|SYF PAYM|CREDIT CARD PAY|CREDIT CRD|EPAYMENT|E-PAYMENT|CARDMEMBER SERV|CARD SRVC|CCPYMT|VI\/MC|CREDIT CARD PMT|CREDITCARD|DISCOVER|CAPITAL ONE|CAP ONE|BARCLAYCARD|CHG PYMT|CRCARDPMT|AMEX|CITI CARD|SYNCHRONY|CARD ONLINE PMT/.test(u)) return 'payment';
  return amount >= 0 ? 'deposit' : 'withdrawal';
}

/** Time-weighted average and lowest end-of-day balance over the period. */
function balanceStats(start: string, end: string, begin: number, eod: [string, number][]) {
  const sorted = [...eod].sort((a, b) => a[0].localeCompare(b[0]));
  let bal = begin;
  let i = 0;
  let total = 0;
  let days = 0;
  let low = Number.POSITIVE_INFINITY;
  let lowDate: string | null = null;
  for (let t = Date.parse(`${start}T12:00:00Z`) + 86400000; t <= Date.parse(`${end}T12:00:00Z`); t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10);
    while (i < sorted.length && sorted[i][0] <= d) bal = sorted[i++][1];
    total += bal;
    days++;
    if (bal < low) {
      low = bal;
      lowDate = d;
    }
  }
  if (!days) return { avg: null, low: null, lowDate: null };
  return { avg: round2(total / days), low: round2(low), lowDate };
}

// ------------------------------------------------------------- classic --

const NOISE_CLASSIC = [
  /^USAA$/,
  /^FEDERAL$/,
  /^SAVINGS$/,
  /^BANK$/,
  /^ACCOUNT NUMBER/,
  /^P\s?A\s?G\s?E\s+\d/,
  /^PAGE \d/,
  /USAA FEDERAL SAVINGS BANK/,
  /^10750 McDermott/,
  /^San Antonio/,
  /^\d{3}-\d{3}-\d{4}$/,
  /^PLEASE EXAMINE/,
  /^In Case of Errors/i,
  /^THIS FORM IS PROVIDED/,
  /^\d[\d ]*-\s?\d[\d ]*_\s?\d/, // form ids "9 3 5 2 6 - 0 8 1 4 _ 0 5"
  /^\d{5,6}-\d{4}$/,
  /^BM\w+$/,
  /^[\d ]{1,3}$/,
  /^C\s?h\s?e\s?c\s?k\s?:/,
  /^NO OF/,
  /TOTAL AMOUNT/,
  /LAST STATEMENT/,
  /STATEMENT DATE/,
  /^\*[\s*]*(I\s?N\s?T|U\s?S\s?A\s?A)/,
  /^D\s?A\s?T\s?E\s?\.\s?\./,
  /^[\d ]{4,14}-[\d ]{4,8}-\s?\d$/, // account number
];
const isNoiseClassic = (l: string) => NOISE_CLASSIC.some((r) => r.test(l));

const ROW_CLASSIC = /^(\d)\s?(\d)\s?\/\s?(\d)\s?(\d)\s+([\d ,]*\.\s?\d\s?\d)(\s?-)?(?:\s+(.*))?$/;

/** The summary line's seven numbers, split by its own arithmetic
 * (last − debits + deposits − charges = balance). Letter-spaced PDFs run
 * the counts into the amounts ("17 5,307.96" → "175,307.96"), so every
 * split is tried. */
export function splitClassicSummary(line: string): { last: number; nDebits: number; debits: number; nDeposits: number; deposits: number; charges: number; balance: number }[] {
  const s = despace(line);
  const out: ReturnType<typeof splitClassicSummary> = [];
  const moneyAt = (i: number) => {
    const res: { v: string; next: number }[] = [];
    const m = s.slice(i).match(/^(-?\d{0,3}(?:,\d{3})*\.\d{2}-?)/);
    if (m && /\d|^\.\d\d/.test(m[1])) {
      // all prefixes ending in .dd — there's only one '.' per amount, so the match is it
      res.push({ v: m[1], next: i + m[1].length });
    }
    return res;
  };
  const intsAt = (i: number) => {
    const res: { v: number; next: number }[] = [];
    for (let k = 1; k <= 4 && i + k <= s.length; k++) {
      const v = s.slice(i, i + k);
      if (!/^\d+$/.test(v)) break;
      res.push({ v: Number(v), next: i + k });
    }
    return res;
  };
  // The first amount's digits can't be split off a preceding count, but each
  // amount's leading digits may belong to the count before it — so when an
  // amount follows a count, try every start position.
  const amountsFrom = (i: number) => moneyAt(i);
  for (const last of amountsFrom(0)) {
    for (const nd of intsAt(last.next)) {
      for (const deb of amountsFrom(nd.next)) {
        for (const np of intsAt(deb.next)) {
          for (const dep of amountsFrom(np.next)) {
            for (const chg of amountsFrom(dep.next)) {
              for (const bal of amountsFrom(chg.next)) {
                if (bal.next !== s.length) continue;
                const v = { last: num(last.v), nDebits: nd.v, debits: num(deb.v), nDeposits: np.v, deposits: num(dep.v), charges: num(chg.v), balance: num(bal.v) };
                if (![last.v, deb.v, dep.v, chg.v, bal.v].every((x) => /^-?(\d{1,3}(,\d{3})*)?\.\d\d-?$/.test(x))) continue;
                if (!cents(v.last - v.debits + v.deposits - v.charges, v.balance)) continue;
                out.push(v);
              }
            }
          }
        }
      }
    }
  }
  return out;
}

/** One CHECKS line: 1–2 entries "MM/DD NNNN[*] amount", letter-spaced or not. */
export function parseCheckLine(line: string): { mmdd: string; number: string; amount: number }[] {
  // Page text can run onto the same line ("… 1 4 . 7 5 Note: Fee reversals …").
  const s = despace(line.replace(/[A-Za-z].*$/, ''));
  const starts = [...s.matchAll(/\d\d\/\d\d/g)].map((m) => m.index!);
  const out: { mmdd: string; number: string; amount: number }[] = [];
  starts.forEach((st, k) => {
    const body = s.slice(st + 5, k + 1 < starts.length ? starts[k + 1] : s.length);
    const mmdd = s.slice(st, st + 5);
    if (body.includes('*')) {
      const [no, amt] = body.split('*');
      if (/^\d+$/.test(no) && MONEY.test(amt)) out.push({ mmdd, number: no, amount: num(amt) });
      return;
    }
    for (const k of [4, 3, 2, 5, 6, 1]) {
      const no = body.slice(0, k);
      const amt = body.slice(k);
      if (/^\d+$/.test(no) && MONEY.test(amt) && !/^0\d/.test(amt)) {
        out.push({ mmdd, number: no, amount: num(amt) });
        return;
      }
    }
  });
  return out;
}

function parseClassic(text: string): ParsedStatement {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  // Statement date: the first spaced MM/DD/YY that isn't the period-start line.
  let statementDate: string | null = null;
  for (const l of lines.slice(0, 60)) {
    const m = l.match(/(\d)\s?(\d)\s?\/\s?(\d)\s?(\d)\s?\/\s?(\d)\s?(\d)$/);
    if (m) {
      statementDate = `20${m[5]}${m[6]}-${m[1]}${m[2]}-${m[3]}${m[4]}`;
      break;
    }
  }
  if (!statementDate) throw new UnreadableStatement('No statement date');
  // Account number line "NNNNN-NNNN-N" (letter-spaced in older PDFs).
  const acctLine = lines.slice(0, 60).map(despace).find((l) => /^\d{4,7}-\d{4}-\d$/.test(l));
  if (!acctLine) throw new UnreadableStatement('No account number');
  const last4 = acctLine.replace(/-/g, '').slice(-4);
  const product = (() => {
    const l = lines.slice(0, 60).find((x) => /\bCHECKING\b/.test(x) && /^(USAA|FOUR STAR)/.test(x));
    const m = l?.match(/^((?:USAA|FOUR STAR)[A-Z ]*?CHECKING)/);
    return m ? titleCase(m[1]) : null;
  })();
  const holder = lines.slice(0, 60).find((l) => /^[A-Z]+ [A-Z] [A-Z]+$/.test(l)) ?? null;

  // Summary line: digits / commas / dots only, with ≥ 4 decimals.
  let summary: ReturnType<typeof splitClassicSummary>[number] | null = null;
  let candidates: ReturnType<typeof splitClassicSummary> = [];
  for (const l of lines.slice(0, 80)) {
    if (!/^[\d ,.\-]+$/.test(l) || (l.match(/\./g) ?? []).length < 4) continue;
    candidates = splitClassicSummary(l);
    if (candidates.length) break;
  }

  // ---- Sections ----
  type Sec = 'credits' | 'checks' | 'debits' | 'balances' | null;
  let sec: Sec = null;
  const rows: RawRow[] = [];
  const checksList: { number: string; date: string; amount: number }[] = [];
  const eod: [string, number][] = [];
  let cur: RawRow | null = null;
  let contLeft = 0;
  for (const l of lines) {
    const flat = despace(l);
    if (/^DEPOSITSANDOTHERCREDITS$/.test(flat)) {
      sec = 'credits';
      cur = null;
      continue;
    }
    if (/^CHECKS$/.test(flat)) {
      sec = 'checks';
      cur = null;
      continue;
    }
    if (/^OTHERDEBITS$/.test(flat)) {
      sec = 'debits';
      cur = null;
      continue;
    }
    if (/^ACCOUNTBALANCESUMMARY$/.test(flat)) {
      sec = 'balances';
      cur = null;
      continue;
    }
    if (/INTERESTPAIDINFORMATION|REWARDSPROGRAM/.test(flat)) {
      sec = null;
      cur = null;
      continue;
    }
    if (!sec) continue;
    if (sec === 'balances') {
      // "158.39OD" = overdrawn (negative).
      for (const m of flat.matchAll(/(\d\d\/\d\d)(-?\d{1,3}(?:,\d{3})*\.\d\d)(OD|-)?/g)) eod.push([withYear(m[1], statementDate), num(m[2]) * (m[3] ? -1 : 1)]);
      continue;
    }
    if (sec === 'checks') {
      if (/^\d\s?\d\s?\//.test(l)) {
        for (const c of parseCheckLine(l)) {
          const date = withYear(c.mmdd, statementDate);
          checksList.push({ number: c.number, date, amount: c.amount });
          rows.push({ date, type: `Check #${c.number}`, desc: [], amount: -c.amount, balance: null, check: c.number });
        }
      }
      continue;
    }
    const m = l.match(ROW_CLASSIC);
    if (m) {
      const amt = despace(m[5]);
      if (!MONEY.test(amt) && !/^\.\d\d$/.test(amt)) throw new UnreadableStatement(`Bad amount "${m[5]}" in "${l}"`);
      const v = num(amt) * (m[6] ? -1 : 1);
      cur = { date: withYear(`${m[1]}${m[2]}/${m[3]}${m[4]}`, statementDate), type: (m[7] ?? '').trim(), desc: [], amount: sec === 'credits' ? v : -v, balance: null };
      rows.push(cur);
      contLeft = 3;
      continue;
    }
    if (cur && contLeft > 0 && !isNoiseClassic(l)) {
      cur.desc.push(l);
      contLeft--;
    } else {
      cur = null;
    }
  }
  if (!rows.length && !eod.length) throw new UnreadableStatement('No activity sections');

  const credits = rows.filter((r) => r.amount > 0);
  const debits = rows.filter((r) => r.amount < 0);
  const sumCredits = round2(credits.reduce((s, r) => s + r.amount, 0));
  const sumDebits = round2(-debits.reduce((s, r) => s + r.amount, 0));
  // Pick the summary split that agrees with the rows (counts first, then totals).
  summary =
    candidates.find((c) => c.nDeposits === credits.length && c.nDebits === debits.length) ??
    candidates.find((c) => cents(c.deposits, sumCredits) && cents(c.debits, sumDebits)) ??
    candidates[0] ??
    null;
  if (!summary) throw new UnreadableStatement('No summary line');

  eod.sort((a, b) => a[0].localeCompare(b[0]));
  const periodStart = eod[0]?.[0] ?? statementDate;
  const interest = round2(rows.filter((r) => /INTERESTPAID|PROMOTIONALCREDIT/i.test(despace(r.type))).reduce((s, r) => s + r.amount, 0));
  const flatText = despace(text);
  const apyM = flatText.match(/YIELDEARNEDOF(\d+\.\d+)%/);
  const ytdM = flatText.match(/YTDINTERESTPAIDTO(\d{0,3}(?:,\d{3})*\.\d\d)/);
  const daysM = flatText.match(/BALANCEFOR(\d+)DAYS/);
  const stats = balanceStats(periodStart, statementDate, summary.last, eod.slice(1));

  const checks: StatementCheck[] = [];
  checks.push(check('Summary adds up', true, `${fmtMoney(summary.last)} − ${fmtMoney(summary.debits)} + ${fmtMoney(summary.deposits)} − ${fmtMoney(summary.charges)} = ${fmtMoney(summary.balance)}`));
  checks.push(check('Credits match', cents(sumCredits, summary.deposits), `rows ${fmtMoney(sumCredits)} vs summary ${fmtMoney(summary.deposits)}`));
  checks.push(check('Debits match', cents(sumDebits, summary.debits), `rows ${fmtMoney(sumDebits)} vs summary ${fmtMoney(summary.debits)}`));
  if (eod.length) {
    checks.push(check('Balance summary starts at last balance', cents(eod[0][1], summary.last), `${fmtMoney(eod[0][1])} vs ${fmtMoney(summary.last)}`));
    checks.push(check('Balance summary ends at balance', cents(eod[eod.length - 1][1], summary.balance), `${fmtMoney(eod[eod.length - 1][1])} vs ${fmtMoney(summary.balance)}`));
    // Each end-of-day balance = the previous one + that stretch's rows.
    let ok = true;
    let detail = `${eod.length} days`;
    let bal = eod[0][1];
    for (let k = 1; k < eod.length && ok; k++) {
      const moved = rows.filter((r) => r.date > eod[k - 1][0] && r.date <= eod[k][0]).reduce((s, r) => s + r.amount, 0);
      bal = round2(bal + moved);
      if (!cents(bal, eod[k][1])) {
        ok = false;
        detail = `${eod[k][0]}: rows give ${fmtMoney(bal)}, printed ${fmtMoney(eod[k][1])}`;
      }
      bal = eod[k][1];
    }
    checks.push(check('End-of-day balances', ok, detail));
  }

  const values: UsaaValues = {
    era: 'classic',
    statementDate,
    periodStart,
    periodEnd: statementDate,
    last4,
    product,
    holder: holder ? titleCase(holder) : null,
    beginning: summary.last,
    credits: summary.deposits,
    creditCount: summary.nDeposits,
    debits: summary.debits,
    debitCount: summary.nDebits,
    serviceCharges: summary.charges,
    ending: summary.balance,
    interest,
    interestYtd: ytdM ? num(ytdM[1]) : null,
    apy: apyM ? Number(apyM[1]) : null,
    days: daysM ? Number(daysM[1]) : null,
    avgDailyBalance: stats.avg,
    lowBalance: stats.low,
    lowDate: stats.lowDate,
    odFees: null,
    odFeesYtd: null,
    nsfFees: null,
    nsfFeesYtd: null,
    checks: checksList,
    accounts: [],
  };
  return finish(values, rows, checks);
}

// -------------------------------------------------------------- modern --

const NOISE_MODERN = [
  /^Page \d+ of \d+/,
  /^USAA [A-Z ]*CHECKING$/,
  /^for Account Number:/,
  /^Statement Period:/,
  /^Online: usaa\.com/,
  /^\d{9}( - [A-Z]+-\d+)? \d{6}-\d{4}$/,
  /^\d{6}-\d{4}$/,
  /^Transactions( \(continued\))?$/,
  /^Date Description Debits Credits Balance$/,
  /USAA_DOCUMENT_BREAK/,
  /^0000\.0000/,
  /^continued on next page/,
  /^!##@MDATA/,
];
const isNoiseModern = (l: string) => NOISE_MODERN.some((r) => r.test(l));
const AMT_M = String.raw`-?\$[\d,]+\.\d{2}`;
const moneyM = (s: string) => num(s.replace('$', ''));

function parseModern(text: string): ParsedStatement {
  const get = (re: RegExp) => text.match(re)?.[1] ?? null;
  const period = text.match(/Statement Period: (\d{2}\/\d{2}\/\d{4}) to (\d{2}\/\d{2}\/\d{4})/);
  if (!period) throw new UnreadableStatement('No statement period');
  const periodStart = mdyFull(period[1]);
  const periodEnd = mdyFull(period[2]);
  const acct = get(/for Account Number: (\d+)/);
  if (!acct) throw new UnreadableStatement('No account number');
  const last4 = acct.slice(-4);
  const productM = text.match(/^(USAA [A-Z ]+)\n(CHECKING)$/m);
  const product = productM ? titleCase(`${productM[1]} ${productM[2]}`) : null;
  const pIdx = text.split('\n').findIndex((l) => /^Statement Period:/.test(l.trim()));
  const holderLine = pIdx >= 0 ? text.split('\n')[pIdx + 1] ?? null : null;
  const field = (re: RegExp) => {
    const m = text.match(re);
    if (!m) throw new UnreadableStatement(`Missing ${re}`);
    return m;
  };
  const beginning = moneyM(field(new RegExp(String.raw`^Beginning Balance (${AMT_M})$`, 'm'))[1]);
  const credM = field(new RegExp(String.raw`^(\d+) Deposits\/Credits (${AMT_M})$`, 'm'));
  const debM = field(new RegExp(String.raw`^(\d+) Withdrawals\/Debits (${AMT_M})$`, 'm'));
  const svc = moneyM(field(new RegExp(String.raw`^Service Charges and ATM Service Fee (${AMT_M})$`, 'm'))[1]);
  const ending = moneyM(field(new RegExp(String.raw`^Ending Balance (${AMT_M})$`, 'm'))[1]);
  const feeRow = (label: string) => {
    const m = text.match(new RegExp(String.raw`^Total ${label} Fees (\S+) (\S+)$`, 'm'));
    const v = (s: string | undefined) => (!s || s === 'N/A' ? null : moneyM(s));
    return [v(m?.[1]), v(m?.[2])] as const;
  };
  const [odFees, odFeesYtd] = feeRow(String.raw`Overdraft \(OD\)`);
  const [nsfFees, nsfFeesYtd] = feeRow(String.raw`Non-Sufficient Funds \(NSF\)`);

  // ---- Transaction rows ----
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const startIdx = lines.findIndex((l) => l === 'Transactions');
  const endIdx = lines.findIndex((l, i) => i > startIdx && /^Interest Paid Information$/.test(l));
  const body = lines.slice(startIdx + 1, endIdx > 0 ? endIdx : undefined).filter((l) => !isNoiseModern(l));
  const groups: { mmdd: string; parts: string[] }[] = [];
  for (const l of body) {
    const m = l.match(/^(\d{2}\/\d{2})(?:\s+(.*))?$/);
    if (m) groups.push({ mmdd: m[1], parts: m[2] ? [m[2]] : [] });
    else if (groups.length) groups[groups.length - 1].parts.push(l);
  }
  const dateOf = (mmdd: string) => {
    const [mm, dd] = mmdd.split('/');
    const y1 = periodStart.slice(0, 4);
    const d1 = `${y1}-${mm}-${dd}`;
    return d1 >= periodStart ? d1 : `${periodEnd.slice(0, 4)}-${mm}-${dd}`;
  };
  const rows: RawRow[] = [];
  const checksList: { number: string; date: string; amount: number }[] = [];
  let beginningRow: number | null = null;
  let endingRow: number | null = null;
  for (const g of groups) {
    const joined = g.parts.join(' ').replace(/\s+/g, ' ').trim();
    if (/^Beginning Balance\b/.test(joined)) {
      const m = joined.match(new RegExp(String.raw`(${AMT_M})$`));
      beginningRow = m ? moneyM(m[1]) : null;
      continue;
    }
    if (/^Ending Balance\b/.test(joined)) {
      const m = joined.match(new RegExp(String.raw`(${AMT_M})$`));
      endingRow = m ? moneyM(m[1]) : null;
      continue;
    }
    const m = joined.match(new RegExp(String.raw`^(.*?)\s*(${AMT_M}|0)\s+(${AMT_M}|0)\s+(${AMT_M})$`));
    if (!m) throw new UnreadableStatement(`Can’t read the row ${g.mmdd} “${joined.slice(0, 60)}”`);
    const debit = m[2] === '0' ? 0 : moneyM(m[2]);
    const credit = m[3] === '0' ? 0 : moneyM(m[3]);
    const date = dateOf(g.mmdd);
    const words = m[1];
    const chk = words.match(/^CHECK # ?(\d+)/i);
    // First printed line is the type; the rest is the description.
    const firstLine = g.parts[0] ?? '';
    const type = chk ? `Check #${chk[1]}` : firstLine.replace(new RegExp(String.raw`\s*(${AMT_M}|0)(\s+(${AMT_M}|0))*$`), '').trim();
    const rest = chk ? [] : g.parts.slice(1).map((p) => p.replace(new RegExp(String.raw`\s*(${AMT_M}|0)(\s+(${AMT_M}|0))*$`), '').trim()).filter((p) => p && p !== '0');
    if (chk) checksList.push({ number: chk[1], date, amount: debit });
    rows.push({ date, type, desc: rest, amount: round2(credit - debit), balance: moneyM(m[4]), check: chk?.[1] });
  }

  // Rows aren't always printed in date order (2021-05 lists 04/16 items
  // last), so put them in date order first (stable within a day).
  rows.sort((a, b) => a.date.localeCompare(b.date));
  // End-of-day balances from the rows themselves (see the running check).
  const eod: [string, number][] = [];
  let runEod = beginning;
  for (const r of rows) {
    runEod = round2(runEod + r.amount);
    if (eod.length && eod[eod.length - 1][0] === r.date) eod[eod.length - 1][1] = runEod;
    else eod.push([r.date, runEod]);
  }
  const stats = balanceStats(periodStart, periodEnd, beginning, eod);
  const credits = moneyM(credM[2]);
  const debits = moneyM(debM[2]);
  const interest = round2(rows.filter((r) => /INTEREST PAID|PROMOTIONAL CREDIT/i.test(r.type)).reduce((s, r) => s + r.amount, 0));
  const apy = get(/annual percentage yield earned of ([\d.]+) ?%/i);
  const days = get(/resulting in (\d+) days/);

  const sumCredits = round2(rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0));
  const sumDebits = round2(-rows.filter((r) => r.amount < 0).reduce((s, r) => s + r.amount, 0));
  const checks: StatementCheck[] = [];
  const expectEnd = round2(beginning + credits - debits);
  checks.push(check('Summary adds up', cents(expectEnd, ending) || cents(expectEnd - svc, ending), `${fmtMoney(beginning)} + ${fmtMoney(credits)} − ${fmtMoney(debits)} = ${fmtMoney(expectEnd)} vs ending ${fmtMoney(ending)}`));
  checks.push(check('Credits match', cents(sumCredits, credits), `rows ${fmtMoney(sumCredits)} vs summary ${fmtMoney(credits)}`));
  checks.push(check('Debits match', cents(sumDebits, debits), `rows ${fmtMoney(sumDebits)} vs summary ${fmtMoney(debits)}`));
  // USAA prints each row's running balance, but rows on the same day aren't
  // always in balance order — so check day by day: after a day's rows, the
  // running total must be one of that day's printed balances.
  let running = beginningRow ?? beginning;
  let chainOk = true;
  let chainDetail = `${rows.length} rows`;
  const dayList = [...new Set(rows.map((r) => r.date))];
  for (const d of dayList) {
    const dayRows = rows.filter((r) => r.date === d);
    running = round2(running + dayRows.reduce((t, r) => t + r.amount, 0));
    if (!dayRows.some((r) => cents(r.balance!, running))) {
      chainOk = false;
      chainDetail = `${d}: rows give ${fmtMoney(running)}, printed ${dayRows.map((r) => fmtMoney(r.balance!)).join(' / ')}`;
      break;
    }
  }
  checks.push(check('Running balance', chainOk, chainDetail));
  if (beginningRow !== null) checks.push(check('Beginning row', cents(beginningRow, beginning), `${fmtMoney(beginningRow)} vs ${fmtMoney(beginning)}`));
  checks.push(check('Ending row', endingRow !== null && cents(endingRow, ending), endingRow === null ? 'no Ending Balance row' : `${fmtMoney(endingRow)} vs ${fmtMoney(ending)}`));

  const values: UsaaValues = {
    era: 'modern',
    statementDate: periodEnd,
    periodStart,
    periodEnd,
    last4,
    product,
    holder: holderLine ? titleCase(holderLine.trim()) : null,
    beginning,
    credits,
    creditCount: Number(credM[1]),
    debits,
    debitCount: Number(debM[1]),
    serviceCharges: svc,
    ending,
    interest,
    interestYtd: null,
    apy: apy ? Number(apy) : null,
    days: days ? Number(days) : null,
    avgDailyBalance: stats.avg,
    lowBalance: stats.low,
    lowDate: stats.lowDate,
    odFees,
    odFeesYtd,
    nsfFees,
    nsfFeesYtd,
    checks: checksList,
    accounts: [],
  };
  return finish(values, rows, checks);
}

function finish(values: UsaaValues, rows: RawRow[], checks: StatementCheck[]): ParsedStatement {
  values.accounts = [{ last4: values.last4, kind: 'checking', product: values.product, holders: values.holder, ending: values.ending, apy: values.apy }];
  const transactions: ParsedTransaction[] = rows.map((r) => {
    const type = r.check ? `Check #${r.check}` : typeLabel(r.type);
    const desc = r.check ? '' : cleanUsaaDesc(r.desc);
    return {
      date: r.date,
      description: desc ? `${type} · ${desc}` : type,
      kind: usaaKind(type, desc, r.amount),
      amount: r.amount,
      units: null,
      unitPrice: null,
      account: values.last4,
    };
  });
  return { periodStart: values.periodStart, periodEnd: values.periodEnd, values: values as unknown as Record<string, unknown>, transactions, checks };
}

export function parseUsaa(text: string): ParsedStatement {
  if (/^Activity Summary$/m.test(text) && /Statement Period:/.test(text)) return parseModern(text);
  const flat = despace(text);
  if (/USAA/.test(flat) && /DEPOSITSANDOTHERCREDITS|OTHERDEBITS|ACCOUNTBALANCESUMMARY/.test(flat)) return parseClassic(text);
  throw new UnreadableStatement('Not a USAA checking statement');
}

/** Statement-to-statement: the beginning balance carries from the last
 * ending balance; classic statements' YTD interest carries forward
 * (resetting in January). Skipped across a missing month. */
export function crossCheckUsaa(prev: { values: UsaaValues } | null, cur: { values: UsaaValues }): StatementCheck[] {
  if (!prev) return [];
  const mi = (iso: string) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7));
  if (mi(cur.values.periodEnd) - mi(prev.values.periodEnd) > 1) return [];
  const out = [check('Carries from last statement', cents(prev.values.ending, cur.values.beginning), `previous ending ${fmtMoney(prev.values.ending)} vs beginning ${fmtMoney(cur.values.beginning)}`)];
  if (cur.values.interestYtd !== null && prev.values.interestYtd !== null) {
    const newYear = cur.values.periodEnd.slice(0, 4) !== prev.values.periodEnd.slice(0, 4);
    const expect = round2((newYear ? 0 : prev.values.interestYtd) + cur.values.interest);
    out.push(check('Interest YTD', cents(expect, cur.values.interestYtd), `${fmtMoney(expect)} vs printed ${fmtMoney(cur.values.interestYtd)}`));
  }
  return out;
}
