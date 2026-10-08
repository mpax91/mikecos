import { check, cents, field, money, round2, UnreadableStatement } from '../common';
import type { ParsedStatement, ParsedTransaction, StatementCheck } from '../common';

/** Template #5 — Amazon Prime Visa (Chase) monthly credit card statement,
 * Drive folder "Amazon Prime Credit Card", files "Amazon - YYYY.MM.DD.pdf"
 * (2014-09 → today, closing on the 17th). The same Chase card layout for
 * the card's whole life — only the rewards wording moved (3% back on
 * Amazon.com as the "Amazon.com Rewards Visa" until early 2017, then 5% as
 * the Prime card; "YOUR PRIME VISA POINTS" from 2023). Year-end "Annual
 * Summary" PDFs ("Amazon - 2015.pdf") share the folder and are skipped by
 * file name. Everything is read from pdf.js lines:
 *   ACCOUNT SUMMARY   "Previous Balance $x" … "New Balance $x",
 *                     "Opening/Closing Date MM/DD/YY - MM/DD/YY",
 *                     credit/cash lines and availability
 *   payment coupon    "Payment Due Date: MM/DD/YY", "Minimum Payment: $x"
 *                     ("Minimum Payment Due:" from 2023; no colon in 2015)
 *   points summary    "Previous points balance N", "+ <category> N" lines,
 *                     "- Points redeemed this statement period N",
 *                     "Total points available for redemption N" (sometimes
 *                     split over two lines)
 *   ACCOUNT ACTIVITY  "MM/DD <merchant> <amount>" rows (Amazon orders add
 *                     an "Order Number …" line; a few 2014-15 rows carry an
 *                     extra points column), plus LATE FEE / PURCHASE
 *                     INTEREST CHARGE rows and their "TOTAL … FOR THIS
 *                     PERIOD" lines
 *   INTEREST CHARGES  APR per balance type, "Total fees/interest charged in
 *                     YYYY $x"
 * Only the last 4 digits of the card number are ever kept. See
 * docs/statement-templates/amazon.md. */

export interface AmazonPointsLine {
  label: string; // "5% back on Amazon.com purchases"
  rate: number | null; // 5 (percent), null for bonuses/adjustments
  points: number;
}

export interface AmazonValues {
  accountLast: string;
  openingDate: string;
  closingDate: string;
  days: number | null;
  previousBalance: number;
  paymentsCredits: number; // negative (payments + refunds + statement credits)
  purchases: number;
  cashAdvances: number;
  balanceTransfers: number;
  fees: number;
  interest: number;
  newBalance: number;
  minimumPayment: number;
  dueDate: string | null;
  pastDue: number | null;
  overLimit: number | null;
  creditLine: number | null;
  availableCredit: number | null;
  cashLine: number | null;
  availableCash: number | null;
  apr: { purchases: number | null; cashAdvances: number | null; balanceTransfers: number | null };
  ytdYear: number | null;
  feesYtd: number | null;
  interestYtd: number | null;
  points: {
    previous: number;
    earned: AmazonPointsLine[];
    earnedTotal: number;
    redeemed: number;
    total: number;
  } | null;
  /** From the activity rows (all positive numbers). */
  paid: number; // "Payment Thank You…" rows
  refunds: number; // merchant credits
  rewardCredits: number; // "REDEMPTION CREDIT" rows (points spent on the balance)
  statementCredits: number; // "Statement Credit (Adjustment)" rows — fee/interest reversals etc.
  /** "SHOP WITH POINTS ACTIVITY": Amazon orders paid (partly) with points at
   * checkout. Not card activity — never part of the balance. */
  shopWithPoints: { date: string; description: string; amount: number; points: number }[];
  autopay: boolean | null; // a Chase AutoPay payment on this statement (null = no payment)
}

/** Transaction kinds stored for this card (statement_transactions.kind). */
export type AmazonTxnKind = 'purchase' | 'refund' | 'payment' | 'reward' | 'adjustment' | 'fee' | 'interest' | 'cash_advance';

