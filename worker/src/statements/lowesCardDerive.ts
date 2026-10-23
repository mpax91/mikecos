import type { Env } from '../types';
import { fmtMdy, fmtMoney } from './common';
import type { FolderRow } from './engine';
import { appOrigin, easternToday, ensureVaultEntry, seedFacts, syncAutoNote, syncFlags, syncManagedLinks } from './engine';
import type { AutoSection } from './engine';
import { bold, bullets, heading, kv, link, para, table } from './vaultDoc';
import { crossCheckLowesCard } from './templates/lowesCard';
import type { LowesCardValues } from './templates/lowesCard';
import { templateById } from './templates';
import { DORMANT_MONTHS, LOWES_COMPARE_RATE, summarizeLowesCard } from './lowesCardSummary';
import type { CheckingPayment, LowesCardStmtRow, LowesCardSummary, LowesCardTxnRow, LowesPayment } from './lowesCardSummary';
import { addMonths } from './adtSummary';
import { billingFromBills, payerFlags } from '../accountPayers';
import { cardChargeFlags } from './anomalies';
import type { BillingFacts } from '../accountPayers';
import type { CardFacts } from '../cardFacts';
import { rewardsFromLowesCard } from './rewards';
import type { CardRewards } from './rewards';

/** Lowe's credit card outputs: Vault entry "Lowe's Credit Card" (Vault entry
 * standard, docs/statement-templates/README.md), flags, the billing snapshot
 * (Payment Quick Facts + Bills & Due Dates), the card snapshot (Card Quick
 * Facts) and the estimated 5% savings (Card Rewards — nothing to redeem).
 *
 * Flags: unreadable / duplicate files and failed math; **unconfirmed** — the
 * latest statement's balance is past due and nothing proves it was paid (no
 * later statement in Drive, no matching Synchrony payment in USAA Checking);
 * a balance carried into a kept statement (months between = gap); interest,
 * a fee or a carried balance on the latest statement; a fee or interest that
 * only shows up in a printed year-to-date total (on a statement not kept);
 * a promotional (deferred-interest) balance; a change-in-terms notice / APR
 * change on the latest statement; the card unused for 12+ months (Synchrony
 * can close idle store cards); utilization ≥ 30%; duplicate charges; payer
 * flags. Payment-only months Mike doesn't keep are never flagged. */

interface FolderMeta {
  vault?: { note?: { noteId?: string; written?: string[] }; links?: Record<string, string> };
  billing?: BillingFacts | null;
  card?: CardFacts;
  rewards?: CardRewards;
  rewardsName?: string;
}

const UNCONFIRMED_GRACE_DAYS = 5;
const UTILIZATION_WARN_PCT = 30;

export async function loadLowesCardData(env: Env, folderId: string) {
  const [stmtRes, txnRes, fileRes] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM statements WHERE folder_row_id = ? ORDER BY period_end ASC').bind(folderId),
    env.DB.prepare('SELECT statement_id, txn_date, description, kind, amount FROM statement_transactions WHERE folder_row_id = ? ORDER BY txn_date ASC, position ASC').bind(folderId),
    env.DB.prepare('SELECT * FROM statement_files WHERE folder_row_id = ? ORDER BY file_name ASC').bind(folderId),
  ]);
  const stmts: LowesCardStmtRow[] = ((stmtRes.results ?? []) as Record<string, string>[]).map((r) => ({
    id: r.id,
    fileId: r.file_id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    values: JSON.parse(r.values_json) as LowesCardValues,
    checks: JSON.parse(r.checks_json),
  }));
  stmts.forEach((s, i) => s.checks.push(...crossCheckLowesCard(i ? stmts[i - 1] : null, s)));
  const txns: LowesCardTxnRow[] = ((txnRes.results ?? []) as Record<string, unknown>[]).map((r) => ({
    statementId: r.statement_id as string,
    date: r.txn_date as string,
    description: r.description as string,
    kind: r.kind as string,
    amount: r.amount as number,
  }));
  const files = (fileRes.results ?? []) as { file_id: string; file_name: string; web_url: string | null; status: string; error: string | null; statement_id: string | null }[];
  const checking = await loadCheckingPayments(env, stmts[0]?.values.closingDate ?? null);
  return { stmts, txns, files, checking };
}

/** Card payments out of the live USAA Checking folder since the first Lowe's
 * statement (null when there's no live checking folder to look in). */
