import type { Env } from '../types';
import { fmtMdy, fmtMoney } from './common';
import type { FolderRow } from './engine';
import { appOrigin, easternToday, ensureVaultEntry, seedFacts, syncAutoNote, syncFlags, syncManagedLinks } from './engine';
import type { AutoSection } from './engine';
import { bold, bullets, heading, kv, link, para, table } from './vaultDoc';
import { crossCheckTargetCard } from './templates/targetCard';
import type { TargetCardValues } from './templates/targetCard';
import { templateById } from './templates';
import { summarizeTargetCard, targetGaps } from './targetCardSummary';
import type { TargetCardStmtRow, TargetCardTxnRow } from './targetCardSummary';
import { addMonths } from './adtSummary';
import { billingFromBills, payerFlags } from '../accountPayers';
import { cardChargeFlags } from './anomalies';
import type { BillingFacts } from '../accountPayers';
import type { CardFacts } from '../cardFacts';
import { rewardsFromTargetCard } from './rewards';
import type { CardRewards } from './rewards';

/** Target RedCard / Circle Card outputs: Vault entry "Target RedCard"
 * (Vault entry standard, docs/statement-templates/README.md), flags
 * (unreadable / duplicate files, failed math, a missing statement — Target
 * only sends one for a month with activity or a balance, so only the month
 * after a balance can be missing — no statement 10 days after the expected
 * closing while a balance is owed, interest / a fee / a carried balance on
 * the latest statement, a payment that missed the due date, an APR or
 * credit-limit change, utilization ≥ 30%, duplicate charges, payer flags),
 * the billing snapshot (Payment Quick Facts + Bills & Due Dates — Auto-Pay is
 * inferred from the full balance being paid on the due date), the card
 * snapshot (Card Quick Facts) and the RedCard savings (Card Rewards — the 5%
 * comes off at the register, so there's never anything to redeem). */

interface FolderMeta {
  vault?: { note?: { noteId?: string; written?: string[] }; links?: Record<string, string> };
  billing?: BillingFacts | null;
  card?: CardFacts;
  rewards?: CardRewards;
  rewardsName?: string;
}

const NEW_STATEMENT_GRACE_DAYS = 10;
const UTILIZATION_WARN_PCT = 30;
const RECENT_GAP_MONTHS = 13;

export async function loadTargetCardData(env: Env, folderId: string) {
  const [stmtRes, txnRes, fileRes] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM statements WHERE folder_row_id = ? ORDER BY period_end ASC').bind(folderId),
    env.DB.prepare('SELECT statement_id, txn_date, description, kind, amount FROM statement_transactions WHERE folder_row_id = ? ORDER BY txn_date ASC, position ASC').bind(folderId),
    env.DB.prepare('SELECT * FROM statement_files WHERE folder_row_id = ? ORDER BY file_name ASC').bind(folderId),
  ]);
  const stmts: TargetCardStmtRow[] = ((stmtRes.results ?? []) as Record<string, string>[]).map((r) => ({
    id: r.id,
    fileId: r.file_id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    values: JSON.parse(r.values_json) as TargetCardValues,
    checks: JSON.parse(r.checks_json),
  }));
  stmts.forEach((s, i) => s.checks.push(...crossCheckTargetCard(i ? stmts[i - 1] : null, s)));
  const txns: TargetCardTxnRow[] = ((txnRes.results ?? []) as Record<string, unknown>[]).map((r) => ({
    statementId: r.statement_id as string,
    date: r.txn_date as string,
    description: r.description as string,
    kind: r.kind as string,
    amount: r.amount as number,
  }));
  const files = (fileRes.results ?? []) as { file_id: string; file_name: string; web_url: string | null; status: string; error: string | null; statement_id: string | null }[];
  return { stmts, txns, files };
}

const shortMonth = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const monthName = (ym: string) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
function monthRuns(months: string[]): string {
  const runs: string[][] = [];
  for (const m of months) {
    const last = runs[runs.length - 1];
    if (last && addMonths(`${last[last.length - 1]}-15`, 1).slice(0, 7) === m) last.push(m);
    else runs.push([m]);
  }
  return runs.map((r) => (r.length === 1 ? shortMonth(`${r[0]}-15`) : `${shortMonth(`${r[0]}-15`)} – ${shortMonth(`${r[r.length - 1]}-15`)}`)).join(', ');
}

