import { check, cents, money, round2, UnreadableStatement } from '../common';
import type { ParsedStatement, ParsedTransaction, StatementCheck } from '../common';

/** Template #16 — Lowe's store credit card (Lowe's Advantage Card, renamed
 * MyLowe's Rewards Credit Card in 2024; issued by Synchrony Bank). Drive
 * folder "Lowe's Credit Card", files "Lowe's Credit Card - YYYY.MM.pdf"
 * (2021-07 → today, closing around the 10th–11th, due the 3rd).
 *
 * Mike rarely uses the card and only saves a statement when he bought
 * something — the "payment-only" statement Synchrony sends the month after
 * (it just shows the payment and a $0 balance) is NOT kept. So every saved
 * statement normally opens at $0, and the months between are quiet.
 *
 * One layout (Synchrony), clean pdf.js text:
 *   "Previous Balance as of 06/11/2021 $0.00", "Payments - 320.76",
 *   "Other Credits - x", "Purchases/Debits + 174.59", "Fees Charged + x",
 *   "Interest Charged + x", "New Balance as of 07/11/2021 $174.59",
 *   "32 Day Billing Cycle from 06/11/2021 to 07/11/2021", "Credit Limit
 *   $12,000", "Available Credit $11,825", "Total Minimum Payment Due: $29.00",
 *   "Payment Due Date: 08/03/2021", "Account Number ending in 022 6".
 *   Transaction Detail: section heads ("Payments - $320.76", "Purchases and
 *   Other Debits $174.59"), rows "06/10 71429 LOWES INTERNET FUFILLMNT
 *   $174.59" / "07/03 ONLINE PAYMENT THANK YOU -$320.76", then the item lines
 *   Lowe's prints under each purchase (department names, "PROMOTIONAL
 *   DISCOUNT" = the 5% card discount, "FREIGHT SALES"/"PARCEL" = shipping).
 *   "Regular Purchases N/A 26.99% …" = purchase APR. YTD block "2024 Year-
 *   to- Date Fees and Interest / Total Fees Charged / Total Interest Charged
 *   / Total Interest Paid". Account Balance Summary has one row per balance
 *   type ("Regular", promotional plans, "Total").
 *
 * The 5% discount comes off at checkout — amounts are already discounted and
 * the statement never prints the savings, so they're estimated downstream.
 * Only the last 4 digits are kept. See docs/statement-templates/lowesCard.md. */

export interface LowesPurchase {
  date: string;
  ref: string | null;
  merchant: string;
  amount: number;
  online: boolean;
  store: string | null; // "STORE 3360 YORKTOWN NY" → "Yorktown NY (#3360)"
  items: string[]; // department / product lines, tidied
  discount: boolean; // "PROMOTIONAL DISCOUNT" printed (the card discount)
  shipped: boolean; // freight / parcel line printed
}

export interface LowesPromo {
  type: string; // the Account Balance Summary row label
  balance: number;
  date: string | null; // the promo purchase date, when printed
}

export interface LowesCardValues {
  accountLast: string;
  openingDate: string;
  closingDate: string;
  days: number | null;
  previousBalance: number;
  paymentsCredits: number; // negative (payments + other credits)
  payments: number; // negative
  otherCredits: number; // negative
  purchasesDebits: number;
  fees: number;
  interest: number;
  newBalance: number;
  minimumPayment: number;
  dueDate: string | null;
  creditLine: number | null;
  availableCredit: number | null;
  purchaseApr: number | null;
  /** A change-in-terms notice came with the statement; noticeApr = the
   * highest APR it quotes (the new rate: "…at an APR of 31.99%"). */
  termsNotice: boolean;
  noticeApr: number | null;
  ytdYear: number | null;
  feesYtd: number | null;
  interestYtd: number | null;
  interestPaidYtd: number | null;
  /** Deferred-interest / promotional balances (rows other than Regular). */
  promos: LowesPromo[];
  /** From the activity rows (positive numbers). */
  paid: number;
  refunds: number;
  purchases: number;
  online: number;
  inStore: number;
  purchaseDetail: LowesPurchase[];
}

export type LowesTxnKind = 'purchase' | 'refund' | 'payment' | 'fee' | 'interest' | 'adjustment';

const num = (s: string) => Number(s.replace(/[,$\s+]/g, ''));
const pad = (n: number | string) => String(n).padStart(2, '0');
function mdy(raw: string): string {
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) throw new UnreadableStatement(`Not a date: "${raw}"`);
  return `${m[3]}-${pad(m[1])}-${pad(m[2])}`;
}
const titleCase = (s: string) =>
  s
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/\b(Ego|Pt|Kd|Sos)\b/g, (w) => w.toUpperCase())
    .replace(/\bAnd\b/g, 'and')
    .replace(/(\d)V\b/gi, '$1V');

