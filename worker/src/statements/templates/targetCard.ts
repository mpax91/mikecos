import { check, cents, round2, UnreadableStatement } from '../common';
import type { ParsedStatement, ParsedTransaction, StatementCheck } from '../common';

/** Template #12 — Target RedCard™ credit card, renamed Target Circle Card™
 * (issued by TD Bank USA, serviced by Target Card Services). Drive folder
 * "Target RedCard", files "Target RedCard - YYYY.MM.DD.pdf" (2020-08 →
 * today, closing on the 19th, the 17th from 2025-04 / 2025-10). Target only
 * sends a statement for a month with activity or a balance, so a gap after
 * a $0 statement is quiet. Two layouts, same content:
 *
 *   classic (2020-08 → 2025-02)  pdf.js drops the spaces inside words:
 *              "PreviousBalance $0.00", "PaymentsandOtherCredits -$4.15",
 *              "StatementClosingDate 8/19/2020", rows "Aug.11 TARGET.COM
 *              800-591-3869 $4.15" — the last row of a section can carry
 *              its section total glued on ("-$4.15-$4.15"); the interest row
 *              "INTERESTCHARGE-PURCHASES $4.90" has no date; YTD savings
 *              "You've saved $X this year!" is the "$X" line after
 *              "SaveatTargetandTarget.com" (missing on January statements).
 *   modern  (2025-04 → today)    spaced labels ("Previous Balance $0.00",
 *              "Total Credit Limit"), rows "10/13 TARGET.COM 800-591-3869 MN
 *              $161.00" under "Payments and Other Credits" / "Purchases and
 *              Other Debits", "Target Circle Card Savings this Year: $14.80".
 *
 * The 5% RedCard discount is taken off at the register — the card amounts
 * are already discounted, there's nothing to redeem. Each statement prints
 * the savings so far this calendar year; that's the card's "reward". Only
 * the last 4 digits are kept. See docs/statement-templates/targetCard.md. */

export interface TargetCardValues {
  accountLast: string;
  cardName: 'Target RedCard' | 'Target Circle Card';
  layout: 'classic' | 'modern';
  openingDate: string;
  closingDate: string;
  days: number | null;
  previousBalance: number;
  paymentsCredits: number; // negative
  purchasesDebits: number;
  fees: number;
  interest: number;
  newBalance: number;
  minimumPayment: number;
  dueDate: string | null;
  creditLine: number | null;
  availableCredit: number | null;
  purchaseApr: number | null;
  ytdYear: number | null;
  feesYtd: number | null;
  interestYtd: number | null;
  /** "You've saved $X this year" — Target savings in the closing year so far
   * (null when the statement doesn't print it, e.g. classic Januaries). */
  savingsYtd: number | null;
  /** From the activity rows (positive numbers). */
  paid: number;
  refunds: number; // returns credited back
  purchases: number; // gross purchase rows
  online: number; // Target.com purchases
  inStore: number; // store purchases
}

export type TargetTxnKind = 'purchase' | 'refund' | 'payment' | 'fee' | 'interest' | 'adjustment';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const num = (s: string) => Number(s.replace(/[,$\s]/g, ''));
const pad = (n: number | string) => String(n).padStart(2, '0');
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
function mdy(raw: string): string {
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) throw new UnreadableStatement(`Not a date: "${raw}"`);
  return `${m[3]}-${pad(m[1])}-${pad(m[2])}`;
}

/** Labels are matched with every space removed, so "Previous Balance $0.00"
 * and "PreviousBalance $0.00" read the same. Returns the signed value. */
function label(squashed: string[], name: string, required = false): number | null {
  const re = new RegExp(`^${name}([+-]?)\\$(-?[\\d,]*\\.\\d{2})$`, 'i');
  for (const l of squashed) {
    const m = l.match(re);
    if (m) {
      const v = num(m[2]);
      return m[1] === '-' ? -v : v;
    }
  }
  if (required) throw new UnreadableStatement(`Missing "${name}"`);
  return null;
}

export function targetTxnKind(desc: string, amount: number): TargetTxnKind {
  const d = desc.replace(/\s+/g, '').toUpperCase();
  if (/INTERESTCHARGE/.test(d)) return amount < 0 ? 'adjustment' : 'interest';
  if (/LATEPAYMENTFEE|RETURNEDPAYMENTFEE|\bFEE\b|FEE$/.test(d)) return amount < 0 ? 'adjustment' : 'fee';
  if (amount < 0) {
    if (/E-?PAY|PAYMENT|THANK/.test(d) && !/REFUND|RETURN/.test(d)) return 'payment';
    if (/CREDIT(FEE|INTEREST)|FEEREVERSAL|INTERESTREVERSAL|ADJ/.test(d)) return 'adjustment';
    return 'refund';
  }
  return 'purchase';
}

