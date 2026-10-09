import { check, cents, money, round2, NotAStatement, UnreadableStatement } from '../common';
import type { ParsedStatement, ParsedTransaction, StatementCheck } from '../common';

/** Template #7 — American Express Blue Cash Everyday® monthly credit card
 * statement, Drive folder "American Express Credit Card", files
 * "AMEX CC - YYYY.MM.pdf" (2019-08 → today, closing around the 27th/28th).
 * One Amex layout for the card's whole life; only the PDF's internal text
 * ORDER changes — some years (e.g. 2023) come out of pdf.js with labels and
 * values far apart — so nothing here depends on line order beyond
 * "label block, then its values" and "a row's amount follows its date line".
 *
 *   front page      "Closing Date MM/DD/YY", "Account Ending 8-61003",
 *                   "New Balance $x" (credit balances print "CR$x"),
 *                   "Minimum Payment Due $x", "Payment Due Date MM/DD/YY"
 *                   (absent when nothing is due)
 *   Account Summary labels Previous Balance / Payments/Credits / New Charges
 *                   / Fees / Interest Charged, then the five values in order
 *                   (same for Credit Limit / Available Credit and Cash
 *                   Advance Limit / Available Cash, two at a time)
 *   Reward Dollars  cash-back balance "as of" the PREVIOUS closing date
 *                   (Amex credits a month's reward dollars once its minimum
 *                   payment is in). Redemptions post as "YOUR CASH
 *                   REWARD/REFUND IS" credits.
 *   activity        "MM/DD/YY[*] <merchant>" then detail lines, the amount
 *                   on the row line or on its own line ("$13.23",
 *                   "-$171.54"); payments, credits, new charges, "Late
 *                   Payment Fee" and "Interest Charge on Purchases" rows
 *   interest        "Purchases <date> 16.74% (v) …", "Days in Billing
 *                   Period: 30", "Total Fees/Interest in YYYY $x"
 *
 * Some files in the folder are Amex "important notice" letters (terms
 * changes) saved under a statement's name — they're Skipped (NotAStatement),
 * as are the year-end summaries ("AMEX CC - 2024.pdf", by file name). Only
 * the account's last digits are ever kept. See
 * docs/statement-templates/amexCard.md. */

export interface AmexCardValues {
  accountEnding: string; // "8-61003" as printed
  accountLast: string; // last 4 digits ("1003") — how Wallet matches cards
  openingDate: string;
  closingDate: string;
  days: number | null;
  previousBalance: number; // negative = credit balance
  paymentsCredits: number; // negative
  newCharges: number;
  fees: number;
  interest: number;
  newBalance: number;
  minimumPayment: number;
  dueDate: string | null;
  creditLine: number | null;
  availableCredit: number | null;
  cashLine: number | null;
  availableCash: number | null;
  apr: { purchases: number | null; cashAdvances: number | null };
  /** The card's penalty APR, from the late-payment warning ("…increased to
   * the Penalty APR of 29.99%"). A purchase APR at this rate = penalty. */
  penaltyApr: number | null;
  ytdYear: number | null;
  feesYtd: number | null;
  interestYtd: number | null;
  /** Reward dollars balance and the date it's "as of" (the previous
   * closing — Amex posts a cycle's cash back after its payment). */
  rewardDollars: number | null;
  rewardDollarsAsOf: string | null;
  /** From the activity rows (all positive numbers). */
  paid: number; // "ONLINE PAYMENT - THANK YOU" / AutoPay rows
  refunds: number; // merchant credits
  rewardCredits: number; // reward dollars redeemed as a statement credit
  purchases: number; // new charges excluding fees and interest (= New Charges)
  autopay: boolean | null; // an AutoPay payment on this statement (null = no payment)
}

export type AmexCardTxnKind = 'purchase' | 'refund' | 'payment' | 'reward' | 'adjustment' | 'fee' | 'interest' | 'cash_advance';