export function lowesTxnKind(desc: string, amount: number): LowesTxnKind {
  const d = desc.toUpperCase();
  if (/INTEREST CHARGE/.test(d)) return amount < 0 ? 'adjustment' : 'interest';
  if (/LATE FEE|LATE PAYMENT|RETURNED PAYMENT|\bFEE\b/.test(d)) return amount < 0 ? 'adjustment' : 'fee';
  if (amount < 0) {
    if (/PAYMENT|THANK YOU/.test(d) && !/RETURN|REFUND/.test(d)) return 'payment';
    if (/ADJ|REVERSAL|CREDIT (FEE|INTEREST)/.test(d)) return 'adjustment';
    return 'refund';
  }
  return 'purchase';
}

/** Online orders print "LOWES INTERNET FUFILLMNT" (sic); stores "STORE 3360 YORKTOWN NY". */
export const isLowesOnline = (desc: string) => /INTERNET|LOWES\.COM|ONLINE ORDER/i.test(desc);
export function lowesStore(desc: string): string | null {
  const m = desc.match(/^STORE (\d+) (.+?)(?: ([A-Z]{2}))?$/i);
  if (!m) return null;
  return `${titleCase(m[2])}${m[3] ? ` ${m[3].toUpperCase()}` : ''} (#${m[1]})`;
}

/** Item lines Lowe's prints under a purchase: drop the "-" / "-, -" filler,
 * turn the card-discount and shipping lines into booleans. */
function tidyItems(raw: string[]): { items: string[]; discount: boolean; shipped: boolean } {
  let discount = false;
  let shipped = false;
  const items: string[] = [];
  for (const line of raw) {
    for (const part0 of line.split(/,\s*/)) {
      const part = part0.trim();
      if (!part || /^-+$/.test(part)) continue;
      if (/^PROMOTIONAL DISCOU?N?T?$/i.test(part)) {
        discount = true;
        continue;
      }
      if (/^FREIGHT SALES|^PARCEL$|DELIVERY CHARGE/i.test(part)) {
        shipped = true;
        continue;
      }
      const t = titleCase(part.replace(/^-\s*/, ''));
      if (t && !items.includes(t)) items.push(t);
    }
  }
  return { items, discount, shipped };
}

