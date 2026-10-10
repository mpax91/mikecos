import { check, cents, round2, UnreadableStatement } from '../common';
import type { ParsedStatement, ParsedTransaction, StatementCheck } from '../common';

/** Template #8 — Bank of America cash-back Visa (BankAmericard Cash Rewards,
 * later Customized Cash Rewards Visa Signature®) monthly credit card
 * statement, Drive folder "Bank of America Credit Card", files
 * "BOA CC - YYYY.MM.DD.pdf" (2014-06 → today, closing on the 26th since
 * 2015). Two layout eras, same content:
 *
 *   Era A (2014-06 → 2017-02)  dotted leaders — "Previous Balance . . .
 *                   $421.60", "Payments and Other Credits ......  421.60"
 *                   (the minus sign is an unmapped glyph, so the credit
 *                   lines' sign comes from the section), dates "1/26/16";
 *                   rewards block "Rewards" with "3.10 BASE EARNED THIS
 *                   MONTH", "3.10 BONUS THIS MONTH", "46.49 REDEEMED",
 *                   "6.20 TOTAL AVAILABLE"
 *   Era B (2017-03 → today)    "Previous Balance $ 426.00", "New Balance
 *                   Total -$ 63.28", dates "09/26/2026"; "Your Reward
 *                   Summary" with "1.02 Base Cash Back Earned", "2.03
 *                   Category Bonus Earned", ".33 Relationship Bonus Earned",
 *                   "273.14 Cash Back Redeemed", "6.64 Total Cash Back
 *                   Available"
 *
 * Both eras: the period line "August 27 - September 26, 2026", "Statement
 * Closing Date", "Days in Billing Cycle", credit / cash lines, "Payment Due
 * Date", "Total Minimum Payment Due", the APR table ("Purchases 23.49%V"),
 * "Penalty APR of 29.99%", "Total fees/interest charged in YYYY".
 * Transactions are sections ("Payments and Other Credits", "Purchases and
 * Adjustments", "Fees Charged", "Interest Charged") of rows
 * "MM/DD MM/DD <description> <ref> [<acct last 4>] [sign] <amount>"; the
 * ref/amount tail can sit a few lines below (era A continuation lines like
 * "SALES TAX AMT 0.01"). The sign glyph is "-", an unmapped U+0096 or —
 * in some PDFs' font — the digit "6"; a credit's sign is taken from its
 * section (or, in Purchases and Adjustments, from that glyph).
 *
 * Rewards are exact here: every statement prints what was earned that
 * month, what was redeemed and the balance available. Only the card's last
 * 4 digits are ever kept. Year-end summaries ("BOA CC - 2024.pdf") are
 * skipped by file name. See docs/statement-templates/bofaCard.md. */

export interface BofaRewards {
  base: number; // base cash back earned this statement
  bonus: number; // category / grocery / "other" bonus earned
  relationship: number; // Preferred Rewards relationship bonus
  earned: number; // base + bonus + relationship
  redeemed: number;
  available: number;
}

export interface BofaCardValues {
  accountLast: string; // last 4 digits — how Wallet matches cards
  cardType: string | null; // "Visa Signature" when printed (2021 →)
  openingDate: string;
  closingDate: string;
  days: number | null;
  previousBalance: number; // negative = credit balance
  paymentsCredits: number; // negative
  purchasesAdjustments: number; // net of adjustment credits
  fees: number;
  interest: number;
  newBalance: number;
  minimumPayment: number;
  dueDate: string | null;
  creditLine: number | null;
  availableCredit: number | null;
  cashLine: number | null;
  availableCash: number | null;
  apr: { purchases: number | null; balanceTransfers: number | null; cashAdvances: number | null };
  penaltyApr: number | null;
  ytdYear: number | null;
  feesYtd: number | null;
  interestYtd: number | null;
  rewards: BofaRewards | null;
  /** From the activity rows (all positive numbers). */
  paid: number;
  refunds: number; // merchant credits (incl. negative adjustments)
  rewardCredits: number; // cash back redeemed as a statement credit
  purchases: number; // gross charges (purchase rows)
  /** "BA ELECTRONIC PAYMENT" = Bank of America's own scheduled (AutoPay)
   * payment; online / phone payments are manual. null = no payment. */
  autopay: boolean | null;
}