const MONEY = String.raw`-?\$ ?[\d,]*\.\d{2}`;
const lineMoney = (text: string, label: string, required = true): number | null => {
  const m = text.match(new RegExp(String.raw`^${label} ([+-]? ?${MONEY})$`, 'm'));
  if (!m) {
    if (required) throw new UnreadableStatement(`Missing "${label}"`);
    return null;
  }
  return money(m[1].replace(/\s/g, ''));
};
const whole = (s: string) => Number(s.replace(/[^0-9-]/g, ''));
/** "10/14/26" → "2026-10-14". */
const mdyy = (raw: string): string => {
  const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  if (!m) throw new UnreadableStatement(`Not a date: "${raw}"`);
  return `20${m[3]}-${m[1]}-${m[2]}`;
};
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Activity row: date, description, amount, optional old points column. */
const TXN = /^(\d{2})\/(\d{2}) (.+?) (-?[\d,]*\.\d{2})(?: (-?[\d,]+))?$/;

export function txnKind(desc: string, amount: number): AmazonTxnKind {
  if (/^(LATE FEE|ANNUAL (MEMBERSHIP )?FEE|FOREIGN TRANSACTION FEE|RETURNED PAYMENT FEE|.* FEE)$/i.test(desc)) return 'fee';
  if (/INTEREST CHARGE/i.test(desc)) return 'interest';
  if (amount < 0) {
    if (/^(AUTOMATIC )?PAYMENT\b|^Payment Thank You/i.test(desc)) return 'payment';
    if (/^REDEMPTION CREDIT/i.test(desc)) return 'reward';
    if (/^STATEMENT CREDIT/i.test(desc)) return 'adjustment';
    return 'refund';
  }
  if (/CASH ADVANCE/i.test(desc)) return 'cash_advance';
  return 'purchase';
}

/** "+ 5% back on Amazon.com purchases" → 5. */
const pointsRate = (label: string) => {
  const m = label.match(/^(?:Extra )?(\d+(?:\.\d+)?)% back/i);
  return m && !/^Extra/i.test(label) ? Number(m[1]) : null;
};