export async function loadCheckingPayments(env: Env, since: string | null): Promise<CheckingPayment[] | null> {
  const folder = await env.DB.prepare(`SELECT id FROM statement_folders WHERE status = 'live' AND template_id = 'usaa' LIMIT 1`).first<{ id: string }>();
  if (!folder) return null;
  const { results } = await env.DB.prepare(`SELECT txn_date, description, amount FROM statement_transactions WHERE folder_row_id = ? AND kind = 'payment' AND txn_date >= ? ORDER BY txn_date ASC`)
    .bind(folder.id, since ?? '1900-01-01')
    .all<{ txn_date: string; description: string; amount: number }>();
  return (results ?? []).map((r) => ({ date: r.txn_date, description: r.description, amount: r.amount, account: 'USAA Checking' }));
}

const shortMonth = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);

/** One line for how a statement's balance was paid (dashboard + Vault note). */
export function lowesPaymentLine(p: LowesPayment, owed: number): string {
  switch (p.status) {
    case 'none_due':
      return owed < -0.005 ? 'Credit balance' : 'Nothing owed';
    case 'checking':
      return `Paid ${fmtMoney(p.amount ?? owed)} from ${p.source} on ${fmtMdy(p.date!)}${p.onTime === false ? ' (after the due date)' : ''}`;
    case 'statement':
      return `Paid${p.date ? ` ${fmtMdy(p.date)}` : ''} — shown on the ${p.source}${p.onTime === false ? ' (after the due date)' : ''}`;
    case 'next_zero':
      return `Paid in full — ${p.source}${p.onTime ? '; no late fee that year' : ''}`;
    case 'carried':
      return `Not paid in full — ${p.source}`;
    case 'due':
      return 'Not due yet';
    case 'unconfirmed':
      return 'Can’t confirm it was paid';
  }
}

