import { check, cents, fmtMoney, money, round2, UnreadableStatement } from '../common';
import type { ParsedStatement, ParsedTransaction, StatementCheck } from '../common';

/** Verizon Fios home internet monthly bills, Drive folder "Verizon Fios",
 * files "Verizon Fios - YYYY.MM.DD.pdf" (2020-01 → today). One Verizon
 * layout throughout; only the section headings inside "Details of Charges"
 * moved around (see docs/statement-templates/fios.md):
 *   page 1   "Bill Date : September 11, 2026", "Total Due by October 6 $84.99"
 *            (2020-01: "Total Due by Feb 5, 2020 : $58.74"), auto pay lines.
 *   page 2   "Your Discounts" table ("1 Gig - Streaming 99.99 -15.00 84.99"),
 *            "Discounts This Month -$15.00", "$10 expires 1/11/23." notes.
 *   page 3   "Details of Payments": Previous Balance / Payment Received -
 *            Thank You -84.99 9/1 / Balance Forward $.00 (or "No Payment
 *            Received" + "Past Due Pay Immediately $58.74").
 *            "Details of Charges": item lines "<desc> <amount> [M/D - M/D]
 *            [code]" under Services / Equipment / Discounts headings, a
 *            "Requested Change in Service" block (added / removed services,
 *            pro-rated — descriptions can wrap onto the next line), "Fees &
 *            Other Charges" / "Taxes" (sales tax, surcharges, late fee),
 *            "Subtotal $x [M/D - M/D]" lines, then "Total Due $x".
 *   page 4   "4 Year Internet Price Guarantee … will not change through
 *            5/23/27" (since 2023-06).
 * One statement per bill: periodStart = periodEnd = bill date. */

export type FiosItemKind = 'service' | 'equipment' | 'discount' | 'addon' | 'change' | 'tax' | 'fee';

export interface FiosItem {
  kind: FiosItemKind;
  description: string;
  amount: number;
  start: string | null; // service period, YYYY-MM-DD
  end: string | null;
  /** Requested Change in Service: 'added' | 'removed' and the change date. */
  change: 'added' | 'removed' | null;
  changeDate: string | null;
}

export interface FiosDiscountRow {
  description: string;
  price: number;
  discount: number; // negative
  youPay: number;
}

export interface FiosValues {
  account: string; // "556-150-493-0001-46"
  billDate: string;
  dueDate: string | null;
  autopay: boolean;
  autopayDate: string | null;
  previousBalance: number;
  payments: number; // payments received this cycle (negative)
  balanceForward: number;
  pastDue: boolean;
  currentCharges: number; // Σ items
  totalDue: number;
  plan: string | null; // "1 Gig - Streaming"
  speedMbps: number | null;
  planPrice: number | null; // the plan line as billed (Verizon folds some discounts into it)
  listPrice: number | null; // the plan's price before discounts (Your Discounts table)
  monthlyService: number; // Σ regular items (plan + equipment + add-ons + discounts), before taxes
  discounts: number; // Σ discount items + discounts folded into the plan line (negative)
  discountsThisMonth: number | null; // page 2 total (negative)
  taxes: number; // Σ taxes and surcharges
  lateFee: number;
  proration: number; // Σ Requested Change in Service items
  equipment: string[];
  addOns: string[]; // "Verizon Cloud 2 TB", "Disney+ on us"
  discountRows: FiosDiscountRow[];
  discountNotes: string[]; // "$10 expires 1/11/23."
  servicePeriodStart: string | null;
  servicePeriodEnd: string | null;
  priceGuaranteeUntil: string | null;
  items: FiosItem[];
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const pad = (n: number) => String(n).padStart(2, '0');
const AMT = String.raw`-?\$?[\d,]*\.\d{2}`;
const amt = (raw: string) => money(raw);

/** "September 11, 2026" / "Sep 11, 2026" → "2026-09-11". */
function longDate(raw: string): string {
  const m = raw.trim().match(/^([A-Za-z]+)\.? (\d{1,2}),? (\d{4})$/);
  const mi = m ? MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase().slice(0, 3))) : -1;
  if (!m || mi < 0) throw new UnreadableStatement(`Not a date: "${raw}"`);
  return `${m[3]}-${pad(mi + 1)}-${pad(Number(m[2]))}`;
}

