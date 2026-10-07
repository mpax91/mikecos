import { check, cents, fmtMoney, money, round2, UnreadableStatement } from '../common';
import type { ParsedStatement, ParsedTransaction, StatementCheck } from '../common';

/** Template #3 — ADT home security monthly bills, Drive folder "ADT",
 * files "ADT - YYYY.MM.DD - Statement.pdf" (2016 → today). Three layout
 * eras, all read by the same field rules; see docs/statement-templates/adt.md.
 *   A1 (2016-11 → 2017-08): "Invoice Date: 07/01/17", charges as
 *       "07/01/17 to 07/31/17 Security Services $52.99".
 *   A2 (2017-09 → 2020-07): "Bill-at-a-glance", "Invoice #T… 06/01/18 -
 *       06/30/18" then "Security Services 56.78".
 *   B  (2020-11 → today): "Your Bill at-a-glance", "Invoice date: / Service
 *       period:", "Invoice Number … Oct 12 - Nov 11, 2026 $17.99". Since
 *       ~2023 headings are letter-spaced ("I n v o i c e d a t e :") — they
 *       are collapsed before matching.
 * One statement per invoice: periodStart = periodEnd = invoice date (the
 * engine treats two files with the same invoice date as duplicates). */

export interface AdtCharge {
  description: string;
  start: string | null; // service period, YYYY-MM-DD
  end: string | null;
  amount: number;
  recurring: boolean;
}

export interface AdtValues {
  era: 'A1' | 'A2' | 'B';
  accountLast: string; // last 4 of the ADT customer number
  invoiceDate: string;
  dueDate: string | null;
  dueNote: string | null; // "Upon Receipt", "Do Not Pay", "Past Due"…
  autopay: boolean;
  previousBalance: number;
  paymentsAdjustments: number;
  currentCharges: number;
  taxesFees: number;
  totalDue: number;
  services: string | null; // e.g. "Burglar Alarm Monitoring, Maintenance Service"
  servicePeriodStart: string | null;
  servicePeriodEnd: string | null;
  monthlyRate: number | null; // recurring full-month service charge (pre-tax)
  charges: AdtCharge[];
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const AMT = String.raw`(-?\$?\s?-?[\d,]+\.\d{2}|\(\$?[\d,]+\.\d{2}\))`;
const LONG_DATE = String.raw`([A-Z][a-z]{2} \d{1,2}, \d{4})`;

/** "11/01/16" or "11/01/2016" → "2016-11-01". */
function slashDate(raw: string): string {
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) throw new UnreadableStatement(`Not a date: "${raw}"`);
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return `${y}-${pad(Number(m[1]))}-${pad(Number(m[2]))}`;
}

/** "Sep 24, 2026" → "2026-09-24". */
function longDate(raw: string): string {
  const m = raw.trim().match(/^([A-Za-z]{3})[a-z]* (\d{1,2}), (\d{4})$/);
  const mi = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  if (!m || mi < 0) throw new UnreadableStatement(`Not a date: "${raw}"`);
  return `${m[3]}-${pad(mi + 1)}-${pad(Number(m[2]))}`;
}

/** "Oct 12 - Nov 11, 2026", "Dec 12, 2023-Jan 11, 2024" or "Nov 14, 2021". */
function longRange(raw: string): { start: string; end: string } | null {
  const s = raw.trim();
  let m = s.match(/^([A-Z][a-z]{2}) (\d{1,2})(?:, (\d{4}))?\s*-\s*([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/);
  if (m) {
    const end = longDate(`${m[4]} ${m[5]}, ${m[6]}`);
    let y = m[3] ? Number(m[3]) : Number(m[6]);
    if (!m[3] && MONTHS.indexOf(m[1].toLowerCase()) > MONTHS.indexOf(m[4].toLowerCase())) y--;
    return { start: longDate(`${m[1]} ${m[2]}, ${y}`), end };
  }
  m = s.match(/^([A-Z][a-z]{2} \d{1,2}, \d{4})$/);
  if (m) {
    const d = longDate(m[1]);
    return { start: d, end: d };
  }
  return null;
}

/** pdf.js renders some ADT headings letter-spaced ("I n v o i c e d a t e :");
 * collapse any run of 4+ single characters separated by single spaces. */
export function collapseSpacedLetters(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/(?<!\S)\S(?: \S){3,}(?!\S)/g, (run) => run.replace(/ /g, '')))
    .join('\n');
}