export function lowesFlags(s: LowesCardSummary, today: string, name: string, phone: string, site: string): { key: string; severity: 'warn' | 'info'; message: string }[] {
  const flags: { key: string; severity: 'warn' | 'info'; message: string }[] = [];
  const latest = s.latest;
  // Balance carried into a later kept statement: the months between had a
  // balance, so their statements matter (interest / late fees).
  s.statements.forEach((r, i) => {
    if (r.payment.status !== 'carried' || i === s.statements.length - 1) return;
    const next = s.statements[i + 1];
    for (let d = addMonths(r.closingDate, 1); d.slice(0, 7) < next.closingDate.slice(0, 7); d = addMonths(d, 1)) {
      flags.push({ key: `gap:${d.slice(0, 7)}`, severity: 'warn', message: `${name}: the ${fmtMoney(r.newBalance)} balance from ${fmtMdy(r.closingDate)} wasn’t paid off before the next statement in Drive — the ${shortMonth(d)} statement (with a balance) is missing; download it from ${site}` });
    }
  });
  if (latest) {
    const when = fmtMdy(latest.closingDate);
    if (latest.payment.status === 'unconfirmed' && latest.dueDate && daysBetween(latest.dueDate, today) > UNCONFIRMED_GRACE_DAYS) {
      flags.push({
        key: `unconfirmed:${latest.closingDate}`,
        severity: 'warn',
        message: `Can’t confirm the ${fmtMoney(latest.newBalance)} ${name} balance (statement ${when}, due ${fmtMdy(latest.dueDate)}) was paid — no later statement in Drive${s.checkingLinked ? ' and no matching Synchrony payment in USAA Checking' : ''}. Check ${site}; if it’s paid, dismiss this (or drop the next statement, which shows the payment, into the folder).`,
      });
    }
    if (latest.interest > 0.005) flags.push({ key: `interest:${latest.closingDate}`, severity: 'warn', message: `Synchrony charged ${fmtMoney(latest.interest)} interest on the ${when} ${name} statement — at ${s.purchaseApr ?? 31.99}% APR, pay the full statement balance` });
    if (latest.fees > 0.005) flags.push({ key: `fee:${latest.closingDate}`, severity: 'warn', message: `A ${fmtMoney(latest.fees)} fee is on the ${when} ${name} statement — call ${phone} and ask for it to be waived` });
    if (latest.previousBalance > 0.005 && latest.previousBalance - latest.paid - latest.refunds > 0.005) {
      flags.push({ key: `carried:${latest.closingDate}`, severity: 'warn', message: `The ${fmtMoney(latest.previousBalance)} ${name} balance wasn’t paid in full by ${when} (${fmtMoney(latest.previousBalance - latest.paid - latest.refunds)} carried over)` });
    }
    if (latest.promos.some((p) => p.balance > 0.005)) {
      const total = latest.promos.reduce((t, p) => t + p.balance, 0);
      flags.push({
        key: `promo:${latest.closingDate}`,
        severity: 'warn',
        message: `${fmtMoney(total)} on the ${name} is a promotional (deferred-interest) balance — if it isn’t paid off before the promo ends, interest at ${s.purchaseApr ?? 31.99}% is charged back to the purchase date. The end date is in the statement’s Promotional Purchase Summary.`,
      });
    }
    if (latest.termsNotice) flags.push({ key: `terms:${latest.closingDate}`, severity: 'info', message: `The ${when} ${name} statement came with a change-in-terms notice${latest.noticeApr ? ` (APR going to ${latest.noticeApr}%)` : ''}` });
    for (const c of s.changes.filter((c) => c.date === latest.closingDate && c.what !== 'terms')) {
      flags.push({ key: `change:${c.what}:${c.date}`, severity: 'info', message: `${c.what === 'apr' ? 'Purchase APR' : 'Credit limit'} changed from ${c.from} to ${c.to} on the ${when} ${name} statement` });
    }
    if (s.utilization !== null && s.utilization >= UTILIZATION_WARN_PCT) {
      flags.push({ key: `utilization:${latest.closingDate}`, severity: 'info', message: `${s.utilization.toFixed(0)}% of the ${fmtMoney(s.creditLine ?? 0)} ${name} limit was in use at the ${when} closing — over 30% can lower a credit score` });
    }
    if (latest.newBalance < -0.005) flags.push({ key: `credit_balance:${latest.closingDate}`, severity: 'info', message: `A ${fmtMoney(-latest.newBalance)} credit balance is on the ${name} (${when}) — new purchases use it up, or call ${phone} for a refund` });
  }
  const cy = Number(today.slice(0, 4));
  for (const y of s.years) {
    if (y.hiddenFees < 0.005 && y.hiddenInterest < 0.005) continue;
    const what = [y.hiddenFees > 0.005 ? `${fmtMoney(y.hiddenFees)} in fees` : '', y.hiddenInterest > 0.005 ? `${fmtMoney(y.hiddenInterest)} in interest` : ''].filter(Boolean).join(' and ');
    const recent = y.year >= cy - 1;
    flags.push({
      key: `${recent ? 'fee:ytd' : 'hidden_fee'}:${y.year}`,
      severity: recent ? 'warn' : 'info',
      message: `${name}: the ${y.year} year-to-date totals show ${what} that aren’t on any statement in Drive — likely a late payment on a month you didn’t keep. ${recent ? `Call ${phone} and ask for a courtesy waiver.` : ''}`.trim(),
    });
  }
  if (s.dormant && s.lastPurchase && s.creditLine) {
    flags.push({
      key: `dormant:${s.lastPurchase}`,
      severity: 'info',
      message: `The ${name} hasn’t been used since ${fmtMdy(s.lastPurchase)} (${s.monthsSinceUse} months). Synchrony can close store cards that sit idle — that would drop ${fmtMoney(s.creditLine)} of available credit. One small Lowe’s purchase a year (paid in full) keeps it open.`,
    });
  }
  return flags;
}

