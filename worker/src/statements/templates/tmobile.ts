import { check, cents, fmtMoney, money, round2, UnreadableStatement } from '../common';
import type { ParsedStatement, ParsedTransaction, StatementCheck } from '../common';

/** Template — T-Mobile wireless monthly bills, Drive folder "T-Mobile",
 * files "T-Mobile - YYYY.MM.DD.pdf" (Sep 2019 → today, account 967709602).
 * One layout family the whole time; only the page header changed:
 *   2019-09 → 2023-01: "Bill period / Oct 09, 2022 - Nov 08, 2022"
 *   2023-02 → today:   "Bill issue date / Oct 08, 2026"
 * Page 1 carries TOTAL DUE (split "$ / 122 / .50"), "Your bill is due by…",
 * "AutoPay is scheduled for … using Visa ****2374." and, when last month
 * didn't simply get paid in full, a BALANCE / BALANCE FORWARD / PAST DUE
 * BALANCE box. Page 2 has YOUR LAST BILL (previous balance, payments,
 * credits), THIS BILL SUMMARY (a row per line: Plans · Equipment · Services
 * [· One-time charges] · Total, plus Account and Totals), DETAILED CHARGES
 * (plan name, device installment plans) and YOU USED (data per line).
 * Total Due = balance carried + this bill's Totals. Taxes are included in
 * T-Mobile's prices, so the Totals row is what the month costs.
 * See docs/statement-templates/tmobile.md. */

/** Mike's lines (Mike, 2026-10-11): his phone and his wife's. Other numbers
 * that came and went (a third line, a watch, a DIGITS number) are labeled
 * by their line type. */
export const TMOBILE_LINE_NAMES: Record<string, string> = {
  '9142639681': 'Mike',
  '5082215290': 'Wife',
};

export interface TmobileLine {
  number: string; // "(914) 263-9681"
  digits: string; // "9142639681"
  type: string | null; // Voice · Wearable · Digits · …
  status: string | null; // New · Removed · Suspended · Transferred to T-Mobile
  plans: number;
  planIncluded: boolean; // "Included" (covered by the account plan charge)
  equipment: number;
  services: number;
  oneTime: number;
  total: number;
  dataGb: number | null;
}

export interface TmobileDevice {
  id: string; // installment plan id
  line: string | null; // "(914) 263-9681"
  device: string;
  charge: number; // what this bill charged for it (before promo credits)
  balance: number | null; // remaining principal after this bill
  installment: number | null; // k of N
  of: number | null;
  completed: boolean;
}

export interface TmobilePromo {
  id: string | null; // installment plan the promo pays down
  line: string | null;
  description: string;
  amount: number; // negative = credit this bill
}