/** Target.com vs a store ("TARGET MOUNTKISCO,NY", "CENTRALCHECKOUT MTKISCO,NY"). */
export const isOnline = (desc: string) => /TARGET\.COM|800-591-3869/i.test(desc);

export function parseTargetCard(text: string): ParsedStatement {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const squashed = lines.map((l) => l.replace(/\s+/g, '').replace(/LatePaymentWarning:$/i, ''));
  if (!squashed.some((l) => /^PreviousBalance\$/i.test(l))) throw new UnreadableStatement('No Account Summary in the PDF’s text (a printed or scanned copy?)');
  const layout: TargetCardValues['layout'] = lines.some((l) => /^Previous Balance \$/.test(l)) ? 'modern' : 'classic';

  const closeLine = squashed.find((l) => /^StatementClosingDate:?\d{1,2}\/\d{1,2}\/\d{4}$/i.test(l));
  if (!closeLine) throw new UnreadableStatement('Missing "Statement Closing Date"');
  const closingDate = mdy(closeLine.replace(/^StatementClosingDate:?/i, ''));
  const daysLine = squashed.find((l) => /^DaysinBillingCycle\d+$/i.test(l));
  const days = daysLine ? Number(daysLine.replace(/\D/g, '')) : null;
  const openingDate = addDays(closingDate, -((days ?? 30) - 1));
  const dueLine = squashed.find((l) => /^PaymentDueDate:?\d{1,2}\/\d{1,2}\/\d{4}$/i.test(l));
  const dueDate = dueLine ? mdy(dueLine.replace(/^PaymentDueDate:?/i, '')) : null;

  const acctM = text.match(/(?:REDcard|Circle Card|Card) ?Ending ?in:? ?(\d{4})/i) ?? text.match(/Account ?Number ?Ending ?in:? ?(\d{4})/i);
  if (!acctM) throw new UnreadableStatement('Missing the card’s last 4 digits');
  const accountLast = acctM[1];
  const cardName: TargetCardValues['cardName'] = /Circle Card/i.test(text) ? 'Target Circle Card' : 'Target RedCard';

  const previousBalance = label(squashed, 'PreviousBalance', true)!;
  const paymentsCredits = label(squashed, 'PaymentsandOtherCredits', true)!;
  const purchasesDebits = label(squashed, 'PurchasesandOtherDebits', true)!;
  const fees = label(squashed, 'FeesCharged') ?? 0;
  const interest = label(squashed, 'InterestCharged') ?? 0;
  const newBalance = label(squashed, 'NewBalance', true)!;
  const minimumPayment = label(squashed, 'MinimumPaymentDue:?') ?? 0;
  const creditLine = label(squashed, '(?:Total)?CreditLimit');
  const availableCredit = label(squashed, 'AvailableCredit');
  const aprM = squashed.map((l) => l.match(/^Purchases(\d+\.\d+)%\(v\)/i)).find(Boolean);
  const feesYtdM = squashed.map((l) => l.match(/^TotalFeesCharged(?:in)?(\d{4})\$(-?[\d,]*\.\d{2})$/i)).find(Boolean);
  const intYtdM = squashed.map((l) => l.match(/^TotalInterestCharged(?:in)?(\d{4})\$(-?[\d,]*\.\d{2})$/i)).find(Boolean);

  // ---- Savings so far this year ----
  let savingsYtd: number | null = null;
  const modernSave = lines.findIndex((l) => /Savings this Year:/i.test(l));
  if (modernSave >= 0) {
    const m = lines[modernSave].match(/\$([\d,]*\.\d{2})/) ?? lines[modernSave + 1]?.match(/^\$([\d,]*\.\d{2})$/);
    if (m) savingsYtd = num(m[1]);
  } else {
    const k = squashed.findIndex((l) => /^SaveatTargetandTarget\.com$/i.test(l));
    const m = k >= 0 ? squashed[k + 1]?.match(/^\$([\d,]*\.\d{2})$/) : null;
    if (m) savingsYtd = num(m[1]);
  }

  // ---- Transactions ----
  const closeY = Number(closingDate.slice(0, 4));
  const closeM = Number(closingDate.slice(5, 7));
  const yearFor = (m: number) => (m > closeM ? closeY - 1 : closeY);
  const AMT = String.raw`(-?)\$([\d,]*\.\d{2})`;
  const classicRow = new RegExp(String.raw`^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?(\d{1,2}) (.+?) ?${AMT}(?:-?\$[\d,]*\.\d{2})?$`);
  const modernRow = new RegExp(String.raw`^(\d{1,2})\/(\d{1,2}) (.+?) ${AMT}$`);
  const interestRow = new RegExp(String.raw`^INTEREST ?CHARGE ?- ?PURCHASES ${AMT}(?:-?\$[\d,]*\.\d{2})?$`, 'i');
  const transactions: ParsedTransaction[] = [];
  const push = (date: string, description: string, sign: string, amt: string) => {
    const amount = sign === '-' ? -num(amt) : num(amt);
    if (amount === 0) return;
    const desc = description.replace(/\s+/g, ' ').trim();
    transactions.push({ date, description: desc, kind: targetTxnKind(desc, amount), amount, units: null, unitPrice: null });
  };
  for (const l of lines) {
    const c = layout === 'classic' ? l.match(classicRow) : null;
    if (c) {
      const mo = MONTHS.indexOf(c[1].toLowerCase()) + 1;
      push(`${yearFor(mo)}-${pad(mo)}-${pad(c[2])}`, c[3], c[4], c[5]);
      continue;
    }
    const m = layout === 'modern' ? l.match(modernRow) : null;
    if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) {
      push(`${yearFor(Number(m[1]))}-${pad(m[1])}-${pad(m[2])}`, m[3], m[4], m[5]);
      continue;
    }
    const ir = l.match(interestRow);
    if (ir) push(closingDate, 'INTEREST CHARGE - PURCHASES', ir[1], ir[2]);
  }

  const sumKinds = (...kinds: TargetTxnKind[]) => round2(transactions.filter((t) => kinds.includes(t.kind as TargetTxnKind)).reduce((s, t) => s + t.amount, 0));
  const purchaseRows = transactions.filter((t) => t.kind === 'purchase');
  const values: TargetCardValues = {
    accountLast,
    cardName,
    layout,
    openingDate,
    closingDate,
    days,
    previousBalance,
    paymentsCredits,
    purchasesDebits,
    fees,
    interest,
    newBalance,
    minimumPayment,
    dueDate,
    creditLine,
    availableCredit,
    purchaseApr: aprM ? Number(aprM[1]) : null,
    ytdYear: feesYtdM ? Number(feesYtdM[1]) : intYtdM ? Number(intYtdM[1]) : null,
    feesYtd: feesYtdM ? num(feesYtdM[2]) : null,
    interestYtd: intYtdM ? num(intYtdM[2]) : null,
    savingsYtd,
    paid: -sumKinds('payment'),
    refunds: -sumKinds('refund'),
    purchases: sumKinds('purchase'),
    online: round2(purchaseRows.filter((t) => isOnline(t.description)).reduce((s, t) => s + t.amount, 0)),
    inStore: round2(purchaseRows.filter((t) => !isOnline(t.description)).reduce((s, t) => s + t.amount, 0)),
  };

  const credits = sumKinds('payment', 'refund', 'adjustment');
  const checks: StatementCheck[] = [
    check(
      'Summary adds up',
      cents(previousBalance + paymentsCredits + purchasesDebits + fees + interest, newBalance),
      `${previousBalance} ${paymentsCredits} +${purchasesDebits} +${fees} +${interest} vs ${newBalance}`
    ),
    check('Payments & credits match activity', cents(credits, paymentsCredits), `rows ${credits} vs summary ${paymentsCredits}`),
    check('Purchases match activity', cents(sumKinds('purchase'), purchasesDebits), `rows ${sumKinds('purchase')} vs summary ${purchasesDebits}`),
    check('Fees match activity', cents(sumKinds('fee'), fees), `rows ${sumKinds('fee')} vs summary ${fees}`),
    check('Interest matches activity', cents(sumKinds('interest'), interest), `rows ${sumKinds('interest')} vs summary ${interest}`),
  ];
  // Available credit isn't checked: it reflects pending charges.
  return { periodStart: openingDate, periodEnd: closingDate, values: values as unknown as Record<string, unknown>, transactions, checks };
}

/** Statement-to-statement (derive time, oldest first): the balance carries
 * over, and savings so far this year never go down within a year. */
export function crossCheckTargetCard(prev: { values: TargetCardValues } | null, cur: { values: TargetCardValues }): StatementCheck[] {
  if (!prev) return [];
  const p = prev.values, c = cur.values;
  const out: StatementCheck[] = [];
  if (addDays(p.closingDate, 1) <= c.openingDate && c.openingDate <= addDays(p.closingDate, 3)) {
    out.push(check('Previous balance carries over', cents(p.newBalance, c.previousBalance), `${p.newBalance} → ${c.previousBalance}`));
  }
  if (p.savingsYtd !== null && c.savingsYtd !== null && p.closingDate.slice(0, 4) === c.closingDate.slice(0, 4)) {
    out.push(check('Savings this year only grow', c.savingsYtd >= p.savingsYtd - 0.005, `${p.savingsYtd} → ${c.savingsYtd}`));
  }
  return out;
}