export function parseLowesCard(text: string): ParsedStatement {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const find = (re: RegExp) => lines.map((l) => l.match(re)).find(Boolean) ?? null;
  const signed = (re: RegExp): number | null => {
    const m = find(re);
    if (!m) return null;
    const v = num(m[2]);
    return m[1] === '-' ? -v : v;
  };

  const prevM = find(/^Previous Balance as of (\d{1,2}\/\d{1,2}\/\d{4}) (-?)\$([\d,]*\.\d{2})$/i);
  const newM = find(/^New Balance as of (\d{1,2}\/\d{1,2}\/\d{4}) (-?)\$([\d,]*\.\d{2})$/i);
  if (!prevM || !newM) throw new UnreadableStatement('No Account Summary in the PDF’s text (a printed or scanned copy?)');
  const closingDate = mdy(newM[1]);
  const cycleM = find(/^(\d+) Day Billing Cycle from (\d{1,2}\/\d{1,2}\/\d{4}) to (\d{1,2}\/\d{1,2}\/\d{4})$/i);
  const days = cycleM ? Number(cycleM[1]) : null;
  const openingDate = cycleM ? mdy(cycleM[2]) : mdy(prevM[1]);
  const previousBalance = (prevM[2] === '-' ? -1 : 1) * num(prevM[3]);
  const newBalance = (newM[2] === '-' ? -1 : 1) * num(newM[3]);

  const payments = -(Math.abs(signed(/^Payments ([-+]) ?\$?([\d,]*\.\d{2})$/i) ?? 0));
  const otherCredits = -(Math.abs(signed(/^Other Credits ([-+]) ?\$?([\d,]*\.\d{2})$/i) ?? 0));
  const purchasesDebits = signed(/^Purchases\/Debits ([-+]) ?\$?([\d,]*\.\d{2})$/i) ?? 0;
  const fees = signed(/^Fees Charged ([-+]) ?\$?([\d,]*\.\d{2})$/i) ?? 0;
  const interest = signed(/^Interest Charged ([-+]) ?\$?([\d,]*\.\d{2})$/i) ?? 0;

  const minM = find(/^Total Minimum Payment Due:? \$([\d,]*\.\d{2})$/i);
  const dueM = find(/^Payment Due Date:? (\d{1,2}\/\d{1,2}\/\d{4})$/i);
  const headBal = find(/^New Balance:? \$(-?[\d,]*\.\d{2})$/i);
  const limitM = find(/^Credit Limit \$([\d,]+(?:\.\d{2})?)$/i);
  const availM = find(/^Available Credit \$([\d,]+(?:\.\d{2})?)$/i);
  const aprM = find(/^Regular Purchases \S+ (\d+\.\d+)%/i);
  const termsNotice = /CHANGE-IN-TERMS NOTICE|your APR is increasing/i.test(text);
  const quoted = [...text.matchAll(/at an APR of (\d+\.\d+)%/gi)].map((m) => Number(m[1]));
  const acctM = text.match(/Account Number ending in ([\d ]{4,6})/i);
  if (!acctM) throw new UnreadableStatement('Missing the card’s last 4 digits');
  const accountLast = acctM[1].replace(/\D/g, '').slice(-4);

  const ytdHead = lines.findIndex((l) => /^\d{4} Year- ?to- ?Date Fees and Interest$/i.test(l));
  const ytdYear = ytdHead >= 0 ? Number(lines[ytdHead].slice(0, 4)) : null;
  const ytdVal = (label: RegExp) => {
    if (ytdHead < 0) return null;
    for (const l of lines.slice(ytdHead + 1, ytdHead + 6)) {
      const m = l.match(label);
      if (m) return num(m[1]);
    }
    return null;
  };

  // ---- Account Balance Summary: anything other than Regular / Total is a promo ----
  // Rows: "<type> [promo date/amount] <prev> <payments> <purchases> <interest>
  // <expired> <new>" with "-" for zero; the last column is the new balance.
  const promos: LowesPromo[] = [];
  const absHead = lines.findIndex((l) => /^Account Balance Summary$/i.test(l));
  let summaryTotal: number | null = null;
  if (absHead >= 0) {
    const startRow = lines.findIndex((l, i) => i > absHead && /^Regular\b/.test(l));
    const end = lines.findIndex((l, i) => i > absHead && /^Total\b/.test(l));
    const lastCol = (l: string) => {
      const m = l.match(/(-?\$[\d,]*\.\d{2}|-)$/);
      return m ? (m[1] === '-' ? 0 : money(m[1])) : null;
    };
    if (startRow > 0 && end > startRow) {
      summaryTotal = lastCol(lines[end]);
      for (const l of lines.slice(startRow + 1, end)) {
        const bal = lastCol(l);
        if (bal === null) continue;
        const exp = l.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
        promos.push({ type: l.replace(/ (?:-|-?\$[\d,]*\.\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})(?= |$).*$/, '').trim(), balance: bal, date: exp ? mdy(exp[1]) : null });
      }
    }
  }

  // ---- Transactions (+ the item lines under each purchase) ----
  const closeY = Number(closingDate.slice(0, 4));
  const closeMo = Number(closingDate.slice(5, 7));
  const yearFor = (m: number) => (m > closeMo ? closeY - 1 : closeY);
  const rowRe = /^(\d{2})\/(\d{2}) (?:(\d{4,6}) )?(.+?) (-?)\$([\d,]*\.\d{2})$/;
  const stopRe = /^(Total Fees Charged This Period|Total Interest Charged This Period|Payments\b.*\$|Other Credits\b.*\$|Purchases and Other Debits\b.*\$|Fees\b.*\$[\d,]*\.\d{2}$|Interest Charged\b.*\$|\d{4} Year- ?to- ?Date)/i;
  const transactions: ParsedTransaction[] = [];
  const purchaseDetail: LowesPurchase[] = [];
  const head = lines.findIndex((l) => /^Transaction Detail$/i.test(l));
  const tail = lines.findIndex((l, i) => i > head && /^\d{4} Year- ?to- ?Date Fees and Interest$/i.test(l));
  if (head >= 0) {
    const body = lines.slice(head + 1, tail > head ? tail : undefined);
    for (let i = 0; i < body.length; i++) {
      const m = body[i].match(rowRe);
      if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) continue;
      const amount = (m[5] === '-' ? -1 : 1) * num(m[6]);
      const date = `${yearFor(Number(m[1]))}-${m[1]}-${m[2]}`;
      const desc = m[4].replace(/\s+/g, ' ').trim();
      if (Math.abs(amount) < 0.005) continue; // "INTEREST CHARGE ON PURCHASES $0.00"
      const kind = lowesTxnKind(desc, amount);
      transactions.push({ date, description: desc, kind, amount, units: null, unitPrice: null });
      if (kind === 'purchase' || kind === 'refund') {
        const raw: string[] = [];
        for (let j = i + 1; j < body.length && !rowRe.test(body[j]) && !stopRe.test(body[j]); j++) raw.push(body[j]);
        const t = tidyItems(raw);
        purchaseDetail.push({ date, ref: m[3] ?? null, merchant: desc, amount, online: isLowesOnline(desc), store: lowesStore(desc), ...t });
      }
    }
  }

  const sumKinds = (...kinds: LowesTxnKind[]) => round2(transactions.filter((t) => kinds.includes(t.kind as LowesTxnKind)).reduce((s, t) => s + t.amount, 0));
  const purchaseRows = purchaseDetail.filter((p) => p.amount > 0);
  const values: LowesCardValues = {
    accountLast,
    openingDate,
    closingDate,
    days,
    previousBalance,
    paymentsCredits: round2(payments + otherCredits),
    payments,
    otherCredits,
    purchasesDebits,
    fees,
    interest,
    newBalance,
    minimumPayment: minM ? num(minM[1]) : 0,
    dueDate: dueM ? mdy(dueM[1]) : null,
    creditLine: limitM ? num(limitM[1]) : null,
    availableCredit: availM ? num(availM[1]) : null,
    purchaseApr: aprM ? Number(aprM[1]) : null,
    noticeApr: termsNotice && quoted.length ? Math.max(...quoted) : null,
    termsNotice,
    ytdYear,
    feesYtd: ytdVal(/^Total Fees Charged \$([\d,]*\.\d{2})$/i),
    interestYtd: ytdVal(/^Total Interest Charged \$([\d,]*\.\d{2})$/i),
    interestPaidYtd: ytdVal(/^Total Interest Paid \$([\d,]*\.\d{2})$/i),
    promos,
    paid: -sumKinds('payment'),
    refunds: -sumKinds('refund'),
    purchases: sumKinds('purchase'),
    online: round2(purchaseRows.filter((p) => p.online).reduce((s, p) => s + p.amount, 0)),
    inStore: round2(purchaseRows.filter((p) => !p.online).reduce((s, p) => s + p.amount, 0)),
    purchaseDetail,
  };

  const credits = sumKinds('payment', 'refund', 'adjustment');
  const checks: StatementCheck[] = [
    check(
      'Summary adds up',
      cents(previousBalance + payments + otherCredits + purchasesDebits + fees + interest, newBalance),
      `${previousBalance} ${payments} ${otherCredits} +${purchasesDebits} +${fees} +${interest} vs ${newBalance}`
    ),
    check('Payments & credits match activity', cents(credits, payments + otherCredits), `rows ${credits} vs summary ${round2(payments + otherCredits)}`),
    check('Purchases match activity', cents(sumKinds('purchase'), purchasesDebits), `rows ${sumKinds('purchase')} vs summary ${purchasesDebits}`),
    check('Fees match activity', cents(sumKinds('fee'), fees), `rows ${sumKinds('fee')} vs summary ${fees}`),
    check('Interest matches activity', cents(sumKinds('interest'), interest), `rows ${sumKinds('interest')} vs summary ${interest}`),
  ];
  if (headBal) checks.push(check('Page 1 balance matches summary', cents(num(headBal[1]), newBalance), `${headBal[1]} vs ${newBalance}`));
  if (summaryTotal !== null) checks.push(check('Balance types add up', cents(summaryTotal, newBalance), `${summaryTotal} vs ${newBalance}`));
  // The printed day count isn't checked: Synchrony printed "32 Day" for 6/11 → 7/11/2021.
  // Available credit isn't checked: it's rounded down and reflects pending charges.
  return { periodStart: openingDate, periodEnd: closingDate, values: values as unknown as Record<string, unknown>, transactions, checks };
}