export function parseAmazon(text: string): ParsedStatement {
  const lines = text.split('\n').map((l) => l.trim());
  // A printed/flattened copy keeps the labels but not the figures.
  if (!/^Opening\/Closing Date \d/m.test(text)) throw new UnreadableStatement('The account summary figures aren’t in the PDF’s text (a printed or scanned copy)');
  const accountLast = field(text, /^Account Number: (?:[X\d]{4} ){3}(\d{4})$/m);
  const [openRaw, closeRaw] = field(text, /^Opening\/Closing Date (\d{2}\/\d{2}\/\d{2} - \d{2}\/\d{2}\/\d{2})$/m).split(' - ');
  const openingDate = mdyy(openRaw);
  const closingDate = mdyy(closeRaw);

  const previousBalance = lineMoney(text, 'Previous Balance')!;
  const paymentsCredits = lineMoney(text, 'Payment, Credits')!;
  const purchases = lineMoney(text, 'Purchases')!;
  const cashAdvances = lineMoney(text, 'Cash Advances')!;
  const balanceTransfers = lineMoney(text, 'Balance Transfers')!;
  const fees = lineMoney(text, 'Fees Charged')!;
  const interest = lineMoney(text, 'Interest Charged')!;
  const newBalance = lineMoney(text, 'New Balance')!;
  const minimumPayment = money(field(text, /^Minimum Payment(?: Due)?:? (\$[\d,]*\.\d{2})$/m));
  const dueRaw = text.match(/^Payment Due Date:? (\d{2}\/\d{2}\/\d{2})$/m);
  const dueDate = dueRaw ? mdyy(dueRaw[1]) : null;
  const dollars = (label: string) => {
    const m = text.match(new RegExp(String.raw`^${label} \$([\d,]+)$`, 'm'));
    return m ? whole(m[1]) : null;
  };

  const aprOf = (label: string) => {
    const m = text.match(new RegExp(String.raw`^${label} (\d+\.\d+)%`, 'm'));
    return m ? Number(m[1]) : null;
  };
  const ytd = text.match(/^Total fees charged in (\d{4}) (\$[\d,]*\.\d{2})$/m);
  const ytdInt = text.match(/^Total interest charged in (\d{4}) (\$[\d,]*\.\d{2})$/m);
  const daysM = text.match(/^(\d+) Days in Billing Period$/m);

  // ---- Points summary ----
  let points: AmazonValues['points'] = null;
  const prevIdx = lines.findIndex((l) => /^Previous points balance -?[\d,]+$/.test(l));
  if (prevIdx >= 0) {
    const previous = whole(lines[prevIdx].replace(/^Previous points balance /, ''));
    const earned: AmazonPointsLine[] = [];
    let redeemed = 0;
    for (let i = prevIdx + 1; i < lines.length; i++) {
      const plus = lines[i].match(/^\+ (.+?) (-?[\d,]+)$/);
      const minus = lines[i].match(/^- Points redeemed this statement period ([\d,]+)$/);
      if (plus) earned.push({ label: plus[1], rate: pointsRate(plus[1]), points: whole(plus[2]) });
      else if (minus) redeemed += whole(minus[1]);
      else break;
    }
    const totalM = text.match(/^(?:= )?Total points available for redemption ([\d,]+)$/m) ?? text.match(/^Total points available for\nredemption ([\d,]+)$/m);
    if (!totalM) throw new UnreadableStatement('Missing "Total points available for redemption"');
    const earnedTotal = earned.reduce((s, e) => s + e.points, 0);
    points = { previous, earned, earnedTotal, redeemed, total: whole(totalM[1]) };
  }

  // ---- Activity ----
  // Rows under a "… $ Amount Rewards" header are SHOP WITH POINTS rows
  // (Amazon orders paid with points), not card activity; that run ends at
  // the first line that isn't a row.
  const transactions: ParsedTransaction[] = [];
  const shopWithPoints: AmazonValues['shopWithPoints'] = [];
  const latestOk = addDays(closingDate, 7);
  let inSwp = false;
  for (let i = 0; i < lines.length; i++) {
    if (/\$ Amount Rewards$/.test(lines[i])) {
      inSwp = true;
      continue;
    }
    const m = lines[i].match(TXN);
    if (!m) {
      if (!/^Order Number /.test(lines[i])) inSwp = false;
      continue;
    }
    let desc = m[3].replace(/\s+/g, ' ').trim();
    const amount = money(m[4]);
    let date = `${closingDate.slice(0, 4)}-${m[1]}-${m[2]}`;
    if (date > latestOk) date = `${Number(closingDate.slice(0, 4)) - 1}-${m[1]}-${m[2]}`;
    if (inSwp) {
      shopWithPoints.push({ date, description: desc, amount, points: m[5] ? whole(m[5]) : 0 });
      continue;
    }
    const order = lines[i + 1]?.match(/^Order Number (\S+)$/);
    if (order) desc = `${desc} · Order ${order[1]}`;
    transactions.push({ date, description: desc, kind: txnKind(m[3].trim(), amount), amount, units: null, unitPrice: null });
  }

  const sumKind = (...kinds: AmazonTxnKind[]) => round2(transactions.filter((t) => kinds.includes(t.kind as AmazonTxnKind)).reduce((s, t) => s + t.amount, 0));
  const credits = round2(transactions.filter((t) => t.amount < 0 && t.kind !== 'fee' && t.kind !== 'interest').reduce((s, t) => s + t.amount, 0));
  const charges = round2(transactions.filter((t) => t.amount > 0 && t.kind !== 'fee' && t.kind !== 'interest').reduce((s, t) => s + t.amount, 0));
  const autoPay = transactions.some((t) => t.kind === 'payment' && /AUTOMATIC PAYMENT|AUTOPAY/i.test(t.description));

  const values: AmazonValues = {
    accountLast,
    openingDate,
    closingDate,
    days: daysM ? Number(daysM[1]) : null,
    previousBalance,
    paymentsCredits,
    purchases,
    cashAdvances,
    balanceTransfers,
    fees,
    interest,
    newBalance,
    minimumPayment,
    dueDate,
    pastDue: lineMoney(text, 'Past Due Amount', false),
    overLimit: lineMoney(text, 'Balance over the Credit Access Line', false),
    creditLine: dollars('Credit (?:Access )?Line'),
    availableCredit: dollars('Available Credit'),
    cashLine: dollars('Cash Access Line'),
    availableCash: dollars('Available for Cash'),
    apr: { purchases: aprOf('Purchases'), cashAdvances: aprOf('Cash Advances'), balanceTransfers: aprOf('Balance Transfers?') },
    ytdYear: ytd ? Number(ytd[1]) : null,
    feesYtd: ytd ? money(ytd[2]) : null,
    interestYtd: ytdInt ? money(ytdInt[2]) : null,
    points,
    paid: -sumKind('payment'),
    refunds: -sumKind('refund'),
    rewardCredits: -sumKind('reward'),
    statementCredits: -sumKind('adjustment'),
    shopWithPoints,
    autopay: transactions.some((t) => t.kind === 'payment') ? autoPay : null,
  };

  const checks: StatementCheck[] = [
    check(
      'Summary adds up',
      cents(previousBalance + paymentsCredits + purchases + cashAdvances + balanceTransfers + fees + interest, newBalance),
      `${previousBalance} ${paymentsCredits} +${purchases} +${cashAdvances} +${balanceTransfers} +${fees} +${interest} vs ${newBalance}`
    ),
    check('Payments & credits match activity', cents(credits, paymentsCredits), `rows ${credits} vs summary ${paymentsCredits}`),
    check('Purchases match activity', cents(charges, purchases + cashAdvances + balanceTransfers), `rows ${charges} vs summary ${round2(purchases + cashAdvances + balanceTransfers)}`),
    check('Fees match activity', cents(sumKind('fee'), fees), `rows ${sumKind('fee')} vs summary ${fees}`),
    check('Interest matches activity', cents(sumKind('interest'), interest), `rows ${sumKind('interest')} vs summary ${interest}`),
  ];
  // A product change (3% → 5% card, 2017) moves points over with a
  // "Points transferred from other product" line that doesn't net against
  // the old balance, so those statements aren't points-checked.
  if (points && !points.earned.some((e) => /transferred from other product/i.test(e.label))) {
    const expect = points.previous + points.earnedTotal - points.redeemed;
    checks.push(check('Points add up', expect === points.total, `${points.previous} + ${points.earnedTotal} − ${points.redeemed} = ${expect} vs ${points.total}`));
  }
  return { periodStart: openingDate, periodEnd: closingDate, values: values as unknown as Record<string, unknown>, transactions, checks };
}

/** Statement-to-statement checks (run at derive time, oldest first). */
export function crossCheckAmazon(prev: { values: AmazonValues } | null, cur: { values: AmazonValues }): StatementCheck[] {
  if (!prev) return [];
  const p = prev.values, c = cur.values;
  const out: StatementCheck[] = [];
  // Only consecutive statements chain (a gap is flagged as a missing month instead).
  if (addDays(p.closingDate, 1) !== c.openingDate) return out;
  out.push(check('Previous balance carries over', cents(p.newBalance, c.previousBalance), `${p.newBalance} → ${c.previousBalance}`));
  // The 2017 product change zeroes the old balance and moves points over.
  const transfer = c.points?.earned.some((e) => /transferred from other product/i.test(e.label));
  if (p.points && c.points && !transfer) out.push(check('Points carry over', p.points.total === c.points.previous, `${p.points.total} → ${c.points.previous}`));
  return out;
}
