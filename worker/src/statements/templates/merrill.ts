import { check, NotAStatement, round2, UnreadableStatement } from '../common';
import type { ParsedStatement, ParsedTransaction, StatementCheck } from '../common';

/** Merrill Lynch (Merrill Lynch Investment Advisory Program) — one Drive
 * folder holding:
 *  - the monthly "Wealth Management Report" PACKAGE: a few summary pages
 *    (Your Accounts, Balance Sheet, Portfolio Review, Income & Gain/(Loss)
 *    Review) followed by every linked account's own statement (CMA,
 *    rollover IRA "IRRA", Roth "RRA"). 2018 → Feb 2019 it was titled
 *    "Your Merrill Lynch Report"; same layout.
 *  - the custodial (UTMA) account's own monthly statement, saved as
 *    "Merrill Lynch - YYYY.MM.DD - Chase.pdf" → period key "<date>:chase",
 *  - Portfolio Reviews (by name → skipped; one saved under a statement's
 *    name is recognized here → NotAStatement).
 *
 * Every account section is read the same way (pdf.js text, regexes, no AI):
 * summary (opening / credits / debits / securities transferred / market /
 * closing, this period + YTD), cash flow lines (funds in, transfers, fees,
 * dividends, buys, sells), assets by type, strategy + objective, holdings
 * (equities, funds with their asset-class split, money funds, cash), equity
 * tax lots (Equity Cost Basis pages), realized gains/(losses) lot by lot,
 * buys/sells, security transfers, advisory fees, IRA rollover deposits.
 * The package pages add per-account income (taxable vs tax-exempt) and
 * realized/unrealized gains, plus the market indicators (S&P 500 level).
 *
 * Checks (by the statement's own arithmetic): opening + credits + debits +
 * transfers + market = closing per account; holdings add up to the
 * account's value; accounts add up to the package's Net Portfolio Value;
 * lots add up to their position. */

export type MlAccountType = 'ira' | 'roth' | 'cma' | 'utma';

export interface MlHolding {
  name: string;
  symbol: string | null;
  /** cash = bank deposits + cash; mmf = money market funds; equity = single
   * stocks; fund = ETFs / mutual funds / CEFs / UITs; fixed = individual bonds. */
  section: 'cash' | 'mmf' | 'equity' | 'fund' | 'fixed' | 'other';
  qty: number | null;
  cost: number | null;
  price: number | null;
  value: number;
  gain: number | null;
  income: number | null;
  /** Asset-class split of the holding (fractions summing to 1). */
  classes: { equity: number; fixed: number; cash: number; other: number };
  initialPurchase: string | null;
}

export interface MlLot {
  symbol: string;
  name: string;
  acquired: string; // YYYY-MM-DD
  qty: number;
  cost: number;
  value: number;
  gain: number;
}

export interface MlSale {
  name: string;
  qty: number;
  acquired: string | null;
  sold: string;
  proceeds: number;
  cost: number | null;
  /** null = N/C (Merrill marked it a wash sale) or N/A. */
  gain: number | null;
  washSale: boolean;
  term: 'short' | 'long' | null;
}

export interface MlAccount {
  number: string; // last 5 digits, e.g. "10704"
  type: MlAccountType;
  title: string | null;
  strategy: string | null;
  sleeves: { name: string; pct: number; rate: number | null }[];
  objective: string | null;
  opening: number;
  closing: number;
  credits: number;
  debits: number;
  transfers: number;
  market: number;
  ytd: { credits: number; debits: number; transfers: number; market: number };
  flows: {
    fundsReceived: number;
    electronicIn: number;
    otherCredits: number;
    electronicOut: number;
    otherDebits: number;
    checks: number;
    cardAndAtm: number;
    margin: number;
    fees: number;
    dividends: number;
    purchases: number;
    sales: number;
    tradingFees: number;
  };
  flowsYtd: MlAccount['flows'];
  assets: { cash: number; fixedIncome: number; equities: number; funds: number; options: number; other: number };
  holdings: MlHolding[];
  totals: { cost: number | null; value: number | null; gain: number | null; income: number | null };
  lots: MlLot[];
  sales: MlSale[];
  realized: { stThis: number; stYtd: number; ltThis: number; ltYtd: number; ltcgDistYtd: number | null } | null;
  unrealized: { st: number; lt: number } | null;
  income: { thisPeriod: MlIncome; ytd: MlIncome } | null;
  feeLines: { date: string; amount: number; desc: string }[];
  transfersIn: { date: string; name: string; qty: number; value: number }[];
  rollovers: { year: number; amount: number }[];
  yearEndValue: { date: string; value: number } | null;
  bankYield: number | null;
}

export interface MlIncome {
  taxExemptInterest: number;
  taxableInterest: number;
  taxExemptDividends: number;
  taxableDividends: number;
  total: number;
}

export interface MlValues {
  kind: 'household' | 'chase';
  era: 'merrillReport' | 'wealthReport' | 'single';
  periodStart: string;
  /** The package's Net Portfolio Value (all accounts in this PDF). */
  total: number | null;
  accounts: MlAccount[];
  market: { sp500: number | null; sp500Prev: number | null; sp500YearEnd: number | null; nasdaq: number | null; tbill3m: number | null; longTreasury: number | null };
  /** Some pages have no text (scanned) — the package summary still reads. */
  partial: boolean;
}

// ---- tokens ----

const NUM = /^\(?-?\$?[\d,]*\.?\d+\)?$/;
const isNum = (t: string) => t === '-' || NUM.test(t);