/** Month + day with no year → the date nearest the bill date. */
function nearDate(month: number, day: number, ref: string): string {
  const refY = Number(ref.slice(0, 4));
  let best = '';
  let bestDiff = Infinity;
  for (const y of [refY - 1, refY, refY + 1]) {
    const iso = `${y}-${pad(month)}-${pad(day)}`;
    const diff = Math.abs(Date.parse(`${iso}T12:00:00Z`) - Date.parse(`${ref}T12:00:00Z`));
    if (diff < bestDiff) {
      best = iso;
      bestDiff = diff;
    }
  }
  return best;
}
const mdNear = (md: string, ref: string) => {
  const [m, d] = md.split('/').map(Number);
  return nearDate(m, d, ref);
};
/** "9/1" (a payment) — on or before the bill date. */
const mdBefore = (md: string, ref: string) => {
  const iso = mdNear(md, ref);
  return iso > ref ? `${Number(iso.slice(0, 4)) - 1}${iso.slice(4)}` : iso;
};
/** "Oct 6" (a due date) — on or after the bill date. */
const dayAfter = (monthName: string, day: number, ref: string) => {
  const mi = MONTHS.findIndex((x) => x.startsWith(monthName.toLowerCase().slice(0, 3)));
  if (mi < 0) return null;
  const iso = nearDate(mi + 1, day, ref);
  return iso < ref ? `${Number(iso.slice(0, 4)) + 1}${iso.slice(4)}` : iso;
};

/** "1 Gig - Streaming" → 1000, "Fios Home Internet: 300 Mbps" → 300,
 * "Fios Internet 200/200" → 200. */
export function fiosSpeed(plan: string | null): number | null {
  if (!plan) return null;
  let m = plan.match(/(\d+(?:\.\d+)?)\s*Gig\b/i);
  if (m) return Math.round(Number(m[1]) * 1000);
  m = plan.match(/(\d+)\s*Mbps/i) ?? plan.match(/Internet (\d+)\/\d+/i);
  return m ? Number(m[1]) : null;
}

const isPlan = (desc: string) => /internet|\bgig\b|mbps/i.test(desc) && !/discount|router|rent/i.test(desc);

const ITEM_RE = new RegExp(
  String.raw`^(.*?)\s*(?:\b(added|removed)\s+)?(?:(?<=^|\s)(\d{1,2}\/\d{1,2})\s+)?(${AMT})(?:\s+(\d{1,2}\/\d{1,2})\s*-\s*(\d{1,2}\/\d{1,2}))?(?:\s+([A-Z][A-Z0-9]*))?$`
);

