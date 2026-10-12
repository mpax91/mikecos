import { check, cents, money, round2, UnreadableStatement } from '../common';
import type { ParsedStatement, ParsedTransaction, StatementCheck } from '../common';

/** Template #10 — PayPal (monthly), Drive folder "PayPal", files
 * "PayPal - YYYY.MM.pdf" (2011-05 → today). PayPal only sends a statement
 * for a month with activity, so gaps are normal ("quiet"), not missing.
 *
 * PayPal is a pass-through "payment app": the balance is almost always $0.
 * A payment to a store or person is funded either inline (a card or bank
 * line under the payment, "Visa x-0139 26.70 USD") or by a separate
 * funding row ("General Credit Card Deposit", Ref ID = the payment's ID);
 * money received lands in the balance (minus PayPal's fee) and is then
 * withdrawn to the bank. Layouts:
 *   classic   "Account Statement | June 2018" (→ 2019-03): Beginning /
 *             Ending Balance, one activity table.
 *   activity  "This document contains a view of all PayPal account
 *             activity" (2019-04 → ~2021): no balance printed.
 *   twoPart   "This document contains two statements" (→ today): PayPal
 *             account activity, then the PayPal Balance account (Available
 *             beginning / ending, fees this period / YTD) repeating only the
 *             rows that touched the balance — only the first part is read.
 * 2011–2017 PDFs use M/D/YYYY dates and older row names ("Payment Sent :",
 * "Charge From Credit Card", "Add Funds from a Bank Account"); the parser
 * splits rows on dates rather than lines so those read too.
 * Every row: date, PayPal type, counterparty, optional funding line, ID,
 * optional Ref ID, then "USD amount fee total". See
 * docs/statement-templates/paypal.md. */

export type PaypalClass =
  | 'purchase' // paid a store / service
  | 'payment' // sent money to a person
  | 'received' // money received (person or business)
  | 'refund' // refund back to Mike (or one Mike sent: negative)
  | 'reward' // PayPal's own credits (MSB Redemption, Mass Pay from PayPal)
  | 'withdrawal' // balance → bank
  | 'add_funds' // bank → balance (not tied to one payment)
  | 'funding' // a card/bank row funding one payment (hidden in activity)
  | 'card_return'; // money sent back to a card, not tied to one row

export interface PaypalFunding {
  /** "Visa", "Discover", "USAA Checking", "PayPal Balance", "Card" (a
   * General Credit Card Deposit row — PayPal doesn't say which card). */
  label: string;
  kind: 'card' | 'bank' | 'balance' | 'reward';
  last4: string | null;
  amount: number;
  /** Printed under the payment itself (vs. a separate funding row). */
  inline?: boolean;
}

export interface PaypalRow {
  date: string;
  /** PayPal's transaction type ("Express Checkout Payment"). */
  type: string;
  /** The store / person ('' when PayPal printed none). */
  name: string;
  currency: string;
  amount: number;
  fee: number;
  total: number;
  id: string | null;
  refId: string | null;
  cls: PaypalClass;
  recurring: boolean;
  /** Where the money came from (payments) or went (withdrawals/refunds). */
  funding: PaypalFunding[];
  /** For a 'funding' row: the ID of the row it pays for. */
  fundsId?: string | null;
}

export interface PaypalValues {
  era: 'classic' | 'activity' | 'twoPart' | 'legacy';
  /** Printed balance (null when this layout prints none). */
  beginning: number | null;
  ending: number | null;
  feesPeriod: number | null;
  feesYtd: number | null;
  rows: PaypalRow[];
  /** Totals over the visible activity (funding rows excluded). */
  spent: number; // purchases + payments to people, positive
  received: number; // money in (people, businesses, rewards), positive
  refunds: number; // refunds back to Mike, positive
  withdrawn: number; // to the bank, positive
  fees: number; // PayPal fees, positive
}