/** Statement-to-statement (derive time, oldest first). Saved statements are
 * usually months apart (payment-only months aren't kept), so the carry-over
 * is only checked for back-to-back cycles; YTD fees/interest never go down
 * within a year. */
export function crossCheckLowesCard(prev: { values: LowesCardValues } | null, cur: { values: LowesCardValues }): StatementCheck[] {
  if (!prev) return [];
  const p = prev.values, c = cur.values;
  const out: StatementCheck[] = [];
  const gap = Math.round((Date.parse(`${c.openingDate}T12:00:00Z`) - Date.parse(`${p.closingDate}T12:00:00Z`)) / 86400000);
  if (gap >= 0 && gap <= 3) out.push(check('Previous balance carries over', cents(p.newBalance, c.previousBalance), `${p.newBalance} → ${c.previousBalance}`));
  if (p.ytdYear !== null && p.ytdYear === c.ytdYear) {
    if (p.feesYtd !== null && c.feesYtd !== null) out.push(check('Year-to-date fees only grow', c.feesYtd >= p.feesYtd - 0.005, `${p.feesYtd} → ${c.feesYtd}`));
    if (p.interestYtd !== null && c.interestYtd !== null) out.push(check('Year-to-date interest only grows', c.interestYtd >= p.interestYtd - 0.005, `${p.interestYtd} → ${c.interestYtd}`));
  }
  return out;
}