export type BofaTxnKind = 'purchase' | 'refund' | 'payment' | 'reward' | 'adjustment' | 'fee' | 'interest' | 'cash_advance';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const SIGN = String.raw`(?:[-\u0096–−]|6)`;
const AMT = String.raw`[\d,]*\.\d{2}`;
/** Row tail: "<ref> [<acct>] [sign] <amount>" — ref is 4 alphanumerics. */
const TAIL = new RegExp(String.raw`^(.*?)(?:^| )([0-9A-Z]{4})(?: (\d{4}))?\s+(?:(${SIGN})\s+)?(${AMT})$`);
/** "MM/DD MM/DD …" (transaction + posting date); a few 2014 rows print
 * only the posting date. */
const ROW = /^(?:(\d{2})\/(\d{2}) )?(\d{2})\/(\d{2})(?: (.*))?$/;

const num = (s: string) => Number(s.replace(/[,$\s]/g, ''));
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** "1/26/16", "01/26/2016" → "2016-01-26". */
function anyMdy(raw: string): string {
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) throw new UnreadableStatement(`Not a date: "${raw}"`);
  const y = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

/** Era A dotted leaders → one space ("Fees Charged ......0.00" →
 * "Fees Charged 0.00"); also squashes "$ 12.00" → "$12.00". */