const AMT = String.raw`-?[\d,]+\.\d{2}`;
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function longDate(raw: string): string {
  const m = raw.trim().match(/^([A-Za-z]+)\.? (\d{1,2}), (\d{4})$/);
  const mi = m ? MONTHS[m[1].slice(0, m[1].toLowerCase() === 'sept' ? 4 : 3).toLowerCase()] : undefined;
  if (!m || !mi) throw new UnreadableStatement(`Not a date: "${raw}"`);
  return `${m[3]}-${String(mi).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

function slashDate(raw: string): string {
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) throw new UnreadableStatement(`Not a date: "${raw}"`);
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Funding-type rows: they move money in/out of PayPal for ANOTHER row. */
const FUNDING_TYPE =
  /^(General Credit Card Deposit|General Credit Card Withdrawal|Charge From Credit Card|Credit Card Deposit|Add Funds from a Bank Account|Bank Deposit to PP Account|Other|Transfer from|Instant Transfer from)/i;
const CARD_FUNDING = /Credit Card|Debit Card/i;
// "PreApproved Payment" = a merchant with a saved billing agreement (one-click
// checkout) — not necessarily a subscription, so it isn't counted here.
const RECURRING_TYPE = /Subscription|Recurring/i;
const PERSON_TYPE = /^(General Payment|Mobile Payment|Payment Sent|Money Sent|Personal Payment|Payment To|Send Money)/i;

/** Classify a non-funding row. */
export function classify(type: string, name: string, amount: number): PaypalClass {
  if (/Withdraw/i.test(type)) return 'withdrawal';
  if (/Refund|Reversal/i.test(type)) return 'refund';
  if (/MSB Redemption|Reward|Cash ?back/i.test(type) || (/Mass Pay/i.test(type) && /^PayPal/i.test(name))) return 'reward';
  if (/Bank Deposit|Add Funds|Transfer from/i.test(type)) return 'add_funds';
  if (amount > 0) return 'received';
  return PERSON_TYPE.test(type) ? 'payment' : 'purchase';
}

function fundingKind(label: string): 'card' | 'bank' {
  return /Checking|Savings|BANK|Bank Account|Credit Union/i.test(label) ? 'bank' : 'card';
}

/** Tidy a bank label: "USAA FEDERAL SAVINGS BANK - Checking" → "USAA Checking". */
function tidyFundingLabel(raw: string): string {
  const s = raw
    .replace(/\s+/g, ' ')
    .replace(/\s*-\s*$/, '')
    .trim();
  const bank = s.match(/^(.*?)(?: FEDERAL SAVINGS BANK| Federal Savings Bank)?\s*-\s*(Checking|Savings)$/i);
  if (bank) {
    const inst = bank[1].replace(/\s*(Checking|Savings)$/i, '').trim();
    return `${inst.split(' ')[0] === inst.toUpperCase().split(' ')[0] && inst.length <= 5 ? inst : inst.replace(/\b(\w)(\w*)\b/g, (_, a: string, b: string) => a + b.toLowerCase())} ${bank[2][0].toUpperCase()}${bank[2].slice(1).toLowerCase()}`.trim();
  }
  return s;
}

/** Inline funding lines within one row's text (card / bank / balance). */
function fundingLines(chunk: string): PaypalFunding[] {
  const out: PaypalFunding[] = [];
  // Cards / banks: "<label> x-1234[ amount[ USD]]"; label may wrap a line
  // ("USAA FEDERAL SAVINGS BANK -\nChecking x-9190 184.74\nUSD").
  const re = new RegExp(String.raw`([A-Za-z][A-Za-z0-9 .&'/-]*?(?:\n[A-Za-z][A-Za-z0-9 .&'/-]*?)?)\s*x-(\d{4})(?:[ \t]+(${AMT}))?`, 'g');
  for (const m of chunk.matchAll(re)) {
    let label = m[1]
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    // Only the trailing label lines belong to the funding (a wrapped bank
    // name ends with " -"); drop anything that's the row's description.
    if (label.length > 1 && !/-\s*$/.test(label[label.length - 2])) label = label.slice(-1);
    const text = tidyFundingLabel(label.join(' ').replace(/^.*?\b(USD|-?[\d,]+\.\d{2})\s+/, ''));
    out.push({ label: text || 'Card', kind: fundingKind(text), last4: m[2], amount: m[3] ? money(m[3]) : 0, inline: true });
  }
  // Discounts PayPal applied at checkout: "eBay Coupon 5.00 USD",
  // "ReserveBar.com Special offer 5.00 USD", "CURP Card 5.67 USD" (PayPal
  // rewards points).
  for (const m of chunk.matchAll(new RegExp(String.raw`^([^\n]+?)[ \t]+(${AMT})[ \t]+USD$`, 'gm'))) {
    if (/x-\d{4}|^PayPal Balance|^USD\b|^Available|Balance$/i.test(m[1]) || money(m[2]) === 0) continue;
    const label = /CURP|Reward/i.test(m[1]) ? 'PayPal Rewards' : /Coupon/i.test(m[1]) ? 'Coupon' : /offer/i.test(m[1]) ? 'Special Offer' : m[1].trim();
    out.push({ label, kind: 'reward', last4: null, amount: money(m[2]), inline: true });
  }
  // 2011–2017 print the amount first: "60.00 USD USAA Checking - Checking x-9190".
  for (const m of chunk.matchAll(new RegExp(String.raw`(${AMT})\s+USD\s+([A-Za-z][A-Za-z0-9 .&'/-]*?)\s*x-(\d{4})`, 'g'))) {
    if (out.some((o) => o.last4 === m[3] && o.amount !== 0)) continue;
    const text = tidyFundingLabel(m[2]);
    const dup = out.findIndex((o) => o.last4 === m[3] && o.amount === 0);
    if (dup >= 0) out.splice(dup, 1);
    out.push({ label: text || 'Card', kind: fundingKind(text), last4: m[3], amount: money(m[1]), inline: true });
  }
  const bal = chunk.match(new RegExp(String.raw`PayPal Balance\s+(${AMT})\s*USD`));
  if (bal) out.push({ label: 'PayPal Balance', kind: 'balance', last4: null, amount: money(bal[1]) });
  return out;
}