export async function deriveTargetCard(env: Env, folder: FolderRow): Promise<void> {
  const template = templateById('targetCard')!;
  const today = easternToday();
  const { stmts, txns, files } = await loadTargetCardData(env, folder.id);
  const s = summarizeTargetCard(stmts, txns, today);
  const latest = s.latest;
  const lv = stmts[stmts.length - 1]?.values ?? null;
  const fileUrl = (fileId: string) => files.find((f) => f.file_id === fileId)?.web_url ?? null;
  const name = template.account.nickname;
  const phone = template.account.phone ?? '';
  const site = 'Target.com/myCircleCard';

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
      { label: 'Card', value: lv?.accountLast ? `${lv.cardName} ••${lv.accountLast}` : null },
      { label: 'Perk', value: '5% off at Target and Target.com (taken off at checkout)' },
      { label: 'Customer Service', value: phone || null },
    ]);
  }

  // ---- Flags ----
  const flags: { key: string; severity: 'warn' | 'info'; message: string }[] = [];
  for (const f of files) {
    if (f.status === 'unreadable' || f.status === 'failed') flags.push({ key: `file:${f.file_id}`, severity: 'warn', message: `Couldn’t read “${f.file_name}”: ${f.error ?? 'unknown error'} — re-download it from ${site} (Statements)` });
    if (f.status === 'duplicate') flags.push({ key: `dup:${f.file_id}`, severity: 'info', message: `“${f.file_name}” is a duplicate — ${f.error}. The statement for its own month may still be missing.` });
  }
  for (const st of stmts) {
    for (const c of st.checks.filter((c) => !c.ok)) {
      flags.push({ key: `check:${st.periodEnd}:${c.name}`, severity: 'warn', message: `${fmtMdy(st.periodEnd)} ${name} statement failed “${c.name}” (${c.detail})` });
    }
  }
  const gaps = targetGaps(stmts, files);
  const recentCut = addMonths(today, -RECENT_GAP_MONTHS).slice(0, 7);
  const oldGaps = gaps.missing.filter((ym) => ym < recentCut);
  for (const ym of gaps.missing.filter((ym) => ym >= recentCut)) {
    flags.push({ key: `gap:${ym}`, severity: 'warn', message: `No ${name} statement for ${monthName(ym)} in the Drive folder (the one before it had a balance) — download it from ${site}` });
  }
  if (oldGaps.length) {
    flags.push({
      key: `gaps_old:${oldGaps.length}:${oldGaps[oldGaps.length - 1]}`,
      severity: 'info',
      message: `${oldGaps.length} older ${name} statement${oldGaps.length === 1 ? ' is' : 's are'} missing from Drive (${monthRuns(oldGaps)}) — each followed a statement with a balance. ${site} keeps about 2 years of statements.`,
    });
  }
  if (latest && s.expectNext && s.nextStatementExpected && daysBetween(s.nextStatementExpected, today) > NEW_STATEMENT_GRACE_DAYS) {
    flags.push({
      key: `missing_after:${latest.closingDate}`,
      severity: 'warn',
      message: `No ${name} statement in Drive since ${fmtMdy(latest.closingDate)} (${fmtMoney(latest.newBalance)} balance) — the one closing around ${fmtMdy(s.nextStatementExpected)} should be on ${site}. Later months only have a statement if you used the card.`,
    });
  }
  if (latest && lv) {
    const when = fmtMdy(latest.closingDate);
    if (latest.interest > 0.005) flags.push({ key: `interest:${latest.closingDate}`, severity: 'warn', message: `Target charged ${fmtMoney(latest.interest)} interest on the ${when} statement — pay the full statement balance to stop it` });
    for (const c of s.charges.filter((c) => c.kind === 'fee' && c.date >= latest.openingDate && c.date <= latest.closingDate)) {
      flags.push({ key: `fee:${c.date}:${c.amount}`, severity: 'warn', message: `Target charged a ${c.description.toLowerCase().replace('latepaymentfee', 'late payment fee')} of ${fmtMoney(c.amount)} on ${fmtMdy(c.date)} — call ${phone} and ask for it to be waived` });
    }
    if (latest.carried > 0.005) {
      flags.push({ key: `carried:${latest.closingDate}`, severity: 'warn', message: `The ${fmtMoney(latest.previousBalance)} balance from the previous statement wasn’t paid in full by ${when} (${fmtMoney(latest.carried)} carried over)` });
    }
    for (const c of s.changes.filter((c) => c.date === latest.closingDate && c.what !== 'renamed')) {
      flags.push({ key: `change:${c.what}:${c.date}`, severity: 'info', message: `${c.what === 'apr' ? 'Purchase APR' : 'Credit limit'} changed from ${c.from} to ${c.to} on the ${when} statement` });
    }
    if (s.utilization !== null && s.utilization >= UTILIZATION_WARN_PCT) {
      flags.push({ key: `utilization:${latest.closingDate}`, severity: 'info', message: `${s.utilization.toFixed(0)}% of the ${fmtMoney(s.creditLine ?? 0)} credit limit was in use at the ${when} closing — over 30% can lower a credit score` });
    }
    if (latest.newBalance < -0.005) {
      flags.push({ key: `credit_balance:${latest.closingDate}`, severity: 'info', message: `A ${fmtMoney(-latest.newBalance)} credit balance is sitting on the card (${when}) — new purchases use it up, or call ${phone} for a refund` });
    }
  }
  flags.push(...cardChargeFlags(name, stmts.map((x) => x.id), txns));

  // ---- Billing → payer flags + payment Quick Facts + Bills ----
  // Target statements never print whether a payment was AutoPay, so Auto-Pay
  // is unknown (null) here — Mike's Bills row / payer setting decides. Paying
  // in full on the due date is NOT taken as AutoPay (Mike, 2026-10-15).
  const billing = billingFromBills(
    s.statements.map((r, i) => {
      const next = s.statements[i + 1];
      const paid = r.newBalance <= 0.005 ? true : next ? next.carried <= 0.005 : null;
      const owed = Math.max(0, r.newBalance);
      return { date: r.closingDate, amount: owed, totalDue: owed, dueDate: r.dueDate, autopay: null, paid };
    })
  );
  meta.billing = billing;
  meta.rewards = rewardsFromTargetCard(s, today);
  meta.rewardsName = name;
  if (lv) {
    meta.card = {
      last4: lv.accountLast,
      network: template.account.network ?? null,
      creditLine: lv.creditLine,
      purchaseApr: lv.purchaseApr,
      cashLine: null,
      statementRewards: [{ rate: 5, category: 'Target and Target.com (off at checkout)' }],
    };
  }
  flags.push(...(await payerFlags(env, entry.id, name, billing)));
  await syncFlags(env, folder.id, flags);

  // ---- Vault note ----
  meta.vault = meta.vault ?? {};
  const sections: AutoSection[] = [];
  if (latest && lv) {
    const payLine =
      s.status === 'credit'
        ? `Credit of ${fmtMoney(-latest.newBalance)} — nothing to pay`
        : !s.nextDue
          ? 'Nothing due'
          : `${fmtMoney(latest.newBalance)} by ${latest.dueDate ? fmtMdy(latest.dueDate) : '—'} (minimum ${fmtMoney(latest.minimumPayment)})`;
    sections.push({
      key: 'current',
      match: (h) => /^(Balance|Current Statement|Latest Statement)\b/i.test(h),
      heading: `Balance as of ${fmtMdy(latest.closingDate)}`,
      blocks: [
        kv([
          ['Statement Balance', fmtMoney(latest.newBalance)],
          ['Payment Due', payLine],
          ['Last Payment', latest.paid > 0.005 ? `${fmtMoney(latest.paid)}${latest.paidInFullOnDue ? ' (paid in full on time)' : latest.paidLate ? ' (after the due date)' : ''}` : 'None this statement'],
          ['Paid in Full', s.paidInFullStreak ? `${s.paidInFullStreak} statement${s.paidInFullStreak === 1 ? '' : 's'} in a row` : 'Not on the latest statement'],
          ['Credit Limit', s.creditLine !== null ? `${fmtMoney(s.creditLine)}${s.utilization !== null ? ` · ${s.utilization.toFixed(1)}% used` : ''}` : '—'],
          ['Purchase APR', s.purchaseApr !== null ? `${s.purchaseApr}% (variable)` : '—'],
          ['Next Statement', s.nextStatementExpected ? (s.expectNext ? `Closes around ${fmtMdy(s.nextStatementExpected)}` : 'Only after you use the card') : '—'],
        ]),
      ],
    });
    sections.push({
      key: 'savings',
      match: (h) => /^(RedCard |Circle Card )?Savings\b/i.test(h),
      heading: 'Savings',
      blocks: [
        kv([
          [`Saved in ${today.slice(0, 4)}`, s.savingsYtdAsOf ? `${fmtMoney(s.savingsYtd)} as of ${fmtMdy(s.savingsYtdAsOf)}` : '$0.00 — no statement yet this year'],
          ['Saved All-Time', `${fmtMoney(s.lifetimeSavings)} since ${s.firstStatement ? shortMonth(s.firstStatement) : '—'}`],
          ['Effective Rate', s.savingsRate !== null ? `${s.savingsRate.toFixed(2)}% on ${fmtMoney(s.lifetimeNet)} of Target spending` : '—'],
        ]),
        para('The 5% comes off at checkout, so there’s nothing to redeem. Each statement prints the savings so far this year; purchases after the year’s last closing (around Dec 20–31) aren’t in any year’s figure.'),
      ],
    });
    sections.push({
      key: 'years',
      match: (h) => /^Spend(ing)? by Year$/i.test(h.trim()),
      heading: 'Spend by Year',
      blocks: [
        table(
          ['Year', 'Purchases', 'Returns', 'Net', 'Saved', 'Rate'],
          [...s.years].reverse().map((y) => [String(y.year), fmtMoney(y.purchases), fmtMoney(y.refunds), fmtMoney(y.net), fmtMoney(y.savings), y.rate !== null ? `${y.rate.toFixed(1)}%` : '—'])
        ),
        para([bold('Since '), `${s.firstStatement ? shortMonth(s.firstStatement) : '—'}: ${fmtMoney(s.lifetimeNet)} net at Target across ${stmts.length} statements (${s.activeMonths} with purchases).`]),
      ],
    });
    sections.push({
      key: 'statements',
      match: (h) => /^(Recent )?Statements$/i.test(h.trim()),
      heading: 'Recent Statements',
      blocks: [
        table(
          ['Closing', 'Balance', 'Paid', 'Purchases', 'Saved', ''],
          [...s.statements]
            .reverse()
            .slice(0, 12)
            .map((r) => {
              const url = fileUrl(r.fileId);
              return [fmtMdy(r.closingDate), fmtMoney(r.newBalance), fmtMoney(r.paid), fmtMoney(r.purchases), r.savings !== null ? fmtMoney(r.savings) : '—', url ? link('View', url) : ''];
            })
        ),
        para(`All ${stmts.length} statements are on the Finance dashboard.`),
      ],
    });
    sections.push({
      key: 'fees',
      match: (h) => /^Fees( & | and )Interest$/i.test(h.trim()),
      heading: 'Fees & Interest',
      blocks: [
        s.charges.length
          ? bullets([...s.charges].reverse().map((c) => `${fmtMdy(c.date)}: ${c.kind === 'fee' && /LATE/i.test(c.description) ? 'late payment fee' : c.description.toLowerCase()}${c.kind === 'credit' ? ' (credit)' : ''} ${fmtMoney(Math.abs(c.amount))}`))
          : para('None — never charged a fee or interest.'),
        para(`All-time: ${fmtMoney(s.totalFees)} in fees, ${fmtMoney(s.totalInterest)} in interest.`),
      ],
    });
  }
  const history: string[] = [];
  const aprMoves = s.changes.filter((c) => c.what === 'apr');
  const firstApr = stmts.find((x) => x.values.purchaseApr !== null)?.values.purchaseApr;
  if (aprMoves.length && firstApr != null) {
    const lastMove = aprMoves[aprMoves.length - 1];
    history.push(`Purchase APR (variable): ${firstApr}% at the first statement → ${s.purchaseApr}% now — ${aprMoves.length} changes, latest ${fmtMdy(lastMove.date)} (${lastMove.from} → ${lastMove.to})`);
  }
  for (const c of s.changes.filter((c) => c.what !== 'apr')) history.push(`${fmtMdy(c.date)}: ${c.what === 'renamed' ? `statements now say ${c.to} (was ${c.from})` : `credit limit ${c.from} → ${c.to}`}`);
  for (const r of s.statements.filter((r) => r.paidLate)) history.push(`${fmtMdy(r.closingDate)} statement: the payment landed after the due date`);
  for (const f of s.lateFees) history.push(`${fmtMdy(f.date)}: late payment fee ${fmtMoney(f.amount)}`);
  if (gaps.missing.length) history.push(`Statements missing from Drive: ${monthRuns(gaps.missing)}`);
  if (gaps.quiet.length) history.push(`No statement issued (card not used, $0 balance): ${monthRuns(gaps.quiet)}`);
  sections.push({
    key: 'history',
    match: (h) => /^Change History$/i.test(h.trim()),
    heading: 'Change History',
    blocks: [history.length ? bullets(history) : para('No changes yet.')],
  });
  const intro = [
    heading(2, 'Account'),
    kv([
      ['Card', `${s.cardName} (formerly Target RedCard) · issued by TD Bank USA${lv?.accountLast ? ` · ••${lv.accountLast}` : ''}`],
      ['Card Since', s.firstStatement ? `${shortMonth(s.firstStatement)} (first statement in Drive)` : '—'],
      ['Contact', template.account.site ? [link('Target.com/myCircleCard', template.account.site), ` · ${phone}`] : phone || '—'],
    ]),
  ];
  meta.vault.note = await syncAutoNote(env, entry.id, meta.vault.note, 'Account Details', intro, sections);
  meta.vault.links = await syncManagedLinks(env, entry.id, meta.vault.links, [
    { key: 'site', title: 'Target · Manage My Circle Card', url: template.account.site ?? null },
    { key: 'dashboard', title: 'Finance Dashboard', url: `${appOrigin(env)}/finance/${folder.id}` },
    { key: 'folder', title: `Drive Folder · ${folder.folder_name}`, url: folder.folder_url },
  ]);
  await env.DB.prepare('UPDATE statement_folders SET meta_json = ? WHERE id = ?').bind(JSON.stringify(meta), folder.id).run();
}