function normalize(line: string): string {
  return line
    .replace(/\s*(?:\.\s*){3,}/g, ' ')
    .replace(/\$ (?=[\d,]*\.\d{2})/g, '$')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Label [-]$1,234.56" / "Label 421.60" / "Label \u0096 421.60". Returns
 * the signed value; `credit` lines (unmapped minus) are negated. */
function labelValue(lines: string[], label: string, opts: { credit?: boolean; required?: boolean } = {}): number | null {
  // A "6" sign glyph is always followed by a space ("6 23.59"); "62.30" is a number.
  const re = new RegExp(String.raw`^${label} (?:([-\u0096\u2013\u2212] ?|6 |6(?=\$)))?(-)?\$?(-)?(${AMT})$`);
  for (const l of lines) {
    const m = l.match(re);
    if (!m) continue;
    const v = num(m[4]);
    const neg = !!(m[1] || m[2] || m[3]);
    if (opts.credit) return v === 0 ? 0 : -v;
    return neg ? -v : v;
  }
  if (opts.required) throw new UnreadableStatement(`Missing "${label}"`);
  return null;
}

export function bofaTxnKind(desc: string, section: string, amount: number): BofaTxnKind {
  if (/^INTEREST CHARGED/i.test(desc) || section === 'interest') return 'interest';
  if (section === 'fees' || /\bLATE FEE FOR\b|\bANNUAL FEE\b|\bFOREIGN TRANSACTION FEE\b|^CASH ADVANCE FEE\b|^BALANCE TRANSFER FEE\b/i.test(desc)) return amount < 0 ? 'adjustment' : 'fee';
  if (amount < 0) {
    if (/PAYMENT/i.test(desc) && !/REFUND/i.test(desc)) return 'payment';
    if (/CASH REWARDS|CASH BACK/i.test(desc)) return 'reward';
    if (/REFUND|REVERSAL|ADJUSTMENT|CREDIT ADJ/i.test(desc) && /FEE|INTEREST|FINANCE/i.test(desc)) return 'adjustment';
    return 'refund';
  }
  if (/CASH ADVANCE|ATM WITHDRAWAL/i.test(desc)) return 'cash_advance';
  return 'purchase';
}

/** The rewards block: "<amount> <label>" lines after "Rewards" / "Your
 * Reward Summary". */
function parseRewards(lines: string[]): BofaRewards | null {
  const start = lines.findIndex((l) => l === 'Your Reward Summary' || l === 'Rewards');
  if (start < 0) return null;
  const r: BofaRewards = { base: 0, bonus: 0, relationship: 0, earned: 0, redeemed: 0, available: 0 };
  let sawTotal = false;
  for (let k = start + 1; k < Math.min(lines.length, start + 12); k++) {
    const m = lines[k].match(/^(-?[\d,]*\.\d{2}) (.+)$/);
    if (!m) {
      if (/CASH REWARDS$/i.test(lines[k])) continue; // "BANKAMERICARD CASH REWARDS"
      if (sawTotal || k > start + 1) break;
      continue;
    }
    const v = num(m[1]);
    const label = m[2];
    if (/TOTAL (CASH BACK )?AVAILABLE/i.test(label)) {
      r.available = v;
      sawTotal = true;
    } else if (/REDEEMED/i.test(label)) r.redeemed = round2(r.redeemed + v);
    else if (/^BASE/i.test(label)) r.base = round2(r.base + v);
    else if (/RELATIONSHIP/i.test(label)) r.relationship = round2(r.relationship + v);
    else if (/BONUS|EARNED/i.test(label)) r.bonus = round2(r.bonus + v);
  }
  if (!sawTotal) return null;
  r.earned = round2(r.base + r.bonus + r.relationship);
  return r;
}

export function parseBofaCard(text: string): ParsedStatement {
  const raw = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const lines = raw.map(normalize);

  // ---- Period + closing ----
  const periodM = text.match(/\b([A-Z][a-z]+) (\d{1,2}) - ([A-Z][a-z]+) (\d{1,2}), (\d{4})\b/);
  const closingLine = lines.find((l) => /^Statement Closing Date \d/.test(l));
  if (!closingLine && !periodM) {
    throw new UnreadableStatement('No Account Summary in the PDF’s text (a printed or scanned copy?)');
  }
  if (!lines.some((l) => /^Previous Balance /.test(l))) throw new UnreadableStatement('No Account Summary in the PDF’s text (a printed or scanned copy?)');
  const closingDate = closingLine ? anyMdy(closingLine.replace(/^Statement Closing Date /, '')) : '';
  if (!closingDate) throw new UnreadableStatement('Missing "Statement Closing Date"');
  let openingDate: string;
  if (periodM) {
    const om = MONTHS.indexOf(periodM[1].toLowerCase()) + 1;
    const cm = MONTHS.indexOf(periodM[3].toLowerCase()) + 1;
    const cy = Number(periodM[5]);
    const oy = om > cm ? cy - 1 : cy;
    openingDate = `${oy}-${String(om).padStart(2, '0')}-${String(Number(periodM[2])).padStart(2, '0')}`;
  } else {
    openingDate = addDays(closingDate, -30);
  }
  const daysLine = lines.find((l) => /^Days in Billing Cycle \d+$/.test(l));
  const days = daysLine ? Number(daysLine.replace(/\D/g, '')) : null;

  // The full card number prints on every page — keep only the last 4.
  const acctM = text.match(/Account(?:#| #| Number:)\s*\d{4} \d{4} \d{4} (\d{4})/);
  if (!acctM) throw new UnreadableStatement('Missing the account number');
  const accountLast = acctM[1];
  const cardType = /^Visa Signature/m.test(text) ? 'Visa Signature' : null;

  // ---- Account summary ----
  const previousBalance = labelValue(lines, 'Previous Balance', { required: true })!;
  const paymentsCredits = labelValue(lines, 'Payments and Other Credits', { credit: true, required: true })!;
  const purchasesAdjustments = labelValue(lines, 'Purchases and Adjustments', { required: true })!;
  const fees = labelValue(lines, 'Fees Charged', { required: true })!;
  const interest = labelValue(lines, 'Interest Charged', { required: true })!;
  const newBalance = labelValue(lines, 'New Balance Total', { required: true })!;
  const minimumPayment = labelValue(lines, 'Total Minimum Payment Due') ?? 0;
  const dueLine = lines.find((l) => /^Payment Due Date \d{1,2}\/\d{1,2}\/\d{2,4}$/.test(l));
  const dueDate = dueLine ? anyMdy(dueLine.replace(/^Payment Due Date /, '')) : null;
  const creditLine = labelValue(lines, 'Total Credit Line');
  const availableCredit = labelValue(lines, 'Total Credit Available');
  const cashLine = labelValue(lines, 'Cash Credit Line');
  let availableCash = labelValue(lines, 'for Cash');
  if (availableCash === null) availableCash = labelValue(lines, 'Portion of Credit Available for Cash');

  // ---- APRs ----
  const aprAfter = (label: RegExp): number | null => {
    for (let i = 0; i < lines.length; i++) {
      if (!label.test(lines[i])) continue;
      const inline = lines[i].match(/ (\d+\.\d+)% ?V\b/);
      if (inline) return Number(inline[1]);
      // Era A promo layout: "Purchases" / "Promotional APR" / "19.99%" / …
      for (let k = i + 1; k <= i + 3 && k < lines.length; k++) {
        const m = lines[k].match(/^(\d+\.\d+)% ?V?$/);
        if (m) return Number(m[1]);
      }
    }
    return null;
  };
  const apr = {
    purchases: aprAfter(/^Purchases(?: \d+\.\d+% ?V\b.*)?$/),
    balanceTransfers: aprAfter(/^Balance Transfers \d+\.\d+% ?V\b/),
    cashAdvances: aprAfter(/^Bank Cash Advances \d+\.\d+% ?V\b/),
  };
  const penaltyM = text.match(/Penalty APR of (\d+\.\d+)%/);
  const feesYtdM = lines.map((l) => l.match(/^Total fees charged in (\d{4}) \$(-?[\d,]*\.\d{2})$/)).find(Boolean);
  const intYtdM = lines.map((l) => l.match(/^Total interest charged in (\d{4}) \$(-?[\d,]*\.\d{2})$/)).find(Boolean);

  // ---- Transactions ----
  const transactions: ParsedTransaction[] = [];
  const sectionOf: string[] = []; // parallel to transactions
  let section: 'payments' | 'purchases' | 'fees' | 'interest' | null = null;
  const closeY = Number(closingDate.slice(0, 4));
  const closeM = Number(closingDate.slice(5, 7));
  const rowDate = (mm: string, dd: string) => {
    const y = Number(mm) > closeM ? closeY - 1 : closeY;
    return `${y}-${mm}-${dd}`;
  };
  for (let i = 0; i < raw.length; i++) {
    const l = raw[i].replace(/\s+/g, ' ');
    if (/^Payments and Other Credits$/.test(l)) section = 'payments';
    else if (/^Purchases and Adjustments$/.test(l)) section = 'purchases';
    else if (/^Fees(?: Charged)?$/.test(l)) section = 'fees';
    else if (/^Interest Charged$/.test(l)) section = 'interest';
    else if (/^(Interest Charge Calculation|\d{4} Totals Year-to-Date)$/.test(l)) section = null;
    if (!section) continue;
    const m = l.match(ROW);
    if (!m) continue;
    // Description + tail may continue on the next few lines.
    let body = (m[5] ?? '').trim();
    let tail = body.match(TAIL);
    let k = i;
    while (!tail && k + 1 < raw.length && k < i + 5) {
      const next = raw[k + 1].replace(/\s+/g, ' ').trim();
      if (ROW.test(next) || /^TOTAL /.test(next)) break;
      k++;
      body = `${body} ${next}`.trim();
      tail = body.match(TAIL);
    }
    if (!tail) continue;
    i = k;
    let desc = tail[1].trim();
    // Era A continuation lines ("16639994000303", "SALES TAX AMT 0.01") aren't description.
    // Era A continuation lines (a 14-digit terminal id, "SALES TAX AMT 0.01")
    // and long reference tokens ("01852722307MV3Y7000359229", "CONF#M0425…")
    // aren't part of the description.
    desc = desc
      .replace(/ SALES TAX AMT [\d.]+/g, '')
      .replace(/ CONF#\S+/g, '')
      .replace(/ (?=\S*\d{6})\S{10,}/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    let amount = num(tail[5]);
    if (amount === 0) continue; // the "INTEREST CHARGED ON … 0.00" placeholder rows
    if (section === 'payments' || tail[4]) amount = -amount;
    transactions.push({ date: rowDate(m[3], m[4]), description: desc, kind: bofaTxnKind(desc, section, amount), amount, units: null, unitPrice: null });
    sectionOf.push(section);
  }

  const sum = (pred: (t: ParsedTransaction) => boolean) => round2(transactions.filter(pred).reduce((s, t) => s + t.amount, 0));
  const sumKind = (...kinds: BofaTxnKind[]) => sum((t) => kinds.includes(t.kind as BofaTxnKind));
  const hasPayment = transactions.some((t) => t.kind === 'payment');
  const rewards = parseRewards(lines);

  const values: BofaCardValues = {
    accountLast,
    cardType,
    openingDate,
    closingDate,
    days,
    previousBalance,
    paymentsCredits,
    purchasesAdjustments,
    fees,
    interest,
    newBalance,
    minimumPayment,
    dueDate,
    creditLine,
    availableCredit,
    cashLine,
    availableCash,
    apr,
    penaltyApr: penaltyM ? Number(penaltyM[1]) : null,
    ytdYear: feesYtdM ? Number(feesYtdM[1]) : null,
    feesYtd: feesYtdM ? num(feesYtdM[2]) : null,
    interestYtd: intYtdM ? num(intYtdM[2]) : null,
    rewards,
    paid: -sumKind('payment'),
    refunds: -sumKind('refund'),
    rewardCredits: -sumKind('reward'),
    purchases: sumKind('purchase', 'cash_advance'),
    autopay: hasPayment ? transactions.some((t) => t.kind === 'payment' && /^BA ELECTRONIC PAYMENT/i.test(t.description)) : null,
  };

  // Each section's rows add up to its Account Summary line.
  const bySection = (name: string) => round2(transactions.filter((_, i) => sectionOf[i] === name).reduce((s, t) => s + t.amount, 0));
  const checks: StatementCheck[] = [
    check(
      'Summary adds up',
      cents(previousBalance + paymentsCredits + purchasesAdjustments + fees + interest, newBalance),
      `${previousBalance} ${paymentsCredits} +${purchasesAdjustments} +${fees} +${interest} vs ${newBalance}`
    ),
    check('Payments & credits match activity', cents(bySection('payments'), paymentsCredits), `rows ${bySection('payments')} vs summary ${paymentsCredits}`),
    check('Purchases & adjustments match activity', cents(bySection('purchases'), purchasesAdjustments), `rows ${bySection('purchases')} vs summary ${purchasesAdjustments}`),
    check('Fees match activity', cents(bySection('fees'), fees), `rows ${bySection('fees')} vs summary ${fees}`),
    check('Interest matches activity', cents(bySection('interest'), interest), `rows ${bySection('interest')} vs summary ${interest}`),
  ];
  if (creditLine !== null && availableCredit !== null && newBalance >= 0) {
    checks.push(check('Available credit adds up', cents(creditLine - newBalance, availableCredit), `${creditLine} − ${newBalance} vs ${availableCredit}`));
  }
  if (rewards && rewards.available < 0) checks.push(check('Cash back available is positive', false, String(rewards.available)));
  return { periodStart: openingDate, periodEnd: closingDate, values: values as unknown as Record<string, unknown>, transactions, checks };
}

/** Statement-to-statement checks (derive time, oldest first): the balance
 * carries over, and cash back available = previous available + earned −
 * redeemed. */
export function crossCheckBofaCard(prev: { values: BofaCardValues } | null, cur: { values: BofaCardValues }): StatementCheck[] {
  if (!prev) return [];
  const p = prev.values, c = cur.values;
  if (addDays(p.closingDate, 1) !== c.openingDate) return [];
  const out = [check('Previous balance carries over', cents(p.newBalance, c.previousBalance), `${p.newBalance} → ${c.previousBalance}`)];
  if (p.rewards && c.rewards) {
    const expect = round2(p.rewards.available + c.rewards.earned - c.rewards.redeemed);
    out.push(check('Cash back carries over', cents(expect, c.rewards.available), `${p.rewards.available} + ${c.rewards.earned} − ${c.rewards.redeemed} vs ${c.rewards.available}`));
  }
  return out;
}