/** The activity part of the statement text (headers/footers removed). */
function activityText(text: string): string {
  let t = text.replace(/\r/g, '');
  // Two-part statements: the PayPal Balance account repeats balance rows.
  const cut = t.search(/^PAYPAL BALANCE ACCOUNT\b/m);
  const firstHeader = t.search(/^(Date Description Currency|DATE DESCRIPTION CURRENCY)/im);
  if (cut > 0 && cut > firstHeader) t = t.slice(0, cut);
  let start = t.search(/(Date Description Currency Amount Fees Total|DATE DESCRIPTION CURRENCY AMOUNT FEES TOTAL|Amount Fees Total\*{0,2} Date Description Currency)/i);
  if (start < 0) start = t.search(/^Account Activity\b/im);
  if (start < 0) return '';
  t = t.slice(start);
  // A date can wrap: "08/08/202\n3\n" → "08/08/2023".
  t = t.replace(/(^|\n)(\d{1,2}\/\d{1,2}\/\d{1,3})\n(\d{1,3})\n/g, (m, a: string, d: string, rest: string) => (/\/\d{4}$/.test(d + rest) ? `${a}${d}${rest} ` : m));
  return t
    .split('\n')
    .filter(
      (l) =>
        !/^(Date Description Currency|DATE DESCRIPTION CURRENCY|Amount Fees Total|Account Activity|ACCOUNT STATEMENTS|Palladino,|Statement Period|PAYPAL ACCOUNT|ACCOUNT ACTIVITY|Page \d+|[*º]|In case of errors|•|Contact us|We must hear|\d\. |We will investigate|investigation|To report|To cancel|You must notify|The money in your PayPal|It does not apply|complaint|period if a good|suspected error|that only calls|pertaining to|if you have a pending|Department, P\.O\.|Debit Card Department|Box 45950|10 business days|good reason|that we need|<https?:)/i.test(
          l.trim(),
        ) &&
        !/^(Nov|Dec|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct)[a-z]* \d{1,2}, \d{4}/.test(l.trim()) &&
        !/^\d{4}$/.test(l.trim()) &&
        !/@/.test(l),
    )
    .join('\n')
    .replace(/\.{6,}/g, '\n');
}

/** Split activity text into one chunk per row (rows start with a date). */
function rowChunks(act: string): { date: string; body: string }[] {
  const re = /(?:^|\s)(\d{1,2}\/\d{1,2}\/\d{4})\s+(?=[A-Za-z])/g;
  const starts: { idx: number; end: number; date: string }[] = [];
  for (const m of act.matchAll(re)) starts.push({ idx: m.index!, end: m.index! + m[0].length, date: m[1] });
  return starts.map((s, i) => ({ date: slashDate(s.date), body: act.slice(s.end, i + 1 < starts.length ? starts[i + 1].idx : act.length).trim() }));
}