export interface TmobileValues {
  era: 'period' | 'issue';
  account: string; // 967709602
  billDate: string; // issue date (or the bill-period end date before 2023)
  dueDate: string | null;
  dueNote: string | null; // "Due Immediately" (past due) …
  totalDue: number;
  autopay: boolean;
  autopayDate: string | null;
  autopayCard: string | null; // "Visa ••2374"
  /** Carried in from last month (0 when last bill was paid in full). */
  balance: number;
  balanceLabel: string | null; // BALANCE · BALANCE FORWARD · PAST DUE BALANCE
  previousBalance: number | null; // "Your last bill was" / YOUR LAST BILL
  /** This bill's own charges — the THIS BILL SUMMARY Totals row. */
  plans: number;
  equipment: number;
  services: number;
  oneTime: number;
  charges: number;
  accountRow: { plans: number; equipment: number; services: number; oneTime: number; total: number } | null;
  lines: TmobileLine[];
  plan: string | null; // "Go5G Plus Military"
  servicePeriodStart: string | null; // REGULAR CHARGES period (charged in advance)
  servicePeriodEnd: string | null;
  devices: TmobileDevice[];
  promos: TmobilePromo[];
  savings: number | null; // YOU SAVED TOTAL
  savingsParts: { label: string; amount: number }[];
  dataGb: number | null;
  minutes: number | null;
  messages: number | null;
  taxesIncluded: number | null; // taxes & fees folded into the prices
  taxesAdded: number | null; // ADDITIONAL GOVERNMENT TAXES & FEES
  lastPayment: { amount: number; date: string | null } | null;
  /** "This month your account had a Late Payment of $2.25" (incl. its tax). */
  lateFee: number | null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const PHONE = String.raw`\(\d{3}\) \d{3}-\d{4}`;
const AMT = String.raw`-?\$[\d,]+\.\d{2}`;

function longDate(raw: string): string {
  const m = raw.trim().match(/^([A-Za-z]{3})[a-z]* (\d{1,2}), (\d{4})$/);
  const mi = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  if (!m || mi < 0) throw new UnreadableStatement(`Not a date: "${raw}"`);
  return `${m[3]}-${pad(mi + 1)}-${pad(Number(m[2]))}`;
}

/** "Oct 30" on a bill dated 2026-10-08 → the most recent Oct 30 on or
 * before ~a month after the bill date. */
function shortDate(raw: string, billDate: string): string {
  const m = raw.trim().match(/^([A-Za-z]{3}) (\d{1,2})$/);
  const mi = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  if (!m || mi < 0) throw new UnreadableStatement(`Not a date: "${raw}"`);
  let y = Number(billDate.slice(0, 4));
  const iso = (yy: number) => `${yy}-${pad(mi + 1)}-${pad(Number(m[2]))}`;
  // Rows on a bill are from the weeks before it: if the month is later than
  // the bill's month by more than one, it belongs to last year.
  if (mi + 1 > Number(billDate.slice(5, 7)) + 1) y--;
  return iso(y);
}

/** "Oct 09 - Nov 08" (no year) around a bill date. */
function shortRange(a: string, b: string, billDate: string): { start: string; end: string } {
  const by = Number(billDate.slice(0, 4));
  const mA = MONTHS.indexOf(a.slice(0, 3).toLowerCase()) + 1;
  const mB = MONTHS.indexOf(b.slice(0, 3).toLowerCase()) + 1;
  const bm = Number(billDate.slice(5, 7));
  // Regular charges run from the day after the bill to a month later, so the
  // start month is the bill month (or next month for an end-of-month bill).
  const yA = mA < bm - 6 ? by + 1 : mA > bm + 6 ? by - 1 : by;
  const yB = mB < mA ? yA + 1 : yA;
  return { start: `${yA}-${pad(mA)}-${pad(Number(a.slice(4)))}`, end: `${yB}-${pad(mB)}-${pad(Number(b.slice(4)))}` };
}

const cell = (raw: string): number => (raw === '-' || raw === 'Included' ? 0 : money(raw));
const digitsOf = (num: string) => num.replace(/\D/g, '');

export function tmobileLineName(number: string, type?: string | null): string {
  const n = TMOBILE_LINE_NAMES[digitsOf(number)];
  if (n) return n;
  return `${type && type !== 'Voice' ? type : 'Line'} ••${digitsOf(number).slice(-4)}`;
}

export function parseTmobile(text: string): ParsedStatement {
  if (!/T-Mobile|T‑Mobile|t-mobile\.com/i.test(text) || !/THIS BILL SUMMARY/.test(text)) throw new UnreadableStatement('Not a T-Mobile bill');
  // Bill body only — the appendix (usage details: every call and text) is
  // never read.
  const body = text.split(/\nAPPENDIX_BEGIN\n|\nUSAGE DETAILS\n/)[0];
  const lines = body.split('\n').map((l) => l.trim());

  // ---- Bill date ----
  let era: TmobileValues['era'];
  let billDate: string;
  let m = body.match(/Bill issue date\s*\n\s*([A-Z][a-z]{2} \d{1,2}, \d{4})/);
  if (m) {
    era = 'issue';
    billDate = longDate(m[1]);
  } else if ((m = body.match(/Bill period\s*\n\s*[A-Z][a-z]{2} \d{1,2}, \d{4} - ([A-Z][a-z]{2} \d{1,2}, \d{4})/))) {
    era = 'period';
    billDate = longDate(m[1]);
  } else throw new UnreadableStatement('No bill date');
  const acct = body.match(/\nAccount\s*\n\s*(\d{6,})\s*\n/);
  const account = acct ? acct[1] : '';

  // ---- Page 1: total due, due date, AutoPay, last payment ----
  // "TOTAL DUE / $ / 122 / .50" (a credit prints "-$").
  m = body.match(/TOTAL DUE\s*\n\s*(-?)\$\s*\n\s*([\d,]+)\s*\n\s*(\.\d{2})/);
  if (!m) throw new UnreadableStatement('Missing TOTAL DUE');
  const totalDue = round2((m[1] ? -1 : 1) * money(`${m[2]}${m[3]}`));
  const due = body.match(/Your bill is due by ([A-Z][a-z]{2} \d{1,2}, \d{4})/) ?? body.match(/Total due by ([A-Z][a-z]{2} \d{1,2}, \d{4})/);
  const dueDate = due ? longDate(due[1]) : null;
  let dueNote: string | null = null;
  if (/is due immediately/i.test(body)) dueNote = 'Due Immediately';
  const ap = body.match(/AutoPay is scheduled for ([A-Z][a-z]{2} \d{1,2}, \d{4}) using\s+([A-Za-z ]+?)\s*\n?\s*\*+(\d{4})/);
  const autopay = !!ap || /You are paying by AutoPay/.test(body);
  const autopayDate = ap ? longDate(ap[1]) : null;
  const autopayCard = ap ? `${ap[2].trim()} ••${ap[3]}` : null;
  const thanks = body.match(/Thanks for paying your last bill of (\$[\d,]+\.\d{2})(?:\s*\n?\s*on ([A-Z][a-z]{2} \d{1,2}, \d{4}))?/);
  const lastBillWas = body.match(/Your last bill was (\$[\d,]+\.\d{2})/);

  // ---- Balance carried in (page 1 box / YOUR LAST BILL) ----
  let balance = 0;
  let balanceLabel: string | null = null;
  m = body.match(/\n(PAST DUE BALANCE|BALANCE FORWARD|BALANCE)\s*\n\s*(-?)\$\s*\n\s*([\d,]+)\s*\n\s*(\.\d{2})/);
  if (m) {
    balanceLabel = m[1];
    balance = round2((m[2] ? -1 : 1) * money(`${m[3]}${m[4]}`));
  }
  const transactions: ParsedTransaction[] = [];
  let previousBalance: number | null = null;
  const lastAt = lines.indexOf('YOUR LAST BILL');
  if (lastAt >= 0) {
    for (let i = lastAt + 1; i < lines.length && lines[i] !== 'THIS BILL SUMMARY'; i++) {
      let l = lines[i];
      let r: RegExpMatchArray | null;
      if ((r = l.match(new RegExp(`^(PAST DUE BALANCE|BALANCE FORWARD|BALANCE) (${AMT})$`)))) {
        balanceLabel = r[1];
        balance = money(r[2]);
        continue;
      }
      if ((r = l.match(new RegExp(`^Previous balance (${AMT})$`)))) {
        previousBalance = money(r[1]);
        continue;
      }
      // A credit row may wrap ("… Adjustment" / "Reversal" / "Dec 14 $33.34").
      while (/^(Payment|Credits & adjustments)/.test(l) && !new RegExp(`${AMT}$`).test(l) && i + 1 < lines.length && lines[i + 1] !== 'THIS BILL SUMMARY') l = `${l} ${lines[++i]}`;
      if ((r = l.match(new RegExp(`^Payment(?: - thank you)? ([A-Z][a-z]{2} \\d{1,2}) (${AMT})$`)))) {
        transactions.push({ date: shortDate(r[1], billDate), description: 'Payment - Thank You', kind: 'payment', amount: money(r[2]), units: null, unitPrice: null });
        continue;
      }
      if ((r = l.match(new RegExp(`^Credits & adjustments (?:(${PHONE}) )?(.+?) ([A-Z][a-z]{2} \\d{1,2}) (${AMT})$`)))) {
        transactions.push({
          date: shortDate(r[3], billDate),
          description: `${r[1] ? `${r[1]} ` : ''}${r[2].replace(/\s+/g, ' ')}`,
          kind: 'adjustment',
          amount: money(r[4]),
          units: null,
          unitPrice: null,
        });
      }
    }
  }
  if (previousBalance === null && lastBillWas) previousBalance = money(lastBillWas[1]);
  // No YOUR LAST BILL block: last month was paid in full — the page-1
  // "Thanks for paying" line is the payment.
  let lastPayment: TmobileValues['lastPayment'] = null;
  if (thanks) lastPayment = { amount: money(thanks[1]), date: thanks[2] ? longDate(thanks[2]) : null };
  if (lastAt < 0 && thanks && thanks[2] && balance === 0) {
    transactions.push({ date: longDate(thanks[2]), description: 'Payment - Thank You', kind: 'payment', amount: -money(thanks[1]), units: null, unitPrice: null });
    if (previousBalance === null) previousBalance = money(thanks[1]);
  }

  // ---- THIS BILL SUMMARY ----
  const sumAt = lines.indexOf('THIS BILL SUMMARY');
  const header = lines[sumAt + 1] ?? '';
  const cols: ('plans' | 'equipment' | 'services' | 'oneTime' | 'total')[] = [];
  for (const h of header.match(/Plans|Equipment|Services|One-time charges|Total/g) ?? []) {
    cols.push(h === 'Plans' ? 'plans' : h === 'Equipment' ? 'equipment' : h === 'Services' ? 'services' : h === 'One-time charges' ? 'oneTime' : 'total');
  }
  if (!cols.includes('total') || cols.length < 3) throw new UnreadableStatement(`Unexpected bill summary header "${header}"`);
  const CELL = String.raw`(Included|-|${AMT})`;
  const rowRe = new RegExp(`^(.+?) ${Array(cols.length).fill(CELL).join(' ')}$`);
  type Row = Record<(typeof cols)[number], number> & { included: boolean };
  const readRow = (cells: string[]): Row => {
    const row = { plans: 0, equipment: 0, services: 0, oneTime: 0, total: 0, included: false } as Row;
    cells.forEach((c, k) => {
      row[cols[k]] = cell(c);
      if (cols[k] === 'plans' && c === 'Included') row.included = true;
    });
    return row;
  };
  let totals: Row | null = null;
  let accountRow: Row | null = null;
  const billLines: TmobileLine[] = [];
  for (let i = sumAt + 2; i < lines.length && lines[i] !== 'DETAILED CHARGES'; i++) {
    const r = lines[i].match(rowRe);
    if (!r) continue;
    const label = r[1];
    const row = readRow(r.slice(2, 2 + cols.length));
    if (label === 'Totals') totals = row;
    else if (label === 'Account') accountRow = row;
    else {
      const p = label.match(new RegExp(`^(${PHONE})(?: - (.+?))?(?: (Voice|Wearable|Digits|Mobile Internet|Data|Tablet|Hotspot|Smartwatch|Home Internet))?$`));
      if (!p) continue;
      billLines.push({
        number: p[1],
        digits: digitsOf(p[1]),
        type: p[3] ?? null,
        status: p[2] ?? null,
        plans: row.plans,
        planIncluded: row.included,
        equipment: row.equipment,
        services: row.services,
        oneTime: row.oneTime,
        total: row.total,
        dataGb: null,
      });
    }
  }
  if (!totals) throw new UnreadableStatement('Missing bill summary Totals row');

  // ---- DETAILED CHARGES ----
  const detAt = lines.indexOf('DETAILED CHARGES');
  const detail = lines.slice(detAt);
  // Plan name: "Account Go5G Plus Military $120.00" or a line row.
  let plan: string | null = null;
  for (const l of detail) {
    const r = l.match(new RegExp(`^(?:Account|${PHONE}) ((?:Magenta|Go5G|Essentials|Experience|T-Mobile ONE|Simple Choice)[^$]*?)(?: Included| ${AMT})?$`));
    if (r) {
      plan = r[1].replace(/®/g, '').replace(/\s+/g, ' ').trim();
      break;
    }
  }
  let servicePeriodStart: string | null = null;
  let servicePeriodEnd: string | null = null;
  for (const l of detail) {
    const r = l.match(/^REGULAR CHARGES ([A-Z][a-z]{2} \d{2}) - ([A-Z][a-z]{2} \d{2})\b/);
    if (r) {
      const p = shortRange(r[1], r[2], billDate);
      servicePeriodStart = p.start;
      servicePeriodEnd = p.end;
      break;
    }
  }

  // Equipment detail: items end with an amount line ("$2.50", "-$37.71" or
  // "-") right after an "ID: …" line; the lines before the ID name the
  // device (or the promo) and, when present, the line's number.
  const devices: TmobileDevice[] = [];
  const promos: TmobilePromo[] = [];
  let equipmentItems = 0;
  let equipmentItemCount = 0;
  const eqAt = detail.findIndex((l) => new RegExp(`^EQUIPMENT(?: ${AMT})?$`).test(l));
  if (eqAt >= 0) {
    let curLine: string | null = null;
    let head: string[] = [];
    for (let i = eqAt + 1; i < detail.length; i++) {
      const l = detail[i];
      // The block can run across a page break (page header + boilerplate in
      // between) — keep going until the next section.
      // The YOU SAVED / YOU USED side column can sit in the middle (2022-07)
      // — its rows never carry an "ID:" line, so they're just skipped.
      if (/^(SERVICES|TAXES & FEES BREAKDOWN|INCLUDED TAXES & FEES)$/.test(l) || new RegExp(`^SERVICES ${AMT}$`).test(l)) break;
      if (/^(HANDSETS?|WEARABLES?|TABLETS?|ACCESSORIES|Balances shown are|Promotional credits apply|Here’s where you’ll get|Here's where you'll get)/.test(l)) {
        head = [];
        continue;
      }
      if (/^ID: /.test(l)) {
        let idLine = l;
        // "ID: …, Your installment plan has been completed," + "pending any …"
        while (i + 1 < detail.length && !new RegExp(`^(${AMT}|-)$`).test(detail[i + 1]) && !/^ID: /.test(detail[i + 1]) && idLine.length < 300) idLine = `${idLine} ${detail[++i]}`;
        const amtLine = detail[i + 1] ?? '';
        if (!new RegExp(`^(${AMT}|-)$`).test(amtLine)) {
          head = [];
          continue;
        }
        i++;
        const amount = amtLine === '-' ? 0 : money(amtLine);
        equipmentItems = round2(equipmentItems + amount);
        equipmentItemCount++;
        const id = idLine.match(/^ID: (\d+)/)?.[1] ?? null;
        // Name: first head line; a leading phone number sets the line.
        const cut = head.findIndex((h) => / installment with /.test(h));
        let named = cut >= 0 ? head.slice(0, cut) : head;
        const phoneAt = named.map((h) => new RegExp(`^${PHONE} `).test(h)).lastIndexOf(true);
        if (phoneAt > 0) named = named.slice(phoneAt);
        else if (named.length > 2) named = named.slice(-1); // page-break junk before a promo row
        let name = named.join(' ').trim();
        const ph = name.match(new RegExp(`^(${PHONE}) ?(.*)$`));
        if (ph) {
          curLine = ph[1];
          name = ph[2];
        }
        head = [];
        const bal = idLine.match(/Balance: (\$[\d,]+\.\d{2})/);
        const inst = idLine.match(/Installment (\d+) of (\d+)/);
        const completed = /installment plan has been completed/i.test(idLine);
        const isPromo = /Trade|Promo|Buy and Save|Credit|Reversal|Discount|Prepayment|^P\d{3} /i.test(name) && !bal;
        if (isPromo || (amount < 0 && !bal)) {
          promos.push({ id, line: curLine, description: name || 'Device credit', amount });
        } else if (id) {
          devices.push({
            id,
            line: curLine,
            device: name || 'Device',
            charge: amount,
            balance: bal ? money(bal[1]) : completed ? 0 : null,
            installment: inst ? Number(inst[1]) : null,
            of: inst ? Number(inst[2]) : null,
            completed: completed || (bal ? money(bal[1]) === 0 : false),
          });
        }
        continue;
      }
      if (new RegExp(`^(${AMT}|-)$`).test(l)) {
        head = [];
        continue;
      }
      head.push(l);
    }
  }

  // ---- YOU SAVED ----
  let savings: number | null = null;
  const savingsParts: { label: string; amount: number }[] = [];
  const savAt = lines.indexOf('YOU SAVED');
  if (savAt >= 0) {
    for (let i = savAt + 1; i < Math.min(lines.length, savAt + 16) && lines[i] !== 'YOU USED'; i++) {
      const r = lines[i].match(new RegExp(`^(TOTAL|[A-Z][A-Za-z ]+ discounts) (${AMT})$`));
      if (!r) continue;
      if (r[1] === 'TOTAL') savings = money(r[2]);
      else savingsParts.push({ label: r[1], amount: money(r[2]) });
    }
  }

  // ---- YOU USED ----
  let dataGb: number | null = null;
  let minutes: number | null = null;
  let messages: number | null = null;
  const usedAt = lines.indexOf('YOU USED');
  if (usedAt >= 0) {
    const block = lines.slice(usedAt + 1, usedAt + 40);
    const tot = block.join('\n').match(/^([\d,.]+)\s*\n\s*(GB|MB)\s*\n\s*of unlimited data/m);
    if (tot) dataGb = round2(Number(tot[1].replace(/,/g, '')) / (tot[2] === 'MB' ? 1024 : 1));
    for (let k = 0; k < block.length; k++) {
      const r = block[k].match(new RegExp(`^(${PHONE}) ([\\d,.]+)$`));
      if (r && /^(GB|MB)$/.test(block[k + 1] ?? '')) {
        const gb = round2(Number(r[2].replace(/,/g, '')) / (block[k + 1] === 'MB' ? 1024 : 1));
        const ln = billLines.find((b) => b.number === r[1]);
        if (ln) ln.dataGb = gb;
      }
    }
    const mm = block.join(' ').match(/([\d,]+) minutes of talk &\s*([\d,]+) messages/);
    if (mm) {
      minutes = Number(mm[1].replace(/,/g, ''));
      messages = Number(mm[2].replace(/,/g, ''));
    }
  }

  // ---- Taxes & fees (informational — they're inside the prices) ----
  let taxesIncluded: number | null = null;
  let taxesAdded: number | null = null;
  const incAt = lines.indexOf('INCLUDED TAXES & FEES');
  if (incAt >= 0) {
    taxesIncluded = 0;
    for (let i = incAt + 1; i < lines.length; i++) {
      const l = lines[i];
      if (/^(ADDITIONAL |WHAT YOU NEED|Bill issue date|Bill period|APPENDIX)/.test(l)) break;
      const r = l.match(new RegExp(`^(.+?) (${AMT})$`));
      if (!r || /before taxes|^& fees/.test(r[1]) || /before taxes\s*$/.test(lines[i - 1] ?? '')) continue;
      taxesIncluded = round2(taxesIncluded + money(r[2]));
    }
  }
  const addAt = lines.findIndex((l) => /^ADDITIONAL (GOVERNMENT TAXES|T-MOBILE FEES)/.test(l));
  if (addAt >= 0) {
    taxesAdded = 0;
    for (let i = addAt + 1; i < lines.length; i++) {
      const l = lines[i];
      if (/^(WHAT YOU NEED|Bill issue date|Bill period|APPENDIX)/.test(l)) break;
      if (/^ADDITIONAL /.test(l)) continue;
      const r = l.match(new RegExp(`^(?:Account|${PHONE}) .+? (${AMT})$`));
      if (r) taxesAdded = round2(taxesAdded + money(r[1]));
    }
  }

  const late = body.match(/had a Late Payment of\s+(\$[\d,]+\.\d{2})/) ?? body.match(/Late fee for invoice[^\n$]*?(\$[\d,]+\.\d{2})/);
  const lateFee = late ? money(late[1]) : null;

  const values: TmobileValues = {
    era,
    account,
    billDate,
    dueDate,
    dueNote,
    totalDue,
    autopay,
    autopayDate,
    autopayCard,
    balance,
    balanceLabel,
    previousBalance,
    plans: totals.plans,
    equipment: totals.equipment,
    services: totals.services,
    oneTime: totals.oneTime,
    charges: totals.total,
    accountRow: accountRow ? { plans: accountRow.plans, equipment: accountRow.equipment, services: accountRow.services, oneTime: accountRow.oneTime, total: accountRow.total } : null,
    lines: billLines,
    plan,
    servicePeriodStart,
    servicePeriodEnd,
    devices,
    promos,
    savings,
    savingsParts,
    dataGb,
    minutes,
    messages,
    taxesIncluded,
    taxesAdded,
    lastPayment,
    lateFee,
  };

  // ---- Checks ----
  const checks: StatementCheck[] = [];
  checks.push(check('Balance + This Bill = Total Due', cents(round2(balance + totals.total), totalDue), `${fmtMoney(balance)} + ${fmtMoney(totals.total)} vs ${fmtMoney(totalDue)}`));
  const colSum = round2(totals.plans + totals.equipment + totals.services + totals.oneTime);
  checks.push(check('Plans + Equipment + Services + One-Time = Totals', cents(colSum, totals.total), `${fmtMoney(colSum)} vs ${fmtMoney(totals.total)}`));
  const rows = [...(accountRow ? [accountRow] : []), ...billLines];
  const rowSum = round2(rows.reduce((s, r) => s + r.total, 0));
  checks.push(check('Account + Lines = Totals', cents(rowSum, totals.total), `${fmtMoney(rowSum)} vs ${fmtMoney(totals.total)} (${billLines.length} lines)`));
  if (lastAt >= 0 && previousBalance !== null) {
    const moved = round2(transactions.reduce((s, t) => s + t.amount, 0));
    checks.push(
      check('Previous Balance + Payments + Credits = Balance', cents(round2(previousBalance + moved), balance), `${fmtMoney(previousBalance)} + ${fmtMoney(moved)} vs ${fmtMoney(balance)}`)
    );
  }
  if (equipmentItemCount) {
    checks.push(check('Itemized Equipment = Equipment', cents(equipmentItems, totals.equipment), `${fmtMoney(equipmentItems)} vs ${fmtMoney(totals.equipment)}`));
  }

  return {
    periodStart: billDate,
    periodEnd: billDate,
    values: values as unknown as Record<string, unknown>,
    transactions: transactions.sort((x, y) => x.date.localeCompare(y.date)),
    checks,
  };
}

/** Consecutive bills (≤ 40 days apart): last bill's Total Due is this
 * bill's previous balance ("Your last bill was" / YOUR LAST BILL / the
 * amount paid when it was paid in full). */
export function crossCheckTmobile(prev: { periodEnd: string; values: TmobileValues } | null, cur: { periodEnd: string; values: TmobileValues }): StatementCheck[] {
  if (!prev || cur.values.previousBalance === null) return [];
  const days = Math.round((Date.parse(`${cur.periodEnd}T12:00:00Z`) - Date.parse(`${prev.periodEnd}T12:00:00Z`)) / 86400000);
  if (days > 40) return [];
  return [check('Prior Total Due = This Previous Balance', cents(prev.values.totalDue, cur.values.previousBalance), `${fmtMoney(prev.values.totalDue)} vs ${fmtMoney(cur.values.previousBalance)}`)];
}