const MONEY_RE = String.raw`(?:CR)?-?\$[\d,]*\.\d{2}`;
const ONLY_MONEY = new RegExp(String.raw`^[+-]?${MONEY_RE}$`);
const TRAILING_MONEY = new RegExp(String.raw`^(.*?) ([+-]?${MONEY_RE})$`);
/** "CR$24.77" → -24.77, "+$29.00" → 29, "-$171.54" → -171.54. */
const amt = (raw: string): number => {
  const s = raw.trim().replace(/^\+/, '');
  if (/^CR/.test(s)) return -Math.abs(money(s.slice(2)));
  return money(s);
};
/** "10/14/26" → "2026-10-14". */
const mdyy = (raw: string): string => {
  const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  if (!m) throw new UnreadableStatement(`Not a date: "${raw}"`);
  return `20${m[3]}-${m[1]}-${m[2]}`;
};
/** "08/28/2026" → "2026-08-28". */
const mdyyyy = (raw: string): string => {
  const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) throw new UnreadableStatement(`Not a date: "${raw}"`);
  return `${m[3]}-${m[1]}-${m[2]}`;
};
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** A block of labels on consecutive lines followed by their values on the
 * next lines, in the same order — or, in other eras, "label value" on one
 * line. Returns one value per label (null when not found). */
function labelBlock(lines: string[], labels: string[]): (number | null)[] | null {
  for (let i = 0; i + labels.length <= lines.length; i++) {
    if (!labels.every((l, k) => lines[i + k] === l)) continue;
    const vals = lines.slice(i + labels.length, i + 2 * labels.length);
    if (vals.length === labels.length && vals.every((v) => ONLY_MONEY.test(v))) return vals.map(amt);
  }
  // inline: "Previous Balance $171.54"
  const out = labels.map((l) => {
    const line = lines.find((x) => x.startsWith(`${l} `) && ONLY_MONEY.test(x.slice(l.length + 1)));
    return line ? amt(line.slice(l.length + 1)) : null;
  });
  return out.every((v) => v !== null) ? out : null;
}

/** Statement row descriptions → kind. */
export function amexTxnKind(desc: string, amount: number): AmexCardTxnKind {
  if (/^Interest Charge/i.test(desc)) return 'interest';
  if (/^(Late Payment|Returned Payment|Foreign Transaction|Annual|Cash Advance|Balance Transfer|Overlimit|Plan) Fee\b/i.test(desc)) return 'fee';
  if (amount < 0) {
    if (/PAYMENT - THANK YOU|AUTOPAY|^PAYMENT RECEIVED/i.test(desc)) return 'payment';
    if (/CASH REWARD|REWARD DOLLARS|REWARD\/REFUND/i.test(desc)) return 'reward';
    if (/^(STATEMENT CREDIT|ADJUSTMENT|FEE REVERSAL|INTEREST ADJ)/i.test(desc)) return 'adjustment';
    return 'refund';
  }
  if (/CASH ADVANCE/i.test(desc)) return 'cash_advance';
  return 'purchase';
}

const ROW = /^(\d{2})\/(\d{2})\/(\d{2})(\*?) (.*[A-Za-z].*)$/;