/** "1,234.56" "(404.72)" "-" ".22" "-1.0000" → number ("-" = 0). */
export function n(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const s = raw.trim();
  if (s === '-' || s === '') return 0;
  const neg = /^\(.*\)$/.test(s) || s.startsWith('-');
  const v = Number(s.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(v)) throw new UnreadableStatement(`Not a number: "${raw}"`);
  return neg ? -v : v;
}
const nOrNull = (raw: string | undefined): number | null => (raw === undefined || /^N\/[AC]$/i.test(raw.trim()) ? null : n(raw));

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function longDate(s: string): string {
  const m = s.trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (!m) throw new UnreadableStatement(`Not a date: "${s}"`);
  const mo = MONTHS.indexOf(m[1].toLowerCase());
  if (mo < 0) throw new UnreadableStatement(`Not a month: "${s}"`);
  return `${m[3]}-${String(mo + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}
/** "07/26/21" → "2021-07-26". */
function shortDate(s: string): string {
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{2,4})$/);
  if (!m) throw new UnreadableStatement(`Not a date: "${s}"`);
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return `${y}-${m[1]}-${m[2]}`;
}
/** "09/23" within a statement ending periodEnd → full date (Jan rows in a Dec→Jan statement roll back). */
function mmdd(s: string, periodEnd: string): string {
  const [mm, dd] = s.split('/');
  let y = Number(periodEnd.slice(0, 4));
  if (Number(mm) > Number(periodEnd.slice(5, 7)) + 1) y -= 1;
  return `${y}-${mm}-${dd}`;
}

/** Splits a holdings row "NAME words qty cost price value …" into its
 * name and numbers. The quantity is found from the PRICE (the first
 * 4-decimal number right after a 2-decimal cost), so numbers that belong to
 * a name ("VANGUARD RUSSELL 2000", "ISHARES 3-7 YEAR") stay in the name and
 * 2018-era whole-share quantities ("11 293.04 26.1200") still work. */
function splitTrailingNumbers(line: string): { text: string; nums: string[] } {
  const toks = line.split(/\s+/);
  let i = toks.length;
  while (i > 0 && (isNum(toks[i - 1]) || toks[i - 1] === 'N/A')) i--;
  const tail = toks.slice(i);
  const four = (t: string) => /^\(?-?[\d,]*\.\d{4}\)?$/.test(t);
  const two = (t: string) => /^\(?-?[\d,]*\.\d{2}\)?$/.test(t);
  for (let p = 2; p < tail.length; p++) {
    if (four(tail[p]) && (two(tail[p - 1]) || tail[p - 1] === 'N/A')) {
      const q = p - 2;
      return { text: toks.slice(0, i + q).join(' '), nums: tail.slice(q) };
    }
  }
  return { text: toks.slice(0, i).join(' '), nums: tail };
}

// ---- page bookkeeping ----

interface Page {
  account: string | null; // last 5 digits
  pkg: boolean;
  lines: string[];
}

/** Lines that are page furniture, not content. */
const NOISE = [
  /^\+( \+)*$/,
  /^\d{4} \d{3}( \d+)?$/, // "6448 001"
  /^\d{4} \d+ of \d+ \d{3}$/,
  /^\d+ of \d+$/,
  /^CB Page$/,
  /^\d+$/,
  /Account Number: 8XV-\d{5}/,
  /^Access Code: 67-898-\d{5}$/,
  /^24-Hour Assistance: \(800\) MERRILL$/,
  /^Primary Account: 8XV-\d{5}/,
  /^[A-Z][a-z]+ \d{1,2}, \d{4} - [A-Z][a-z]+ \d{1,2}, \d{4}$/,
  /^(Description|Total|Estimated|Cost Basis|Market Price|Market Value|Unrealized|Gain\/\(Loss\)|Investment|Return \(\$\)|Annual|Income|Cumulative|Total Client|Current|Yield%|Unit|Acquired|Date|Liquidation|Settlement|Transaction|Amount|Commissions\/|Trading Fees|\(Debit\)\/|Credit|Accrued Interest|Earned\/\(Paid\))$/,
];
const isNoise = (l: string) => NOISE.some((r) => r.test(l));

function splitPages(text: string): Page[] {
  const raw = text.split('\n').map((l) => l.trim());
  const pages: Page[] = [];
  let cur: string[] = [];
  const flush = () => {
    if (cur.length) {
      const joined = cur.join('\n');
      const acct = joined.match(/Account Number: 8XV-(\d{5})/);
      pages.push({ account: acct ? acct[1] : null, pkg: !acct && /Primary Account: 8XV-\d{5}/.test(joined), lines: cur });
    }
    cur = [];
  };
  for (const l of raw) {
    if (/^\+( \+)*$/.test(l)) {
      flush();
      continue;
    }
    cur.push(l);
  }
  flush();
  // Pages with neither marker (blank pages, continuation sheets) belong to
  // the account before them.
  let last: string | null = null;
  for (const p of pages) {
    if (p.account) last = p.account;
    else if (!p.pkg && last) p.account = last;
  }
  return pages;
}

// ---- line helpers ----

/** First line matching `label` followed by numbers → [thisPeriod, ytd]. */
function pair(lines: string[], label: RegExp, from = 0, to = lines.length): [number, number] | null {
  for (let i = from; i < to; i++) {
    const m = lines[i].match(label);
    if (!m) continue;
    const rest = lines[i].slice(m.index! + m[0].length).trim();
    const toks = rest.split(/\s+/).filter(Boolean);
    if (!toks.length || !toks.every((t) => isNum(t))) continue;
    return [n(toks[0]), toks[1] !== undefined ? n(toks[1]) : 0];
  }
  return null;
}
const first = (lines: string[], label: RegExp, from = 0, to = lines.length) => pair(lines, label, from, to)?.[0] ?? 0;

function indexOf(lines: string[], re: RegExp, from = 0): number {
  for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return i;
  return -1;
}

// ---- account sections ----

const emptyFlows = (): MlAccount['flows'] => ({
  fundsReceived: 0,
  electronicIn: 0,
  otherCredits: 0,
  electronicOut: 0,
  otherDebits: 0,
  checks: 0,
  cardAndAtm: 0,
  margin: 0,
  fees: 0,
  dividends: 0,
  purchases: 0,
  sales: 0,
  tradingFees: 0,
});

function parseFlows(lines: string[]): { flows: MlAccount['flows']; ytd: MlAccount['flows'] } {
  const flows = emptyFlows();
  const ytd = emptyFlows();
  const start = indexOf(lines, /^CASH FLOW\b/);
  if (start < 0) return { flows, ytd };
  let mode: 'credits' | 'debits' | 'other' = 'credits';
  const end = Math.min(lines.length, start + 60);
  const put = (k: keyof MlAccount['flows'], v: [number, number] | null) => {
    if (!v) return;
    flows[k] += v[0];
    ytd[k] += v[1];
  };
  for (let i = start + 1; i < end; i++) {
    const l = lines[i];
    if (/^CREDITS\b/.test(l)) mode = 'credits';
    else if (/^DEBITS\b/.test(l)) mode = 'debits';
    else if (/^OTHER TRANSACTIONS\b|^Net Cash Flow/.test(l)) mode = 'other';
    const one = (re: RegExp) => pair([l], re);
    if (/^Funds Received\b/.test(l)) put('fundsReceived', one(/^Funds Received/));
    else if (/^Electronic Transfers\b/.test(l)) put(mode === 'debits' ? 'electronicOut' : 'electronicIn', one(/^Electronic Transfers/));
    else if (/^Other Credits\b/.test(l)) put('otherCredits', one(/^Other Credits/));
    else if (/^Other Debits\b/.test(l)) put('otherDebits', one(/^Other Debits/));
    else if (/^Margin Interest Charged\b/.test(l)) put('margin', one(/^Margin Interest Charged/));
    else if (/^(Visa Purchases|ATM\/Cash Advances)\b/.test(l)) put('cardAndAtm', one(/^(Visa Purchases|ATM\/Cash Advances)/));
    else if (/^Checks Written\/Bill Payment\b/.test(l)) put('checks', one(/^Checks Written\/Bill Payment/));
    else if (/^Advisory and other fees\b/.test(l)) put('fees', one(/^Advisory and other fees/));
    else if (/^Dividends\/Interest Income\b/.test(l)) put('dividends', one(/^Dividends\/Interest Income/));
    else if (/^Security Purchases\/Debits\b/.test(l)) put('purchases', one(/^Security Purchases\/Debits/));
    else if (/^Security Sales\/Credits\b/.test(l)) put('sales', one(/^Security Sales\/Credits/));
    else if (/^Commissions\/Trading Fees\b/.test(l)) put('tradingFees', one(/^Commissions\/Trading Fees/));
    if (/^Closing Cash\/Money Accounts/.test(l)) mode = 'other';
  }
  return { flows, ytd };
}

const CLASS_RE = /(Equity|Fixed Income|Alternative Investments?|Alternatives?|Cash(?:\/Money Accounts)?|Other|Commodities|Real Estate) (\d{1,3})%/g;
function classesFrom(text: string): MlHolding['classes'] | null {
  const out = { equity: 0, fixed: 0, cash: 0, other: 0 };
  let found = false;
  for (const m of text.matchAll(CLASS_RE)) {
    found = true;
    const pct = Number(m[2]) / 100;
    if (m[1] === 'Equity') out.equity += pct;
    else if (m[1] === 'Fixed Income') out.fixed += pct;
    else if (m[1].startsWith('Cash')) out.cash += pct;
    else out.other += pct;
  }
  if (!found) return null;
  const sum = out.equity + out.fixed + out.cash + out.other;
  if (sum > 0 && Math.abs(sum - 1) > 0.001) (Object.keys(out) as (keyof typeof out)[]).forEach((k) => (out[k] = out[k] / sum));
  return out;
}

type HoldSection = MlHolding['section'] | null;
function sectionOf(l: string): HoldSection | 'stop' | undefined {
  if (/^CASH\/MONEY ACCOUNTS\b/.test(l)) return 'cash';
  if (/^OTHER MONEY MARKET MUTUAL FUNDS\b/.test(l)) return 'mmf';
  if (/^EQUITIES\b/.test(l)) return 'equity';
  if (/^MUTUAL FUNDS\/CLOSED END FUNDS/.test(l)) return 'fund';
  if (/^(FIXED INCOME|GOVERNMENT AND AGENCY|CORPORATE BONDS|MUNICIPAL BONDS|CERTIFICATES OF DEPOSIT)\b/.test(l)) return 'fixed';
  if (/^(OPTIONS|OTHER|ALTERNATIVE INVESTMENTS)\b(?! MONEY)/.test(l) && !/^OTHER (Credits|Debits|TRANSACTIONS)/i.test(l)) return 'other';
  if (/^LONG PORTFOLIO\b/.test(l) || /^YOUR (CMA|RETIREMENT ACCOUNT) TRANSACTIONS\b/.test(l)) return 'stop';
  return undefined;
}

function parseHoldings(lines: string[]): { holdings: MlHolding[]; totals: MlAccount['totals']; ok: boolean } {
  const holdings: MlHolding[] = [];
  const totals: MlAccount['totals'] = { cost: null, value: null, gain: null, income: null };
  const start = indexOf(lines, /^YOUR (CMA|RETIREMENT ACCOUNT) ASSETS\b/);
  if (start < 0) return { holdings, totals, ok: false };
  let section: HoldSection = null;
  let pending: MlHolding | null = null;
  let pendingText = '';
  const flush = () => {
    if (!pending) return;
    const cls = classesFrom(pendingText);
    if (cls) pending.classes = cls;
    const sym = pendingText.match(/SYMBOL: ([A-Z][A-Z0-9.]*)/);
    if (sym && !pending.symbol) pending.symbol = sym[1];
    const ip = pendingText.match(/Initial Purchase: (\d{2}\/\d{2}\/\d{2})/);
    if (ip) pending.initialPurchase = shortDate(ip[1]);
    // name continuation (text before CURRENT YIELD / SYMBOL)
    const cont = pendingText.split(/\s*(?:CURRENT YIELD|SYMBOL:|Initial Purchase|Equity \d|Fixed Income \d|Cash \d|Other \d|Alternative)/)[0].trim();
    if (cont && /^[A-Z0-9&$.,'\/() -]+$/.test(cont) && !/^(FDIC|SUBJECT|TOTAL|\(?\.\d)/.test(cont) && cont.length < 60) pending.name = `${pending.name} ${cont}`.replace(/\s+/g, ' ').trim();
    holdings.push(pending);
    pending = null;
    pendingText = '';
  };
  let cashTotal: number | null = null;
  let cashIncome: number | null = null;
  let cashFromTotal = false;
  for (let i = start; i < lines.length; i++) {
    const raw = lines[i];
    if (isNoise(raw)) continue;
    const l = raw.replace(/^(\.\s*)+/, '').replace(/^@\s+/, '').trim();
    if (!l || l === '.') continue;
    const sec = sectionOf(l);
    if (sec !== undefined && sec !== 'stop' && sec === section && /\(continued\)/.test(l)) continue;
    if (sec === 'stop') {
      flush();
      if (/^LONG PORTFOLIO\b/.test(l)) {
        // next "TOTAL YIELD x% cost value gain [accrued] income" or "TOTAL cost value gain income [yield]"
        for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
          const m = lines[j].match(/^TOTAL(?: YIELD [\d.]+%)?\s+(.*)$/);
          if (!m) continue;
          const nums = m[1].split(/\s+/).filter(isNum);
          if (nums.length >= 3) {
            totals.cost = n(nums[0]);
            totals.value = n(nums[1]);
            totals.gain = n(nums[2]);
            totals.income = nums.length >= 4 ? n(nums[nums.length >= 5 && /YIELD/.test(lines[j]) ? 4 : 3]) : null;
          }
          break;
        }
      }
      break;
    }
    if (sec !== undefined) {
      flush();
      section = sec;
      continue;
    }
    if (/^YOUR (CMA|RETIREMENT ACCOUNT) ASSETS\b/.test(l) || /\(continued\)$/.test(l)) continue;
    if (!section) continue;

    if (section === 'cash') {
      const t = l.match(/^TOTAL\s+(.*)$/);
      if (t) {
        const nums = t[1].split(/\s+/).filter(isNum);
        // TOTAL cost value [income] [yield]
        if (nums.length >= 2) {
          cashTotal = n(nums[1]);
          cashIncome = nums.length >= 3 ? n(nums[2]) : null;
          cashFromTotal = true;
        }
        continue;
      }
      if (cashFromTotal) continue;
      // "CASH 1.78 1.78 1.78" · "BANK … RASP 691.00 691.00 1.0000 691.00 5 .75" · "(.4800 FRACTIONAL SHARE) .48 1.0000 .48 .75"
      const toks = l.split(/\s+/);
      let k = toks.length;
      while (k > 0 && isNum(toks[k - 1])) k--;
      const nums = toks.slice(k);
      if (nums.length >= 2 && /[A-Z)]/.test(toks.slice(0, k).join(' '))) {
        const p = nums.indexOf('1.0000');
        const v = p >= 0 && nums[p + 1] !== undefined ? n(nums[p + 1]) : nums.length === 3 ? n(nums[2]) : null;
        if (v !== null) {
          cashTotal = round2((cashTotal ?? 0) + v);
          if (p >= 0 && nums[p + 2] !== undefined && nums.length - p >= 4) cashIncome = (cashIncome ?? 0) + n(nums[p + 2]);
        }
      }
      continue;
    }
    if (/^(Subtotal|TOTAL)\b/.test(l)) {
      flush();
      continue;
    }
    const { text, nums } = splitTrailingNumbers(l);
    const looksRow = text && /^[A-Z0-9&$#'.,\/()+%*\- ]+$/.test(text) && nums.length >= 4 && !/CUS NO|UNIT PRICE|\bHOLDING [\d.]|PAY DATE/.test(text);
    if (looksRow) {
      flush();
      if (section === 'equity') {
        // NAME SYMBOL qty cost price value gain [income]
        const tm = text.match(/^(.*\S)\s+([A-Z][A-Z0-9.\/]{0,7})$/);
        const name = tm ? tm[1] : text;
        const symbol = tm ? tm[2] : null;
        const [qty, cost, price, value, gain, income] = nums;
        pending = {
          name,
          symbol,
          section: 'equity',
          qty: n(qty),
          cost: nOrNull(cost),
          price: n(price),
          value: n(value),
          gain: nOrNull(gain),
          income: income !== undefined && income !== 'N/A' ? n(income) : null,
          classes: { equity: 1, fixed: 0, cash: 0, other: 0 },
          initialPurchase: null,
        };
      } else if (section === 'mmf') {
        // NAME qty cost price value [clientInvestment] [income]
        const [qty, cost, price, value] = nums;
        pending = {
          name: text,
          symbol: null,
          section: 'mmf',
          qty: n(qty),
          cost: n(cost),
          price: n(price),
          value: n(value),
          gain: 0,
          income: nums.length >= 6 ? n(nums[5]) : null,
          classes: { equity: 0, fixed: 0, cash: 1, other: 0 },
          initialPurchase: null,
        };
      } else {
        // funds / bonds / other: NAME qty cost price value gain clientInv cumReturn [income] [yield]
        const [qty, cost, price, value, gain] = nums;
        pending = {
          name: text,
          symbol: null,
          section,
          qty: n(qty),
          cost: n(cost),
          price: n(price),
          value: n(value),
          gain: nOrNull(gain),
          income: nums.length >= 8 ? n(nums[7]) : null,
          classes: section === 'fixed' ? { equity: 0, fixed: 1, cash: 0, other: 0 } : { equity: 0, fixed: 0, cash: 0, other: 1 },
          initialPurchase: null,
        };
      }
      continue;
    }
    if (pending) pendingText += ` ${l}`;
  }
  flush();
  if (cashTotal !== null && cashTotal !== 0) {
    holdings.unshift({
      name: 'Cash & Bank Deposits',
      symbol: null,
      section: 'cash',
      qty: null,
      cost: cashTotal,
      price: null,
      value: cashTotal,
      gain: 0,
      income: cashIncome,
      classes: { equity: 0, fixed: 0, cash: 1, other: 0 },
      initialPurchase: null,
    });
  }
  return { holdings, totals, ok: true };
}

function parseLots(lines: string[]): MlLot[] {
  const lots: MlLot[] = [];
  const start = indexOf(lines, /^YOUR (CMA|RETIREMENT ACCOUNT) EQUITY COST BASIS\b/);
  if (start < 0) return lots;
  let cur: { name: string; symbol: string } | null = null;
  const LOT = /^(\d{2}\/\d{2}\/\d{2}) (-?[\d,]*\.\d+) (-?[\d,]*\.?\d+) (\(?-?[\d,]*\.?\d+\)?) (-?[\d,]*\.?\d+) (\(?-?[\d,]*\.?\d+\)?) (\(?-?[\d,]*\.?\d+\)?|N\/A)( [\d,]+)?$/;
  for (let i = start; i < lines.length; i++) {
    const raw = lines[i];
    if (isNoise(raw)) continue;
    const l = raw.replace(/^(\.\s*)+/, '').trim();
    if (/^YOUR (CMA|RETIREMENT ACCOUNT) (TRANSACTIONS|ASSETS)\b/.test(l)) break;
    if (/^Subtotal\b/.test(l)) {
      cur = null;
      continue;
    }
    // "NAME SYM mm/dd/yy qty unit total price value gain [income]"
    const head = l.match(/^(.*\S) ([A-Z][A-Z0-9.\/]{0,7}) (\d{2}\/\d{2}\/\d{2} .*)$/);
    let lotText = l;
    if (head && LOT.test(head[3])) {
      cur = { name: head[1], symbol: head[2] };
      lotText = head[3];
    }
    const m = lotText.match(LOT);
    if (!m || !cur) continue;
    lots.push({ symbol: cur.symbol, name: cur.name, acquired: shortDate(m[1]), qty: n(m[2]), cost: n(m[4]), value: n(m[6]), gain: m[7] === 'N/A' ? round2(n(m[6]) - n(m[4])) : n(m[7]) });
  }
  return lots;
}

function parseSales(lines: string[]): MlSale[] {
  const out: MlSale[] = [];
  let i = indexOf(lines, /^REALIZED GAINS\/\(LOSSES\)$/);
  while (i >= 0) {
    for (i = i + 1; i < lines.length; i++) {
      const l = lines[i].replace(/^(\.\s*)+/, '').trim();
      if (isNoise(l) || /^Subtotal\b|^YOUR |^REALIZED GAINS/.test(l)) continue;
      if (/^TOTAL\b|^- Excludes|^(UNSETTLED TRADES|ADVISORY AND OTHER FEES|CASH\/OTHER TRANSACTIONS|SECURITIES YOU TRANSFERRED|YOUR (CMA|RETIREMENT ACCOUNT) MONEY|SWEEP PROGRAM|DIVIDENDS\/INTEREST|SECURITY TRANSACTIONS)/.test(l)) break;
      // NAME qty acquired sold proceeds cost gain [ytd]   (acquired may be "VARIOUS"; gain may be N/C)
      const m = l.match(/^(.*\S) (-?[\d,]*\.\d+) (\d{2}\/\d{2}\/\d{2}|VARIOUS|N\/A) (\d{2}\/\d{2}\/\d{2}) (\(?-?[\d,]*\.?\d+\)?) (\(?-?[\d,]*\.?\d+\)?|N\/A) ?(\(?-?[\d,]*\.?\d+\)?|N\/C|N\/A)?/);
      if (!m) continue;
      const acquired = /^\d/.test(m[3]) ? shortDate(m[3]) : null;
      const sold = shortDate(m[4]);
      const gainTok = m[7] ?? '';
      const washSale = /N\/C/.test(gainTok) || /N\/C/.test(l);
      let term: MlSale['term'] = null;
      if (acquired) {
        const a = new Date(`${acquired}T12:00:00Z`);
        a.setUTCFullYear(a.getUTCFullYear() + 1);
        term = new Date(`${sold}T12:00:00Z`) > a ? 'long' : 'short';
      }
      out.push({ name: m[1], qty: n(m[2]), acquired, sold, proceeds: n(m[5]), cost: nOrNull(m[6]), gain: gainTok && !/N\//.test(gainTok) ? n(gainTok) : null, washSale, term });
    }
    i = indexOf(lines, /^REALIZED GAINS\/\(LOSSES\)( \(continued\))?$/, i + 1);
  }
  return out;
}

interface Trade {
  date: string;
  name: string;
  kind: 'buy' | 'sell';
  qty: number;
  amount: number;
  cusip: string | null;
}
function parseTrades(lines: string[], periodEnd: string): Trade[] {
  const out: Trade[] = [];
  // Only settled trades inside SECURITY TRANSACTIONS — "Unsettled Trades"
  // settle (and are listed) next month.
  let on = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^SECURITY TRANSACTIONS\b/.test(l)) on = true;
    else if (/^TOTAL SECURITY SALES\/CREDITS|^UNSETTLED TRADES|^REALIZED GAINS|^ADVISORY AND OTHER FEES/.test(l)) on = false;
    if (!on) continue;
    // "09/23 MARTIN MARIETTA MATLS Purchase 1.0000 (497.52) (497.52)"  /  "09/25 X Sale -1.0000 903.57 (.02) 903.55"
    const m = l.match(/^(\d{2}\/\d{2}) (?:(\d{2}\/\d{2}) )?(.*?) (Purchase|Sale|Redemption|Reinvestment) (-?[\d,]*\.\d+)\s+(.*)$/);
    if (!m) continue;
    const nums = m[6].split(/\s+/).filter(isNum);
    if (!nums.length) continue;
    const next = lines[i + 1] ?? '';
    const cus = (next.match(/CUS NO ([0-9A-Z]{9})/) ?? l.match(/CUS NO ([0-9A-Z]{9})/))?.[1] ?? null;
    let name = m[3];
    const cont = next.match(/^([A-Z0-9&.,'\/ -]+?) (?:CUS NO|PROSPECTUS|PRODUCT|EXECUTED|PER ADVISORY)/);
    if (cont && cont[1].length < 40 && !/^\d/.test(cont[1])) name = `${name} ${cont[1]}`.trim();
    out.push({ date: mmdd(m[1], periodEnd), name, kind: m[4] === 'Purchase' || m[4] === 'Reinvestment' ? 'buy' : 'sell', qty: Math.abs(n(m[5])), amount: Math.abs(n(nums[nums.length - 1])), cusip: cus });
  }
  return out;
}

/** Lines of ADVISORY AND OTHER FEES: "09/02 INV. ADVISORY FEE SEP Advisory
 * Program Fee 307.73" (2018: "10/23 Advisory Program Fee INV. ADVISORY FEE
 * OCT 17.03"); rebates ("MUTUAL FUND REBATE .03") are credits → negative. */
function parseFees(lines: string[], periodEnd: string): { date: string; amount: number; desc: string }[] {
  const out: { date: string; amount: number; desc: string }[] = [];
  let on = false;
  for (const l of lines) {
    if (/^ADVISORY AND OTHER FEES\b/.test(l)) {
      on = true;
      continue;
    }
    if (!on) continue;
    if (/^NET TOTAL\b/.test(l)) {
      on = false;
      continue;
    }
    const m = l.match(/^(\d{2}\/\d{2}) (.*?) (\(?-?[\d,]*\.\d{1,2}\)?)$/);
    if (!m) continue;
    const credit = /REBATE|CREDIT|REFUND|REVERSAL|ADJUSTMENT/i.test(m[2]);
    const desc = m[2].replace(/Advisory Program Fee|Fee Type/g, '').replace(/\s+/g, ' ').trim();
    out.push({ date: mmdd(m[1], periodEnd), amount: credit ? -Math.abs(n(m[3])) : Math.abs(n(m[3])), desc });
  }
  return out;
}

function parseStrategy(lines: string[]): { strategy: string | null; sleeves: MlAccount['sleeves']; objective: string | null } {
  let strategy: string | null = null;
  const sleeves: MlAccount['sleeves'] = [];
  const s = indexOf(lines, /^YOUR INVESTMENT STRATEGY - /);
  if (s >= 0) {
    const m = lines[s].match(/^YOUR INVESTMENT STRATEGY - (.*?)(?: (\d{1,3}\.\d{2})% RATE: ([\d.]+%|\*))?$/);
    strategy = m ? m[1].trim() : null;
    if (m?.[2]) sleeves.push({ name: m[1].trim(), pct: Number(m[2]), rate: m[3] === '*' ? null : Number(m[3].replace('%', '')) });
    for (let i = s + 1; i < Math.min(lines.length, s + 12); i++) {
      const l = lines[i];
      if (/^This Account is enrolled|^The percentage/.test(l)) break;
      for (const x of l.matchAll(/([A-Z][A-Z0-9&.,'\/ -]+?) (\d{1,3}\.\d{2})% RATE: ([\d.]+%|\*)/g)) {
        sleeves.push({ name: x[1].trim(), pct: Number(x[2]), rate: x[3] === '*' ? null : Number(x[3].replace('%', '')) });
      }
    }
  }
  const o = indexOf(lines, /^ACCOUNT INVESTMENT OBJECTIVE\b/);
  const objLine = o >= 0 ? lines.slice(o + 1, o + 4).find((l) => /^[A-Z][A-Z &]+:/.test(l)) : undefined;
  return { strategy, sleeves, objective: objLine ? objLine.split(':')[0].trim() : null };
}

function typeFor(title: string | null, pageText: string): MlAccountType {
  const t = `${title ?? ''} ${pageText}`;
  if (/\bUTMA\b|\bUGMA\b|\bC\/F\b/.test(t)) return 'utma';
  const cover = pageText.match(/^[A-Z][A-Z .'-]+ (IRRA|RRA|ROTH IRA|IRA)$/m);
  if (cover) return cover[1] === 'RRA' || cover[1] === 'ROTH IRA' ? 'roth' : 'ira';
  if (/^RRA\b/.test(title ?? '')) return 'roth';
  if (/^IRRA\b|^IRA\b/.test(title ?? '')) return 'ira';
  if (/^IRRA|\bIRRA\b/.test(title ?? '') || (/RETIREMENT ACCOUNT/.test(pageText) && /\bIRRA\b/.test(pageText))) return 'ira';
  if (/^RRA|\bROTH\b/i.test(title ?? '') || (/RETIREMENT ACCOUNT/.test(pageText) && /\bRRA\b/.test(pageText))) return 'roth';
  return 'cma';
}

function parseAccount(number: string, lines: string[], title: string | null, periodEnd: string, checks: StatementCheck[]): MlAccount {
  const body = lines.filter((l) => !isNoise(l));
  const joined = lines.join('\n');
  const type = typeFor(title, joined);
  const label = `${type.toUpperCase()} ••${number.slice(-4)}`;
  const opening = pair(body, /^Opening Value \(\d{2}\/\d{2}\)/);
  const closing = pair(body, /^Closing Value \(\d{2}\/\d{2}\)/);
  if (!closing) throw new UnreadableStatement(`${label}: no Closing Value`);
  const credits = pair(body, /^Total Credits/) ?? [0, 0];
  const debits = pair(body, /^Total Debits/) ?? [0, 0];
  const transfers = pair(body, /^Securities You Transferred In\/Out/) ?? [0, 0];
  const market = pair(body, /^Market Gains\/\(Losses\)/) ?? [0, 0];
  const assetsAt = indexOf(body, /^ASSETS\b/);
  const a = (re: RegExp) => (assetsAt >= 0 ? first(body, re, assetsAt, assetsAt + 12) : 0);
  const { flows, ytd: flowsYtd } = parseFlows(body);
  const { strategy, sleeves, objective } = parseStrategy(body);
  const { holdings, totals } = parseHoldings(lines);
  const lots = type === 'cma' || type === 'utma' ? parseLots(lines) : [];
  const sales = parseSales(body);
  const feeLines = parseFees(body, periodEnd);

  const transfersIn: MlAccount['transfersIn'] = [];
  for (const l of body) {
    const m = l.match(/^(\d{2}\/\d{2}) (.*?) Security Transfer (In|Out) (-?[\d,]*\.\d+) (\(?-?[\d,]*\.\d{2}\)?)/);
    if (m) transfersIn.push({ date: mmdd(m[1], periodEnd), name: m[2], qty: n(m[4]) * (m[3] === 'Out' ? -1 : 1), value: n(m[5]) * (m[3] === 'Out' ? -1 : 1) });
  }
  const rollovers: MlAccount['rollovers'] = [];
  let yearEndValue: MlAccount['yearEndValue'] = null;
  const ye = joined.match(/Year-End Plan Value as of ([A-Z][a-z]+ \d{1,2}, \d{4}): \$([\d,]+\.\d{2})/);
  if (ye) yearEndValue = { date: longDate(ye[1]), value: n(ye[2]) };
  const cy = joined.match(/Contributions Tax Year (\d{4}) Tax Year (\d{4})/);
  const ro = joined.match(/Total Rollover Deposits \$([\d,]*\.\d{2}) \$([\d,]*\.\d{2})/);
  if (cy && ro) {
    rollovers.push({ year: Number(cy[1]), amount: n(ro[1]) }, { year: Number(cy[2]), amount: n(ro[2]) });
  }
  const by = joined.match(/TOTAL ML Bank Deposit Program [\d,]+ ([\d.]+) [\d,]+/);
  const bankRow = joined.match(/Bank of America, N\.?A\.? [\d,]+ [\d,]+ ([\d.]+) [\d.]+ [\d,]+/);

  const acct: MlAccount = {
    number,
    type,
    title,
    strategy,
    sleeves,
    objective,
    opening: opening?.[0] ?? 0,
    closing: closing[0],
    credits: credits[0],
    debits: debits[0],
    transfers: transfers[0],
    market: market[0],
    ytd: { credits: credits[1], debits: debits[1], transfers: transfers[1], market: market[1] },
    flows,
    flowsYtd,
    assets: {
      cash: a(/^Cash\/Money Accounts/),
      fixedIncome: a(/^Fixed Income/),
      equities: a(/^Equities/),
      funds: a(/^Mutual Funds/),
      options: a(/^Options/),
      other: a(/^Other(\/Annuities\/Insurance)?\b/),
    },
    holdings,
    totals,
    lots,
    sales,
    realized: null,
    unrealized: null,
    income: null,
    feeLines,
    transfersIn,
    rollovers,
    yearEndValue,
    bankYield: bankRow ? Number(bankRow[1]) : by ? null : null,
  };

  // ---- checks ----
  const sumFlow = round2(acct.opening + acct.credits + acct.debits + acct.transfers + acct.market);
  checks.push(check(`${label}: opening + activity = closing`, Math.abs(sumFlow - acct.closing) < 0.02, `${sumFlow.toFixed(2)} vs ${acct.closing.toFixed(2)}`));
  const assetSum = round2(Object.values(acct.assets).reduce((s, v) => s + v, 0));
  if (assetsAt >= 0) checks.push(check(`${label}: assets add up`, Math.abs(assetSum - acct.closing) < 1, `${assetSum.toFixed(2)} vs ${acct.closing.toFixed(2)}`));
  const holdSum = round2(holdings.reduce((s, h) => s + h.value, 0));
  if (holdings.length) {
    const gap = round2(acct.closing - holdSum);
    // pdf.js occasionally drops a row's number line on old layouts — the gap
    // becomes "Not itemized" so allocation still adds up, and the check says so.
    checks.push(check(`${label}: holdings add up`, Math.abs(gap) < 1, Math.abs(gap) < 1 ? `${holdSum.toFixed(2)} of ${acct.closing.toFixed(2)}` : `${holdSum.toFixed(2)} of ${acct.closing.toFixed(2)} (${gap.toFixed(2)} not itemized)`));
    if (Math.abs(gap) >= 1) {
      holdings.push({ name: 'Not Itemized', symbol: null, section: 'other', qty: null, cost: null, price: null, value: gap, gain: null, income: null, classes: { equity: 0, fixed: 0, cash: 0, other: 1 }, initialPurchase: null });
    }
  } else if (acct.closing !== 0) {
    checks.push(check(`${label}: holdings listed`, false, 'No holdings rows read'));
  }
  if (feeLines.length || flows.fees) {
    const fl = round2(feeLines.reduce((x, f) => x + f.amount, 0));
    checks.push(check(`${label}: fee lines = fees`, Math.abs(fl + flows.fees) < 0.02, `${fl.toFixed(2)} vs ${(-flows.fees).toFixed(2)}`));
  }
  if (lots.length) {
    const bySym = new Map<string, number>();
    lots.forEach((x) => bySym.set(x.symbol, round2((bySym.get(x.symbol) ?? 0) + x.value)));
    let bad = 0;
    for (const [sym, v] of bySym) {
      const h = holdings.find((x) => x.symbol === sym);
      if (h && Math.abs(h.value - v) > 0.05) bad++;
    }
    checks.push(check(`${label}: tax lots match positions`, bad === 0, bad ? `${bad} position(s) differ from their lots` : `${lots.length} lots`));
  }
  return acct;
}

// ---- package pages ----

function parseIncomeAndGains(pkgLines: string[], accounts: MlAccount[]) {
  for (const l of pkgLines) {
    const m = l.match(/^8XV-(\d{5}) (.*)$/);
    if (!m) continue;
    const acct = accounts.find((a) => a.number === m[1]);
    if (!acct) continue;
    const toks = m[2].split(/\s+/);
    if (toks.length === 10 && toks.every((t) => isNum(t))) {
      const v = toks.map(n);
      const inc = (o: number): MlIncome => ({ taxExemptInterest: v[o], taxableInterest: v[o + 1], taxExemptDividends: v[o + 2], taxableDividends: v[o + 3], total: v[o + 4] });
      acct.income = { thisPeriod: inc(0), ytd: inc(5) };
    } else if (toks.length === 7 && toks.every((t) => isNum(t) || t === 'N/A')) {
      acct.realized = { stThis: n(toks[0]), stYtd: n(toks[1]), ltThis: n(toks[2]), ltYtd: n(toks[3]), ltcgDistYtd: toks[4] === 'N/A' ? null : n(toks[4]) };
      acct.unrealized = { st: n(toks[5]), lt: n(toks[6]) };
    }
  }
}

function marketIndicators(text: string): MlValues['market'] {
  const three = (re: RegExp) => {
    const m = text.match(re);
    if (!m) return [null, null, null] as (number | null)[];
    return m.slice(1, 4).map((x) => (x ? Number(x.replace(/[,%]/g, '')) : null));
  };
  const sp = three(/S&P 500 ([\d,.]+) ([\d,.]+) ([\d,.]+)/);
  const nd = three(/NASDAQ ([\d,.]+) ([\d,.]+) ([\d,.]+)/);
  const tb = three(/Three-Month Treasury Bills ([\d.]+)% ([\d.]+)% ([\d.]+)%/);
  const lt = three(/Long-Term Treasury Bonds ([\d.]+)% ([\d.]+)% ([\d.]+)%/);
  return { sp500: sp[0], sp500Prev: sp[1], sp500YearEnd: sp[2], nasdaq: nd[0], tbill3m: tb[0], longTreasury: lt[0] };
}

// ---- entry point ----

export function parseMerrill(text: string): ParsedStatement {
  if (!/PORTFOLIO SUMMARY/.test(text)) {
    if (/PORTFOLIO REVIEW|Client Review|Table of Contents/i.test(text)) throw new NotAStatement('A Portfolio Review, not a monthly statement');
    throw new UnreadableStatement('No Portfolio Summary — not a Merrill statement');
  }
  const head = text.match(/(WEALTH MANAGEMENT REPORT|YOUR MERRILL LYNCH REPORT|PORTFOLIO SUMMARY)?\s*([A-Z][a-z]+ \d{1,2}, \d{4}) - ([A-Z][a-z]+ \d{1,2}, \d{4})/);
  if (!head) throw new UnreadableStatement('No statement period');
  const periodStart = longDate(head[2]);
  const periodEnd = longDate(head[3]);
  const checks: StatementCheck[] = [];

  const pages = splitPages(text);
  const pkgLines = pages.filter((p) => p.pkg).flatMap((p) => p.lines);
  const npv = text.match(/Net Portfolio Value \$([\d,]+\.\d{2}) (?:\$([\d,]+\.\d{2})|-)/);
  const total = npv ? n(npv[1]) : null;

  // Account titles from "Your Accounts" ("8XV-10704 IRRA/Custom Managed - Client 377,526.90 …").
  const titles = new Map<string, string>();
  for (const l of pkgLines) {
    const m = l.match(/8XV-(\d{5}) ((?:CMA|IRRA|RRA|IRA|ROTH|TMA|WCMA|CMA\/[^\d]+?|[A-Z]{2,5})\/?[A-Za-z0-9 &\-/.,]*?)(?: [\d,]+\.\d{2}| \d+@|$)/);
    if (m && !titles.has(m[1])) titles.set(m[1], m[2].trim());
  }
  const order: string[] = [];
  pages.forEach((p) => {
    if (p.account && !order.includes(p.account)) order.push(p.account);
  });
  const accounts: MlAccount[] = [];
  for (const num of order) {
    const lines = pages.filter((p) => p.account === num).flatMap((p) => p.lines);
    if (!lines.some((l) => /^Closing Value \(/.test(l))) continue; // a cost-basis-only stub
    accounts.push(parseAccount(num, lines, titles.get(num) ?? null, periodEnd, checks));
  }
  const partial = accounts.length === 0;
  if (partial && total === null) throw new UnreadableStatement('No account pages with text');
  parseIncomeAndGains(pkgLines, accounts);
  const isChase = accounts.length > 0 && accounts.every((a) => a.type === 'utma');
  const era: MlValues['era'] = /YOUR MERRILL LYNCH REPORT/.test(text) ? 'merrillReport' : /WEALTH MANAGEMENT REPORT/.test(text) ? 'wealthReport' : 'single';
  if (accounts.length && total !== null) {
    const sum = round2(accounts.reduce((s, a) => s + a.closing, 0));
    checks.push(check('Accounts add up to Net Portfolio Value', Math.abs(sum - total) < 0.02, `${sum.toFixed(2)} vs ${total.toFixed(2)}`));
  }
  if (partial) checks.push(check('Account pages readable', false, 'Only the summary pages have text — account details missing'));

  const values: MlValues = { kind: isChase ? 'chase' : 'household', era, periodStart, total, accounts, market: marketIndicators(text), partial };

  // Transactions (account = last 4): fees, income, outside money, buys/sells.
  const transactions: ParsedTransaction[] = [];
  for (const acct of accounts) {
    const last4 = acct.number.slice(-4);
    const lines = pages.filter((p) => p.account === acct.number).flatMap((p) => p.lines);
    for (const f of acct.feeLines) transactions.push({ date: f.date, description: f.desc || 'Advisory Program Fee', kind: 'fee', amount: -f.amount, units: null, unitPrice: null, account: last4 });
    const trades = parseTrades(lines, periodEnd);
    const tag = `${acct.type.toUpperCase()} ••${last4}`;
    const buys = round2(trades.filter((t) => t.kind === 'buy').reduce((x, t) => x + t.amount, 0));
    // Return of capital / cash in lieu sit under "Other Security Transactions"
    // and count in Merrill's sales total — not trades.
    const otherSec = round2(lines.reduce((x, l) => { const m = l.match(/^Subtotal \(Other Security Transactions\) (\(?-?[\d,]*\.\d{2}\)?)/); return x + (m ? n(m[1]) : 0); }, 0));
    const sells = round2(trades.filter((t) => t.kind === 'sell').reduce((x, t) => x + t.amount, 0) + otherSec);
    if (trades.length || acct.flows.purchases || acct.flows.sales)
      checks.push(check(`${tag}: trades = purchases & sales`, Math.abs(buys + acct.flows.purchases) < 1 && Math.abs(sells - acct.flows.sales) < 1, `buys ${buys.toFixed(2)} vs ${(-acct.flows.purchases).toFixed(2)} · sells ${sells.toFixed(2)} vs ${acct.flows.sales.toFixed(2)}`));
    if (acct.realized && acct.sales.length) {
      const g = round2(acct.sales.reduce((x, y) => x + (y.gain ?? 0), 0));
      const r = round2(acct.realized.stThis + acct.realized.ltThis);
      checks.push(check(`${tag}: realized lots = summary`, Math.abs(g - r) < 0.05, `${g.toFixed(2)} vs ${r.toFixed(2)}`));
    }
    for (const t of trades)
      transactions.push({ date: t.date, description: t.cusip ? `${t.name} · ${t.cusip}` : t.name, kind: t.kind, amount: t.kind === 'buy' ? -t.amount : t.amount, units: t.kind === 'buy' ? t.qty : -t.qty, unitPrice: t.qty ? round2((t.amount / t.qty) * 10000) / 10000 : null, account: last4 });
    for (const x of acct.transfersIn) transactions.push({ date: x.date, description: `${x.name} (shares transferred ${x.value >= 0 ? 'in' : 'out'})`, kind: x.value >= 0 ? 'transfer_in' : 'transfer_out', amount: x.value, units: x.qty, unitPrice: null, account: last4 });
    const outside = acct.flows.fundsReceived + acct.flows.electronicIn + acct.flows.otherCredits;
    const outflow = acct.flows.electronicOut + acct.flows.otherDebits + acct.flows.checks + acct.flows.cardAndAtm;
    if (outside) transactions.push({ date: periodEnd, description: 'Money In (funds received / transfers)', kind: 'contribution', amount: round2(outside), units: null, unitPrice: null, account: last4 });
    if (outflow) transactions.push({ date: periodEnd, description: 'Money Out (transfers / withdrawals)', kind: 'withdrawal', amount: round2(outflow), units: null, unitPrice: null, account: last4 });
    if (acct.flows.dividends) transactions.push({ date: periodEnd, description: 'Dividends & Interest', kind: 'dividend', amount: acct.flows.dividends, units: null, unitPrice: null, account: last4 });
  }
  return { periodStart, periodEnd: isChase ? `${periodEnd}:chase` : periodEnd, values: values as unknown as Record<string, unknown>, transactions, checks };
}