/** "Express Checkout Payment: Wolf &\nShepherd, Inc." → type + name. */
function typeAndName(body: string): { type: string; name: string } {
  // 2011–2017: "USD -60.00 0.00 -60.00 General Payment: Robert Palladino".
  body = body.replace(new RegExp(String.raw`^[A-Z]{3}\s+${AMT}\s+${AMT}\s+${AMT}\s+`), '');
  const lines = body.split('\n').map((l) => l.trim());
  const desc: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    if (i > 0 && (/x-\d{4}|^ID:|^Ref ID:|^[A-Z]{3}\s+-?[\d,]+\.\d{2}|^PayPal Balance|^USD$|-\s*$|\s-?[\d,]+\.\d{2}\s+USD$/.test(l) || (/x-\d{4}/.test(lines[i + 1] ?? '') && /-\s*$/.test(l)))) break;
    // Older layouts print the amounts (and funding) on the description line.
    const cutAt = l.search(new RegExp(String.raw`\s(?:[A-Z]{3}\s+${AMT}\s|ID:)`));
    if (cutAt >= 0) l = l.slice(0, cutAt);
    if (i > 0 && !l) break;
    desc.push(l);
    if (cutAt >= 0) break;
  }
  const d = desc.join(' ').replace(/\s+/g, ' ').trim();
  const m = d.match(/^(.*?)\s*:\s*(.*)$/);
  return m ? { type: m[1].trim(), name: m[2].trim() } : { type: d, name: '' };
}