export function parseAmexCard(text: string): ParsedStatement {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const hasSummary = lines.includes('Previous Balance') || lines.some((l) => /^Previous Balance [-+C$]/.test(l));
  if (!hasSummary) {
    if (/important notice regarding the account|IMPORTANT NOTICES/i.test(text)) throw new NotAStatement('An American Express notice letter, not a statement');
    throw new UnreadableStatement('No Account Summary in the PDF’s text (a printed or scanned copy?)');
  }

  const closingM = text.match(/^(?:.* )?Closing Date (\d{2}\/\d{2}\/\d{2})\b/m);
  if (!closingM) throw new UnreadableStatement('Missing "Closing Date"');
  const closingDate = mdyy(closingM[1]);
  const endingM = text.match(/Account Ending (\d-\d{5})\b/);
  if (!endingM) throw new UnreadableStatement('Missing "Account Ending"');
  const accountEnding = endingM[1];
  const accountLast = accountEnding.replace(/\D/g, '').slice(-4);

  const summary = labelBlock(lines, ['Previous Balance', 'Payments/Credits', 'New Charges', 'Fees', 'Interest Charged']);
  if (!summary) throw new UnreadableStatement('Couldn’t read the Account Summary figures');
  const [previousBalance, paymentsCredits, newCharges, fees, interest] = summary as number[];

  const lineAmt = (label: string, required: boolean): number | null => {
    const l = lines.find((x) => x.startsWith(`${label} `) && ONLY_MONEY.test(x.slice(label.length + 1)));
    if (!l) {
      if (required) throw new UnreadableStatement(`Missing "${label}"`);
      return null;
    }
    return amt(l.slice(label.length + 1));
  };
  const newBalance = lineAmt('New Balance', true)!;
  const minimumPayment = lineAmt('Minimum Payment Due', true)!;
  const dueM = text.match(/^Payment Due Date (\d{2}\/\d{2}\/\d{2})$/m);
  const dueDate = dueM ? mdyy(dueM[1]) : null;

  const credit = labelBlock(lines, ['Credit Limit', 'Available Credit']);
  const cash = labelBlock(lines, ['Cash Advance Limit', 'Available Cash']);

  const daysM = text.match(/Days in Billing Period: (\d+)/);
  const days = daysM ? Number(daysM[1]) : null;
  const openingDate = addDays(closingDate, -((days ?? 30) - 1));

  const aprOf = (label: string) => {
    const m = text.match(new RegExp(String.raw`^${label} (?:\d{2}/\d{2}/\d{4} )?(\d+\.\d+)% \(v\)`, 'm'));
    return m ? Number(m[1]) : null;
  };
  const penaltyM = text.match(/Penalty APR of (\d+\.\d+)%/);
  const feesYtd = text.match(/^Total Fees in (\d{4}) (\$[\d,]*\.\d{2})$/m);
  const intYtd = text.match(/^Total Interest in (\d{4}) (\$[\d,]*\.\d{2})$/m);

  // Reward dollars: a bare "29.10" within a few lines after "Reward
  // Dollars", with its "as of MM/DD/YYYY" anywhere on the page.
  let rewardDollars: number | null = null;
  const rIdx = lines.indexOf('Reward Dollars');
  if (rIdx >= 0) {
    for (let k = rIdx + 1; k < Math.min(lines.length, rIdx + 6); k++) {
      if (/^[\d,]+\.\d{2}$/.test(lines[k])) {
        rewardDollars = Number(lines[k].replace(/,/g, ''));
        break;
      }
    }
  }
  const asOfM = text.match(/^as of (\d{2}\/\d{2}\/\d{4})$/m);
  const rewardDollarsAsOf = rewardDollars !== null && asOfM ? mdyyyy(asOfM[1]) : null;

  // ---- Activity rows ----
  const transactions: ParsedTransaction[] = [];
  const earliest = addDays(closingDate, -75);
  const latest = addDays(closingDate, 31);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ROW);
    if (!m) continue;
    const date = `20${m[3]}-${m[1]}-${m[2]}`;
    if (date < earliest || date > latest) continue;
    let rest = m[5].trim();
    let amount: number | null = null;
    const tm = rest.match(TRAILING_MONEY);
    if (tm) {
      rest = tm[1].trim();
      amount = amt(tm[2]);
    } else {
      for (let k = i + 1; k < lines.length && k <= i + 8; k++) {
        if (ROW.test(lines[k])) break;
        if (ONLY_MONEY.test(lines[k])) {
          amount = amt(lines[k]);
          i = k;
          break;
        }
      }
    }
    if (amount === null) continue;
    const desc = rest.replace(/\s+/g, ' ');
    transactions.push({ date, description: desc, kind: amexTxnKind(desc, amount), amount, units: null, unitPrice: null });
  }

  const sumKind = (...kinds: AmexCardTxnKind[]) => round2(transactions.filter((t) => kinds.includes(t.kind as AmexCardTxnKind)).reduce((s, t) => s + t.amount, 0));
  const credits = round2(transactions.filter((t) => t.amount < 0 && t.kind !== 'fee' && t.kind !== 'interest').reduce((s, t) => s + t.amount, 0));
  const charges = round2(transactions.filter((t) => t.amount > 0 && t.kind !== 'fee' && t.kind !== 'interest').reduce((s, t) => s + t.amount, 0));
  const hasPayment = transactions.some((t) => t.kind === 'payment');

  const values: AmexCardValues = {
    accountEnding,
    accountLast,
    openingDate,
    closingDate,
    days,
    previousBalance,
    paymentsCredits,
    newCharges,
    fees,
    interest,
    newBalance,
    minimumPayment,
    dueDate,
    creditLine: credit?.[0] ?? null,
    availableCredit: credit?.[1] ?? null,
    cashLine: cash?.[0] ?? null,
    availableCash: cash?.[1] ?? null,
    apr: { purchases: aprOf('Purchases'), cashAdvances: aprOf('Cash Advances') },
    penaltyApr: penaltyM ? Number(penaltyM[1]) : null,
    ytdYear: feesYtd ? Number(feesYtd[1]) : null,
    feesYtd: feesYtd ? money(feesYtd[2]) : null,
    interestYtd: intYtd ? money(intYtd[2]) : null,
    rewardDollars,
    rewardDollarsAsOf,
    paid: -sumKind('payment'),
    refunds: -sumKind('refund'),
    rewardCredits: -sumKind('reward'),
    purchases: round2(charges),
    autopay: hasPayment ? transactions.some((t) => t.kind === 'payment' && /AUTOPAY/i.test(t.description)) : null,
  };

  // Fees and interest are their own summary lines (not in New Charges).
  const checks: StatementCheck[] = [
    check(
      'Summary adds up',
      cents(previousBalance + paymentsCredits + newCharges + fees + interest, newBalance),
      `${previousBalance} ${paymentsCredits} +${newCharges} +${fees} +${interest} vs ${newBalance}`
    ),
    check('Payments & credits match activity', cents(credits, paymentsCredits), `rows ${credits} vs summary ${paymentsCredits}`),
    check('New charges match activity', cents(charges, newCharges), `rows ${charges} vs summary ${newCharges}`),
    check('Fees match activity', cents(sumKind('fee'), fees), `rows ${sumKind('fee')} vs summary ${fees}`),
    check('Interest matches activity', cents(sumKind('interest'), interest), `rows ${sumKind('interest')} vs summary ${interest}`),
  ];
  if (values.creditLine !== null && values.availableCredit !== null) {
    // Available credit = limit − balance (a credit balance adds to it).
    checks.push(check('Available credit adds up', cents(values.creditLine - newBalance, values.availableCredit), `${values.creditLine} − ${newBalance} vs ${values.availableCredit}`));
  }
  return { periodStart: openingDate, periodEnd: closingDate, values: values as unknown as Record<string, unknown>, transactions, checks };
}

/** Statement-to-statement checks (run at derive time, oldest first). */
export function crossCheckAmexCard(prev: { values: AmexCardValues } | null, cur: { values: AmexCardValues }): StatementCheck[] {
  if (!prev) return [];
  const p = prev.values, c = cur.values;
  // Only consecutive statements chain (a gap is flagged as a missing month instead).
  if (addDays(p.closingDate, 1) !== c.openingDate) return [];
  return [check('Previous balance carries over', cents(p.newBalance, c.previousBalance), `${p.newBalance} → ${c.previousBalance}`)];
}