export async function deriveLowesCard(env: Env, folder: FolderRow): Promise<void> {
  const template = templateById('lowesCard')!;
  const today = easternToday();
  const { stmts, txns, files, checking } = await loadLowesCardData(env, folder.id);
  const s = summarizeLowesCard(stmts, txns, checking, today);
  const latest = s.latest;
  const lv = stmts[stmts.length - 1]?.values ?? null;
  const fileUrl = (fileId: string) => files.find((f) => f.file_id === fileId)?.web_url ?? null;
  const name = template.account.nickname;
  const phone = template.account.phone ?? '';
  const site = 'lowes.com/eservice';

  let meta: FolderMeta = {};
  try {
    meta = folder.meta_json ? JSON.parse(folder.meta_json) : {};
  } catch {
    meta = {};
  }
  const entry = await ensureVaultEntry(env, folder.vault_entry_id, name);
  if (entry.id !== folder.vault_entry_id) {
    await env.DB.prepare('UPDATE statement_folders SET vault_entry_id = ?, updated_at = ? WHERE id = ?').bind(entry.id, new Date().toISOString(), folder.id).run();
  }
  if (entry.created) {
    meta.vault = {};
    await seedFacts(env, entry.id, [
      { label: 'Card', value: lv?.accountLast ? `MyLowe’s Rewards Credit Card ••${lv.accountLast} (Synchrony)` : null },
      { label: 'Perk', value: '5% off eligible Lowe’s and Lowes.com purchases (taken off at checkout)' },
      { label: 'Customer Service', value: phone || null },
    ]);
  }

  // ---- Flags ----
  const flags: { key: string; severity: 'warn' | 'info'; message: string }[] = [];
  for (const f of files) {
    if (f.status === 'unreadable' || f.status === 'failed') flags.push({ key: `file:${f.file_id}`, severity: 'warn', message: `Couldn’t read “${f.file_name}”: ${f.error ?? 'unknown error'} — re-download it from ${site} (Statements)` });
    if (f.status === 'duplicate') flags.push({ key: `dup:${f.file_id}`, severity: 'info', message: `“${f.file_name}” is a duplicate — ${f.error}` });
  }
  for (const st of stmts) {
    for (const c of st.checks.filter((c) => !c.ok)) {
      flags.push({ key: `check:${st.periodEnd}:${c.name}`, severity: 'warn', message: `${fmtMdy(st.periodEnd)} ${name} statement failed “${c.name}” (${c.detail})` });
    }
  }
  flags.push(...lowesFlags(s, today, name, phone, site));
  flags.push(...cardChargeFlags(name, stmts.map((x) => x.id), txns));

  // ---- Billing → payer flags + payment Quick Facts + Bills ----
  // Payments are "ONLINE PAYMENT THANK YOU" — never AutoPay evidence, so
  // Auto-Pay stays null (Mike's Bills row / payer setting decides).
  const proven = (p: LowesPayment) => p.status === 'checking' || p.status === 'statement' || p.status === 'next_zero';
  const billing = billingFromBills(
    s.statements.map((r) => {
      const owed = Math.max(0, r.newBalance);
      const paid = owed < 0.005 ? true : proven(r.payment) ? true : r.payment.status === 'carried' ? false : null;
      return { date: r.closingDate, amount: owed, totalDue: owed, dueDate: r.dueDate, autopay: null, paid };
    })
  );
  meta.billing = billing;
  meta.rewards = rewardsFromLowesCard(s, today);
  meta.rewardsName = name;
  if (lv) {
    meta.card = {
      last4: lv.accountLast,
      network: template.account.network ?? null,
      creditLine: lv.creditLine,
      purchaseApr: lv.purchaseApr,
      cashLine: null,
      statementRewards: [{ rate: 5, category: 'Lowe’s and Lowes.com (off at checkout)' }],
    };
  }
  flags.push(...(await payerFlags(env, entry.id, name, billing)));
  await syncFlags(env, folder.id, flags);

  // ---- Vault note ----
  meta.vault = meta.vault ?? {};
  const sections: AutoSection[] = [];
  if (latest && lv) {
    sections.push({
      key: 'current',
      match: (h) => /^(Balance|Current Statement|Latest Statement)\b/i.test(h),
      heading: `Latest Statement · ${fmtMdy(latest.closingDate)}`,
      blocks: [
        kv([
          ['Statement Balance', fmtMoney(latest.newBalance)],
          ['Due', latest.dueDate && latest.newBalance > 0.005 ? `${fmtMdy(latest.dueDate)} (minimum ${fmtMoney(latest.minimumPayment)})` : 'Nothing due'],
          ['Payment', lowesPaymentLine(latest.payment, latest.newBalance)],
          ['Credit Limit', s.creditLine !== null ? fmtMoney(s.creditLine) : '—'],
          ['Purchase APR', s.purchaseApr !== null ? `${s.purchaseApr}% (variable) — always pay in full` : '—'],
          ['Last Used', s.lastPurchase ? `${fmtMdy(s.lastPurchase)}${s.monthsSinceUse !== null ? ` (${s.monthsSinceUse} months ago)` : ''}` : '—'],
          ['Statements', 'Only months with purchases are kept in Drive — the payment-only month after each isn’t'],
        ]),
      ],
    });
    sections.push({
      key: 'value',
      match: (h) => /^(Savings|Is It Worth It\??|Value)\b/i.test(h.trim()),
      heading: 'Savings',
      blocks: [
        kv([
          ['Spent All-Time', `${fmtMoney(s.lifetimeNet)} over ${s.purchaseCount} purchases since ${s.firstPurchase ? shortMonth(s.firstPurchase) : '—'}`],
          ['Saved (Estimated)', `≈ ${fmtMoney(s.estSavings)} — 5% off at checkout, not printed on the statement`],
          [`Vs a ${LOWES_COMPARE_RATE * 100}% Card`, `≈ ${fmtMoney(s.vsFlat)} ${s.vsFlat >= 0 ? 'more' : 'less'} than ${LOWES_COMPARE_RATE * 100}% cash back would have paid`],
          ['Fees & Interest', s.totalFees + s.totalInterest > 0.005 ? `${fmtMoney(s.totalFees)} fees · ${fmtMoney(s.totalInterest)} interest` : 'None ever'],
        ]),
      ],
    });
    sections.push({
      key: 'bought',
      match: (h) => /^What (You|I) Bought$/i.test(h.trim()),
      heading: 'What You Bought',
      blocks: [
        table(
          ['Date', 'Amount', 'Where', 'Items'],
          s.items.slice(0, 15).map((it) => [fmtMdy(it.date), fmtMoney(it.amount), it.where, it.items.join(', ') || '—'])
        ),
      ],
    });
    sections.push({
      key: 'statements',
      match: (h) => /^(Recent )?Statements$/i.test(h.trim()),
      heading: 'Statements',
      blocks: [
        table(
          ['Closing', 'Purchases', 'Balance', 'Payment', ''],
          [...s.statements]
            .reverse()
            .slice(0, 12)
            .map((r) => {
              const url = fileUrl(r.fileId);
              return [fmtMdy(r.closingDate), fmtMoney(r.purchases), fmtMoney(r.newBalance), lowesPaymentLine(r.payment, r.newBalance), url ? link('View', url) : ''];
            })
        ),
      ],
    });
  }
  const history: string[] = [];
  for (const c of s.changes) {
    if (c.what === 'terms') history.push(`${fmtMdy(c.date)}: change-in-terms notice${c.to !== 'new terms' ? ` — purchase APR ${c.from} → ${c.to}` : ''}`);
    else if (c.what === 'apr') history.push(`${fmtMdy(c.date)}: purchase APR ${c.from} → ${c.to}`);
    else history.push(`${fmtMdy(c.date)}: credit limit ${c.from} → ${c.to}`);
  }
  if (s.longestIdle && s.longestIdle.months >= 6) history.push(`Longest stretch unused: ${s.longestIdle.months} months (${shortMonth(s.longestIdle.from)} → ${shortMonth(s.longestIdle.to)})`);
  sections.push({
    key: 'history',
    match: (h) => /^Change History$/i.test(h.trim()),
    heading: 'Change History',
    blocks: [history.length ? bullets(history) : para('No changes yet.')],
  });
  const intro = [
    heading(2, 'Account'),
    kv([
      ['Card', `MyLowe’s Rewards Credit Card (formerly Lowe’s Advantage Card) · Synchrony Bank${lv?.accountLast ? ` · ••${lv.accountLast}` : ''}`],
      ['In Drive Since', s.firstStatement ? `${shortMonth(s.firstStatement)} (first statement kept)` : '—'],
      ['Contact', [link('lowes.com/eservice', template.account.site ?? 'https://www.lowes.com/eservice'), ` · ${phone}`]],
    ]),
    para([bold('Dormancy: '), `Synchrony can close a store card left unused; it gets a flag after ${DORMANT_MONTHS} months idle.`]),
  ];
  meta.vault.note = await syncAutoNote(env, entry.id, meta.vault.note, 'Account Details', intro, sections);
  meta.vault.links = await syncManagedLinks(env, entry.id, meta.vault.links, [
    { key: 'site', title: 'Lowe’s · Manage My Card', url: template.account.site ?? null },
    { key: 'dashboard', title: 'Finance Dashboard', url: `${appOrigin(env)}/finance/${folder.id}` },
    { key: 'folder', title: `Drive Folder · ${folder.folder_name}`, url: folder.folder_url },
  ]);
  await env.DB.prepare('UPDATE statement_folders SET meta_json = ? WHERE id = ?').bind(JSON.stringify(meta), folder.id).run();
}