export function parsePaypal(text: string): ParsedStatement {
  const flat = text.replace(/\s+/g, ' ');
  if (!/PayPal/i.test(flat)) throw new UnreadableStatement('Not a PayPal statement');

  // ---- Period ----
  let periodStart: string;
  let periodEnd: string;
  const rng = flat.match(/([A-Z][a-z]+\.? \d{1,2}, \d{4}) ?- ?([A-Z][a-z]+\.? \d{1,2}, \d{4})/);
  if (rng) {
    periodStart = longDate(rng[1]);
    periodEnd = longDate(rng[2]);
  } else {
    const mo = flat.match(/Account Statement \| ([A-Z][a-z]+) (\d{4})/);
    const mi = mo ? MONTHS[mo[1].slice(0, 3).toLowerCase()] : undefined;
    if (!mo || !mi) throw new UnreadableStatement('Missing statement period');
    const y = Number(mo[2]);
    periodStart = `${y}-${String(mi).padStart(2, '0')}-01`;
    periodEnd = `${y}-${String(mi).padStart(2, '0')}-${String(lastDay(y, mi)).padStart(2, '0')}`;
  }

  const era: PaypalValues['era'] = /This document contains two statements/i.test(flat)
    ? 'twoPart'
    : /This document contains a view of all PayPal account activity/i.test(flat)
      ? 'activity'
      : /Account Statement \|/i.test(flat) && /\d{2}\/\d{2}\/\d{4}/.test(flat)
        ? 'classic'
        : 'legacy';

  const numAfter = (re: RegExp) => {
    const m = flat.match(re);
    return m ? money(m[1]) : null;
  };
  let beginning = numAfter(new RegExp(String.raw`(?:Available beginning|Beginning Balance)\s+(${AMT})`, 'i'));
  let ending = numAfter(new RegExp(String.raw`(?:Available ending|Ending Balance)\s+(${AMT})`, 'i'));
  // 2011–2017: labels first, then "USD 0.00 0.00" (one column per currency;
  // the USD column is the one read).
  const col = flat.match(new RegExp(String.raw`Beginning Balance Ending Balance ((?:[A-Z]{3} )+)((?:${AMT} ?)+)`));
  if (beginning === null && col) {
    const curs = col[1].trim().split(' ');
    const nums = col[2].trim().split(' ').map(money);
    const ui = Math.max(0, curs.indexOf('USD'));
    if (nums.length >= curs.length * 2) {
      // values come row-wise: beginning per currency, then ending per currency
      beginning = nums[ui];
      ending = nums[curs.length + ui];
    }
  }
  const feesPeriod = numAfter(new RegExp(String.raw`This period\s+(${AMT})`, 'i'));
  const feesYtd = numAfter(new RegExp(String.raw`Year-to-date\s+(${AMT})`, 'i'));

  // ---- Rows ----
  const act = activityText(text);
  const rows: PaypalRow[] = [];
  const checks: StatementCheck[] = [];
  let mathBad = 0;
  for (const ch of rowChunks(act)) {
    const triple = ch.body.match(new RegExp(String.raw`\b([A-Z]{3})\s+(${AMT})\s+(${AMT})\s+(${AMT})(?!\d)`));
    if (!triple) throw new UnreadableStatement(`Row without amounts on ${ch.date}: "${ch.body.slice(0, 60)}"`);
    const amount = money(triple[2]);
    const fee = money(triple[3]);
    const total = money(triple[4]);
    if (!cents(amount + fee, total)) mathBad++;
    const { type, name } = typeAndName(ch.body);
    const id = ch.body.match(/(?<!Ref )ID:\s*([A-Z0-9]{12,20})/)?.[1] ?? null;
    const refId = ch.body.match(/Ref ID:\s*([A-Z0-9]{12,20})/)?.[1] ?? null;
    // Funding lines live outside the amounts triple.
    const rest = ch.body.replace(triple[0], ' ');
    const funding = fundingLines(rest);
    const isFunding = FUNDING_TYPE.test(type);
    rows.push({
      date: ch.date,
      type,
      name,
      currency: triple[1],
      amount,
      fee,
      total,
      id,
      refId,
      cls: isFunding ? 'funding' : classify(type, name, amount),
      recurring: RECURRING_TYPE.test(type),
      funding,
    });
  }
  if (!rows.length && /\d{1,2}\/\d{1,2}\/\d{4}\s+[A-Za-z]/.test(act)) throw new UnreadableStatement('Couldn’t read any activity rows');

  // ---- Pair funding rows with the row they pay for ----
  const byId = new Map(rows.filter((r) => r.id).map((r) => [r.id!, r]));
  const used = new Set<PaypalRow>();
  for (const f of rows.filter((r) => r.cls === 'funding')) {
    let target: PaypalRow | undefined;
    if (f.refId) {
      // The row it pays for: the payment with that ID, or — for money sent
      // back to a card — the refund that shares its Ref ID. Prefer the one
      // whose amount it mirrors (+X funds −X, −X returns a +X refund).
      const cands = [byId.get(f.refId), ...rows.filter((r) => r !== f && r.refId === f.refId)].filter((r): r is PaypalRow => !!r && r !== f && r.cls !== 'funding' && !used.has(r));
      target = cands.find((r) => cents(r.total, -f.total)) ?? cands.find((r) => Math.sign(r.total) === -Math.sign(f.total)) ?? cands[0];
    }
    if (!target) {
      // Older layouts: no Ref ID — the payment on the same day for the same amount.
      target = rows.find((r) => r !== f && r.cls !== 'funding' && !used.has(r) && r.date === f.date && cents(r.total, -f.total));
    }
    if (target) {
      used.add(target);
      f.fundsId = target.id;
      const label = /Bank/i.test(f.type) ? 'Bank Account' : CARD_FUNDING.test(f.type) ? 'Card' : 'PayPal Adjustment';
      // Funding row +X for a payment of −X (or −X returning a refund to the card).
      target.funding.push({ label, kind: label === 'Bank Account' ? 'bank' : 'card', last4: null, amount: f.total });
    } else {
      // Not tied to one row: money added from the bank, or sent back to a card.
      f.cls = f.total >= 0 ? 'add_funds' : CARD_FUNDING.test(f.type) ? 'card_return' : 'withdrawal';
    }
  }

  // PayPal credits (MSB Redemption) applied to one payment count toward it.
  for (const r of rows.filter((x) => x.cls === 'reward' && x.refId)) {
    const target = byId.get(r.refId!);
    if (target && target !== r && (target.cls === 'purchase' || target.cls === 'payment')) target.funding.push({ label: 'PayPal Credit', kind: 'reward', last4: null, amount: r.total });
  }

  // ---- Checks ----
  checks.push(check('Amount + fee = total', mathBad === 0, mathBad ? `${mathBad} row(s) don’t add up` : `${rows.length} rows`));
  // Balance effect of each row: its total, less whatever an outside card or
  // bank put in (inline funding lines; positive = card paid PayPal).
  const effect = (r: PaypalRow) => r.total + r.funding.filter((f) => f.kind !== 'balance' && f.inline).reduce((s, f) => s + f.amount, 0);
  if (beginning !== null && ending !== null) {
    const net = round2(rows.filter((r) => r.currency === 'USD').reduce((s, r) => s + effect(r), 0));
    checks.push(check('Balance carries', cents(beginning + net, ending), `${beginning.toFixed(2)} + ${net.toFixed(2)} vs ${ending.toFixed(2)}`));
  }
  // Each payment is fully covered: outside funding + balance = what was paid.
  let uncovered = 0;
  for (const r of rows.filter((x) => x.cls === 'purchase' || x.cls === 'payment')) {
    const funded = round2(r.funding.reduce((s, f) => s + (f.kind === 'balance' ? -f.amount : f.amount), 0));
    if (r.funding.length && !cents(funded, -r.total)) uncovered++;
  }
  checks.push(check('Payments fully funded', uncovered === 0, uncovered ? `${uncovered} payment(s) where funding ≠ amount paid` : 'ok'));

  // ---- Totals + normalized transactions ----
  // Totals are USD (a few 2012 rows were in GBP; they're listed, not summed).
  const visible = rows.filter((r) => r.cls !== 'funding');
  const sum = (pred: (r: PaypalRow) => boolean, f: (r: PaypalRow) => number) => round2(visible.filter((r) => r.currency === 'USD' && pred(r)).reduce((s, r) => s + f(r), 0));
  const values: PaypalValues = {
    era,
    beginning,
    ending,
    feesPeriod,
    feesYtd,
    rows,
    spent: sum(
      (r) => r.cls === 'purchase' || r.cls === 'payment',
      (r) => -r.amount,
    ),
    received: sum(
      (r) => r.cls === 'received' || r.cls === 'reward',
      (r) => r.amount,
    ),
    refunds: sum(
      (r) => r.cls === 'refund' && r.amount > 0,
      (r) => r.amount,
    ),
    withdrawn: sum(
      (r) => r.cls === 'withdrawal',
      (r) => -r.total,
    ),
    fees: sum(
      (r) => r.fee !== 0,
      (r) => -r.fee,
    ),
  };

  const kindOf: Record<PaypalClass, ParsedTransaction['kind']> = {
    purchase: 'purchase',
    payment: 'payment',
    received: 'deposit',
    refund: 'refund',
    reward: 'reward',
    withdrawal: 'withdrawal',
    add_funds: 'transfer_in',
    funding: 'other',
    card_return: 'transfer_out',
  };
  const transactions: ParsedTransaction[] = [];
  for (const r of visible) {
    const who = `${r.name || r.type}${r.currency !== 'USD' ? ` (${r.currency})` : ''}`;
    transactions.push({
      date: r.date,
      description: who,
      kind: kindOf[r.cls],
      amount: r.cls === 'withdrawal' || r.cls === 'card_return' || r.cls === 'add_funds' ? r.total : r.amount,
      units: null,
      unitPrice: null,
    });
    if (r.fee) transactions.push({ date: r.date, description: `PayPal fee · ${who}`, kind: 'fee', amount: r.fee, units: null, unitPrice: null });
  }

  return { periodStart, periodEnd, values: values as unknown as Record<string, unknown>, transactions, checks };
}

/** Cross-statement check: a printed ending balance carries to the next
 * printed beginning (PayPal skips months with no activity). */
export function crossCheckPaypal(prev: { periodEnd: string; values: PaypalValues } | null, cur: { periodEnd: string; values: PaypalValues }): StatementCheck[] {
  if (!prev || prev.values.ending === null || cur.values.beginning === null) return [];
  return [check('Balance carries from last statement', cents(prev.values.ending, cur.values.beginning), `${prev.values.ending.toFixed(2)} → ${cur.values.beginning.toFixed(2)}`)];
}