const amountOf = (raw: string) => {
  const s = raw.replace(/\s/g, '');
  return /^\(.*\)$/.test(s) ? -Math.abs(money(s)) : money(s);
};
const titleCase = (s: string) => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : s);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);

export function parseAdt(rawText: string): ParsedStatement {
  if (!/ADT/.test(rawText) || !/(Bill.?at.?a.?glance|B i l l a t|Previous Balance)/i.test(rawText)) {
    throw new UnreadableStatement('Not an ADT bill');
  }
  const text = collapseSpacedLetters(rawText);
  const lines = text.split('\n').map((l) => l.trim());

  // ---- Era + invoice date ----
  let era: AdtValues['era'];
  let invoiceDate: string;
  const b = text.match(/^Invoice ?date:.*\n(?:.*\n)??([A-Z][a-z]{2} \d{1,2}, \d{4})/m);
  const a = text.match(/Invoice Date:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/);
  if (b) {
    era = 'B';
    invoiceDate = longDate(b[1]);
  } else if (a) {
    era = /Bill-at-a-glance/.test(text) ? 'A2' : 'A1';
    invoiceDate = slashDate(a[1]);
  } else {
    throw new UnreadableStatement('No invoice date');
  }

  // ---- Bill-at-a-glance (first occurrence of each label = page 1) ----
  const summary = (label: string) => {
    const m = text.match(new RegExp(`^${label}\\s+${AMT}(?:\\s|$)`, 'm'));
    if (!m) throw new UnreadableStatement(`Missing "${label.replace(/\\/g, '')}"`);
    return amountOf(m[1]);
  };
  const previousBalance = summary('Previous Balance(?: Credit)?');
  const paymentsAdjustments = summary('Payments (?:&|and) Adjustments');
  const currentCharges = summary('Current Charges');
  const taxesFees = summary('Taxes and Fees');
  const totalDue = summary('(?:Total Due(?: \\(including pro-rate\\*\\))?|Total Amount Due|Upon Receipt|Do Not Pay|Your Credit Balance Is)');

  // ---- Account, due date, autopay ----
  const acct = text.match(/(?:Your account number:|Account Number Due Date Amount Due)\s*\n\s*(\d{6,})/i) ?? text.match(/Account Number (\d{6,})/);
  const accountLast = acct ? acct[1].slice(-4) : '';
  let dueDate: string | null = null;
  let dueNote: string | null = null;
  if (era === 'B') {
    // "Your total due is: Due by:" / "$" / "19.50 Oct 14, 2026" (or "30.69 Upon Receipt").
    const i = lines.findIndex((l) => /^Your total due is:|^You have a credit balance:/.test(l));
    const row = i >= 0 ? lines.slice(i + 1, i + 5).find((l) => /^-?[\d,]+\.\d{2}\b/.test(l)) : undefined;
    const rest = row?.replace(/^-?[\d,]+\.\d{2}\s*/, '') ?? '';
    if (/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(rest)) dueDate = longDate(rest);
    else if (rest) dueNote = rest;
  } else {
    const m = text.match(/Account Number Due Date Amount Due\s*\n(?:\d+\s*\n)*?\s*(?:\d{6,}\s+)?(\d{1,2}\/\d{1,2}\/\d{2})\b/);
    if (m) dueDate = slashDate(m[1]);
    if (/Do Not Pay/i.test(text.slice(0, 3000))) dueNote = 'Do Not Pay';
  }
  if (/Past Due/i.test(text)) dueNote = dueNote ?? 'Past Due';
  const autopay = /automatic payment|Automatic Payment \$|EasyPay enrolled|being submitted for\s+payment in accordance with your automatic/i.test(text);

  // ---- Detail: payments / adjustments ----
  const transactions: ParsedTransaction[] = [];
  const detailStart = (() => {
    const i = lines.findIndex((l, idx) => idx > 0 && /^(Your Account Activity|YourAccountActivity|ACCOUNT ACTIVITY DETAILS|Services Summary|Invoice Date \d)/.test(l));
    return i < 0 ? 0 : i;
  })();
  const detail = lines.slice(detailStart);
  const chargesAt = detail.findIndex((l) => /^(Current Charges(?:\s*:|\s+Period Amount)?|Recurring Charges Period Amount)$/.test(l));
  const totalAt = detail.findIndex((l, idx) => idx > Math.max(chargesAt, 0) && /^(Total Due|Total Amount Due|Credit Balance - Do Not Pay|Total Taxable Charges)/.test(l));
  const payLines = detail.slice(0, chargesAt < 0 ? detail.length : chargesAt);
  for (const l of payLines) {
    let m = l.match(new RegExp(`^(.+?) ${LONG_DATE} ${AMT}$`));
    if (m && !/^(Previous Balance|Payments)/.test(m[1])) {
      const amount = amountOf(m[3]);
      transactions.push({ date: longDate(m[2]), description: m[1].replace(/\s+/g, ' '), kind: /payment/i.test(m[1]) ? 'payment' : 'adjustment', amount, units: null, unitPrice: null });
      continue;
    }
    m = l.match(new RegExp(`^(\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}) (.+?) ${AMT}$`));
    if (m) {
      const amount = amountOf(m[3]);
      transactions.push({ date: slashDate(m[1]), description: m[2].replace(/\s+/g, ' '), kind: /payment/i.test(m[2]) ? 'payment' : 'adjustment', amount: /payment/i.test(m[2]) ? -Math.abs(amount) : amount, units: null, unitPrice: null });
    }
  }

  // ---- Detail: current charges ----
  const charges: AdtCharge[] = [];
  let taxLines = 0;
  let services: string[] = [];
  let pendingService: string | null = null;
  let a2Period: { start: string; end: string } | null = null;
  const chargeLines = chargesAt < 0 ? [] : detail.slice(chargesAt + 1, totalAt < 0 ? undefined : totalAt);
  for (let i = 0; i < chargeLines.length; i++) {
    const l = chargeLines[i];
    let m: RegExpMatchArray | null;
    if ((m = l.match(new RegExp(`^(?:Sales )?Tax:?\\s+${AMT}$`)))) {
      taxLines = round2(taxLines + amountOf(m[1]));
      continue;
    }
    // B: "Services* About your Services: Burglar Alarm Monitoring, Maintenance Service*" (may wrap)
    if ((m = l.match(/^(?:Services\*?|Installation and Service Charges|[A-Z][A-Za-z ]+?) ?(?:About your Services|What was installed as a part of your security system):\s*(.*)$/))) {
      let desc = m[1];
      while (!/\*$/.test(desc) && i + 1 < chargeLines.length && !/^Invoice Number/.test(chargeLines[i + 1]) && desc.length < 200) desc = `${desc} ${chargeLines[++i]}`;
      pendingService = desc.replace(/\*+$/, '').replace(/,(?=\S)/g, ', ').trim();
      continue;
    }
    // B: "Invoice Number 1241470249 Oct 12 - Nov 11, 2026 $17.99"
    if ((m = l.match(new RegExp(`^Invoice Number \\S+ (.+?) ${AMT}$`)))) {
      const range = longRange(m[1]);
      const amount = amountOf(m[2]);
      const recurring = !!range && range.start !== range.end;
      charges.push({ description: pendingService ?? 'Charge', start: range?.start ?? null, end: range?.end ?? null, amount, recurring });
      if (pendingService && recurring) services.push(pendingService);
      pendingService = null;
      continue;
    }
    // A2: "Invoice #T449355514 06/01/18 - 06/30/18" then "Security Services 56.78"
    if ((m = l.match(/^Invoice #\S+\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})$/))) {
      a2Period = { start: slashDate(m[1]), end: slashDate(m[2]) };
      continue;
    }
    // A2 (2020): "SECURITY SERVICES* 08/01/20 - 08/31/20 $14.99"
    if ((m = l.match(new RegExp(`^([A-Za-z][A-Za-z &/-]+?)\\*? (\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}) - (\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}) ${AMT}$`)))) {
      const desc = titleCase(m[1]);
      charges.push({ description: desc, start: slashDate(m[2]), end: slashDate(m[3]), amount: amountOf(m[4]), recurring: true });
      services.push(desc);
      continue;
    }
    // A2 (2020): "Installation and Service Charges 07/31/2020 $33.12" (one-time)
    if ((m = l.match(new RegExp(`^([A-Za-z][A-Za-z &/-]+?)\\*? (\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}) ${AMT}$`)))) {
      const d = slashDate(m[2]);
      charges.push({ description: m[1], start: d, end: d, amount: amountOf(m[3]), recurring: false });
      continue;
    }
    // A1: "07/01/17 to 07/31/17 Security Services $52.99"
    if ((m = l.match(new RegExp(`^(\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}) to (\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}) (.+?) ${AMT}$`)))) {
      charges.push({ description: m[3], start: slashDate(m[1]), end: slashDate(m[2]), amount: amountOf(m[4]), recurring: true });
      services.push(m[3]);
      continue;
    }
    if (era === 'A2' && (m = l.match(new RegExp(`^([A-Za-z][A-Za-z &/-]+?) ${AMT}$`)))) {
      // Only the monitoring line recurs; trip fees etc. land in the same
      // invoice period but are one-time.
      const recurring = !!a2Period && /services|monitoring/i.test(m[1]);
      charges.push({ description: m[1], start: a2Period?.start ?? null, end: a2Period?.end ?? null, amount: amountOf(m[2]), recurring });
      if (recurring) services.push(m[1]);
    }
  }
  services = [...new Set(services)];

  const recurring = charges.filter((c) => c.recurring && c.start && c.end);
  const fullMonth = recurring.filter((c) => {
    const d = daysBetween(c.start!, c.end!);
    return d >= 27 && d <= 31;
  });
  const monthlyRate = fullMonth.length ? round2(fullMonth.reduce((s, c) => s + c.amount, 0)) : null;
  const periods = recurring.map((c) => [c.start!, c.end!]).sort();

  const values: AdtValues = {
    era,
    accountLast,
    invoiceDate,
    dueDate,
    dueNote,
    autopay,
    previousBalance,
    paymentsAdjustments,
    currentCharges,
    taxesFees,
    totalDue,
    services: services.length ? services.join(' · ') : null,
    servicePeriodStart: periods.length ? periods[0][0] : null,
    servicePeriodEnd: periods.length ? periods.map((p) => p[1]).sort().slice(-1)[0] : null,
    monthlyRate,
    charges,
  };

  // ---- Checks ----
  const checks: StatementCheck[] = [];
  const sum = round2(previousBalance + paymentsAdjustments + currentCharges + taxesFees);
  checks.push(
    check(
      'Previous + Payments + Charges + Taxes = Total',
      cents(sum, totalDue),
      `${fmtMoney(previousBalance)} + ${fmtMoney(paymentsAdjustments)} + ${fmtMoney(currentCharges)} + ${fmtMoney(taxesFees)} vs ${fmtMoney(totalDue)}`
    )
  );
  const payTotal = round2(transactions.reduce((s, t) => s + t.amount, 0));
  if (transactions.length || paymentsAdjustments !== 0) {
    checks.push(check('Itemized Payments = Payments and Adjustments', cents(payTotal, paymentsAdjustments), `${fmtMoney(payTotal)} vs ${fmtMoney(paymentsAdjustments)}`));
  }
  const chargeTotal = round2(charges.reduce((s, c) => s + c.amount, 0));
  if (charges.length || currentCharges !== 0) {
    checks.push(check('Itemized Charges = Current Charges', cents(chargeTotal, currentCharges), `${fmtMoney(chargeTotal)} vs ${fmtMoney(currentCharges)}`));
  }
  if (taxLines !== 0 || taxesFees !== 0) {
    checks.push(check('Itemized Tax = Taxes and Fees', cents(taxLines, taxesFees), `${fmtMoney(taxLines)} vs ${fmtMoney(taxesFees)}`));
  }

  return {
    periodStart: invoiceDate,
    periodEnd: invoiceDate,
    values: values as unknown as Record<string, unknown>,
    transactions: transactions.sort((x, y) => x.date.localeCompare(y.date)),
    checks,
  };
}

/** Consecutive bills (≤ 40 days apart) chain: last bill's total is this
 * bill's previous balance. Gaps (a bill missing from Drive) skip the check. */
export function crossCheckAdt(prev: { periodEnd: string; values: AdtValues } | null, cur: { periodEnd: string; values: AdtValues }): StatementCheck[] {
  if (!prev || daysBetween(prev.periodEnd, cur.periodEnd) > 40) return [];
  return [check('Prior Total = This Previous Balance', cents(prev.values.totalDue, cur.values.previousBalance), `${fmtMoney(prev.values.totalDue)} vs ${fmtMoney(cur.values.previousBalance)}`)];
}