export function parseFios(text: string): ParsedStatement {
  if (!/Fios|verizon/i.test(text) || !/Details of Charges/.test(text)) throw new UnreadableStatement('Not a Verizon Fios bill');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  // ---- Page 1 ----
  const bd = text.match(/Bill Date ?: ?([A-Z][a-z]+\.? \d{1,2}, \d{4})/);
  if (!bd) throw new UnreadableStatement('No bill date');
  const billDate = longDate(bd[1]);
  const account = text.match(/Account Number: ?([\d-]{10,})/)?.[1] ?? '';
  let dueDate: string | null = null;
  let page1Total: number | null = null;
  const due = text.match(new RegExp(String.raw`Total Due by ([A-Z][a-z]+) (\d{1,2})(?:, (\d{4}))?\s*:?\s*(${AMT})`));
  if (due) {
    dueDate = due[3] ? longDate(`${due[1]} ${due[2]}, ${due[3]}`) : dayAfter(due[1], Number(due[2]), billDate);
    page1Total = amt(due[4]);
  }
  const autopay = /Auto Pay Scheduled|You're enrolled in auto pay/i.test(text);
  const apd = text.match(/Auto pay date ([A-Z][a-z]+) (\d{1,2})\b/);
  const autopayDate = apd ? dayAfter(apd[1], Number(apd[2]), billDate) : null;

  // ---- Page 2: discounts ----
  const discountRows: FiosDiscountRow[] = [];
  for (const l of lines) {
    const m = l.match(new RegExp(String.raw`^(.+?) (${AMT}) (-${AMT.slice(2)}) (${AMT})(?:\s|$)`));
    if (m && !/^(Subtotal|Total|Previous)/.test(m[1])) {
      const row = { description: m[1].trim(), price: amt(m[2]), discount: amt(m[3]), youPay: amt(m[4]) };
      if (cents(row.price + row.discount, row.youPay) && !discountRows.some((r) => r.description === row.description)) discountRows.push(row);
    }
  }
  const dtm = text.match(new RegExp(String.raw`Discounts This Month (${AMT})`));
  const discountsThisMonth = dtm ? amt(dtm[1]) : null;
  const discountNotes = [...new Set(lines.filter((l) => /^\$[\d,.]+ (?:discount )?(?:expires \d{1,2}\/\d{1,2}\/\d{2,4}|has no current)/.test(l)).map((l) => l.replace(/\s+expiration\.?$/, ' expiration.')))];
  const pg = text.match(/will not change through (\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  const priceGuaranteeUntil = pg ? `${pg[3].length === 2 ? 2000 + Number(pg[3]) : pg[3]}-${pad(Number(pg[1]))}-${pad(Number(pg[2]))}` : null;

  // ---- Details of Payments ----
  const payAt = lines.findIndex((l) => /^Details of Payments$/.test(l));
  const chargesAt = lines.findIndex((l) => /^Details of Charges$/.test(l));
  if (chargesAt < 0) throw new UnreadableStatement('No Details of Charges');
  let previousBalance = 0;
  let balanceForward: number | null = null;
  let pastDue = false;
  const transactions: ParsedTransaction[] = [];
  const paymentRows: number[] = [];
  if (payAt >= 0) {
    for (const l of lines.slice(payAt + 1, chargesAt)) {
      let m: RegExpMatchArray | null;
      if ((m = l.match(new RegExp(String.raw`^Previous Balance (${AMT})$`)))) previousBalance = amt(m[1]);
      else if ((m = l.match(new RegExp(String.raw`^Balance Forward (${AMT})$`)))) balanceForward = amt(m[1]);
      else if ((m = l.match(new RegExp(String.raw`^Past Due Pay Immediately (${AMT})$`)))) {
        balanceForward = amt(m[1]);
        pastDue = true;
      } else if ((m = l.match(new RegExp(String.raw`^(.+?) (${AMT})(?: (\d{1,2}\/\d{1,2}))?$`)))) {
        const amount = amt(m[2]);
        paymentRows.push(amount);
        if (amount !== 0) {
          const date = m[3] ? mdBefore(m[3], billDate) : billDate;
          transactions.push({ date, description: m[1], kind: /payment/i.test(m[1]) ? 'payment' : 'adjustment', amount, units: null, unitPrice: null });
        }
      }
    }
  }
  const payments = round2(paymentRows.reduce((s, a) => s + a, 0));
  if (balanceForward === null) balanceForward = round2(previousBalance + payments);

  // ---- Details of Charges ----
  const items: FiosItem[] = [];
  const subtotals: { amount: number; items: number; label: string }[] = [];
  let chargesLine: number | null = null;
  let totalDue: number | null = null;
  let mode: 'regular' | 'change' | 'tax' = 'regular';
  let pending: string | null = null;
  let running = 0;
  let runningItems = 0;
  for (const l of lines.slice(chargesAt + 1)) {
    let m: RegExpMatchArray | null;
    if ((m = l.match(new RegExp(String.raw`^Total Due (${AMT})$`)))) {
      totalDue = amt(m[1]);
      break;
    }
    if ((m = l.match(new RegExp(String.raw`^Subtotal(?: - \d+ days)? (${AMT})(?:\s+(\d{1,2}\/\d{1,2})\s*-\s*(\d{1,2}\/\d{1,2}))?$`)))) {
      subtotals.push({ amount: amt(m[1]), items: running, label: mode });
      running = 0;
      runningItems = 0;
      pending = null;
      continue;
    }
    if ((m = l.match(new RegExp(String.raw`^Charges (${AMT})$`)))) {
      chargesLine = amt(m[1]);
      continue;
    }
    if (/^Requested Change in Service$/.test(l)) {
      mode = 'change';
      running = 0;
      runningItems = 0;
      pending = null;
      continue;
    }
    if (/^(Fees & Other Charges|Taxes(?:, Governmental.*)?)$/.test(l)) {
      if (mode !== 'tax') {
        running = 0;
        runningItems = 0;
      }
      mode = 'tax';
      pending = null;
      continue;
    }
    m = l.match(ITEM_RE);
    if (!m) {
      // A heading, boilerplate or a description that wraps onto the next line.
      pending = /^[A-Z]$|^Q$|^R$/.test(l) ? pending : l;
      continue;
    }
    let desc = m[1].trim();
    let change = (m[2] as 'added' | 'removed' | undefined) ?? null;
    if (!desc && pending) {
      desc = pending;
      const w = desc.match(/^(.*?)\s+(added|removed)$/);
      if (w) {
        desc = w[1];
        change = change ?? (w[2] as 'added' | 'removed');
      }
    }
    pending = null;
    if (!desc) continue;
    const amount = amt(m[4]);
    const start = m[5] ? mdNear(m[5], billDate) : null;
    const end = m[6] ? mdNear(m[6], billDate) : null;
    const changeDate = m[3] ? mdNear(m[3], billDate) : null;
    let kind: FiosItemKind;
    if (mode === 'change') kind = 'change';
    else if (mode === 'tax') kind = /late payment|fee$/i.test(desc) && !/surcharge/i.test(desc) ? 'fee' : 'tax';
    else if (/discount/i.test(desc) || amount < 0) kind = 'discount';
    else if (/^Rent:|router|set.?top|equipment/i.test(desc)) kind = 'equipment';
    else if (isPlan(desc)) kind = 'service';
    else kind = 'addon';
    items.push({ kind, description: desc.replace(/\s+/g, ' '), amount, start, end, change, changeDate });
    running = round2(running + amount);
    runningItems++;
  }
  if (totalDue === null) throw new UnreadableStatement('No Total Due in Details of Charges');
  void runningItems;

  const sum = (k: FiosItemKind[]) => round2(items.filter((i) => k.includes(i.kind)).reduce((s, i) => s + i.amount, 0));
  const currentCharges = sum(['service', 'equipment', 'discount', 'addon', 'change', 'tax', 'fee']);
  const planItem = items.find((i) => i.kind === 'service');
  const plan = planItem?.description ?? null;
  const planRow = plan ? discountRows.find((r) => r.description === plan) : undefined;
  const folded = planRow && planItem && cents(planRow.youPay, planItem.amount) ? planRow.discount : 0;
  const ranged = items.filter((i) => i.kind !== 'change' && i.start && i.end).sort((a, b) => a.start!.localeCompare(b.start!));
  const subtotalRange = text.slice(text.indexOf('Details of Charges')).match(/Subtotal(?: - \d+ days)? -?\$[\d,]*\.\d{2} (\d{1,2}\/\d{1,2}) - (\d{1,2}\/\d{1,2})/);

  const values: FiosValues = {
    account,
    billDate,
    dueDate,
    autopay,
    autopayDate,
    previousBalance,
    payments,
    balanceForward,
    pastDue,
    currentCharges,
    totalDue,
    plan,
    speedMbps: fiosSpeed(plan),
    planPrice: planItem?.amount ?? null,
    listPrice: planRow ? planRow.price : planItem?.amount ?? null,
    monthlyService: sum(['service', 'equipment', 'discount', 'addon']),
    discounts: round2(sum(['discount']) + folded),
    discountsThisMonth,
    taxes: sum(['tax']),
    lateFee: sum(['fee']),
    proration: sum(['change']),
    equipment: items.filter((i) => i.kind === 'equipment').map((i) => i.description),
    addOns: items.filter((i) => i.kind === 'addon').map((i) => i.description),
    discountRows,
    discountNotes,
    servicePeriodStart: subtotalRange ? mdNear(subtotalRange[1], billDate) : ranged[0]?.start ?? null,
    servicePeriodEnd: subtotalRange ? mdNear(subtotalRange[2], billDate) : ranged[0]?.end ?? null,
    priceGuaranteeUntil,
    items,
  };

  // ---- Checks ----
  const checks: StatementCheck[] = [];
  checks.push(
    check(
      'Previous Balance + Payments = Balance Forward',
      cents(previousBalance + payments, balanceForward),
      `${fmtMoney(previousBalance)} + ${fmtMoney(payments)} vs ${fmtMoney(balanceForward)}`
    )
  );
  checks.push(
    check('Balance Forward + Charges = Total Due', cents(balanceForward + currentCharges, totalDue), `${fmtMoney(balanceForward)} + ${fmtMoney(currentCharges)} vs ${fmtMoney(totalDue)}`)
  );
  subtotals.forEach((s, i) => checks.push(check(`Subtotal ${i + 1} = Its Items`, cents(s.items, s.amount), `${fmtMoney(s.items)} vs ${fmtMoney(s.amount)}`)));
  if (chargesLine !== null) checks.push(check('Itemized Charges = Charges', cents(currentCharges, chargesLine), `${fmtMoney(currentCharges)} vs ${fmtMoney(chargesLine)}`));
  if (page1Total !== null) checks.push(check('Page 1 Total = Details Total', cents(page1Total, totalDue), `${fmtMoney(page1Total)} vs ${fmtMoney(totalDue)}`));
  if (!plan) checks.push(check('Internet Plan Found', false, 'No internet service line in Details of Charges'));

  return {
    periodStart: billDate,
    periodEnd: billDate,
    values: values as unknown as Record<string, unknown>,
    transactions: transactions.sort((a, b) => a.date.localeCompare(b.date)),
    checks,
  };
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);

/** Consecutive bills (≤ 40 days apart) chain: last bill's total is this
 * bill's previous balance. A bill missing from Drive skips the check. */
export function crossCheckFios(prev: { periodEnd: string; values: FiosValues } | null, cur: { periodEnd: string; values: FiosValues }): StatementCheck[] {
  if (!prev || daysBetween(prev.periodEnd, cur.periodEnd) > 40) return [];
  return [check('Prior Total = This Previous Balance', cents(prev.values.totalDue, cur.values.previousBalance), `${fmtMoney(prev.values.totalDue)} vs ${fmtMoney(cur.values.previousBalance)}`)];
}
