import type { Env } from '../types';
import { fmtMdy, fmtMoney } from './common';
import type { FolderRow } from './engine';
import { appOrigin, easternToday, ensureVaultEntry, seedFacts, syncAutoNote, syncFlags, syncManagedLinks, syncReminderTask } from './engine';
import type { AutoSection } from './engine';
import { bold, bullets, heading, kv, link, para, table } from './vaultDoc';
import { crossCheckAmazon } from './templates/amazon';
import type { AmazonValues } from './templates/amazon';
import { templateById } from './templates';
import { categoryOf, summarizeAmazon } from './amazonSummary';
import type { AmazonStmtRow, AmazonTxnRow } from './amazonSummary';
import { addMonths } from './adtSummary';
import { billingFromBills, loadPayer, payerFlags } from '../accountPayers';
import type { BillingFacts } from '../accountPayers';
import type { CardFacts } from '../cardFacts';

/** Amazon Prime Visa outputs: Vault entry "Amazon Prime Visa" (per the
 * Vault entry standard in docs/statement-templates/README.md), flags
 * (unreadable / duplicate files, failed math, a missing month, no new
 * statement 10 days after the expected closing date, interest or a fee or
 * a carried balance or a past-due amount on the latest statement, an APR
 * or credit-line change, utilization ≥ 30%) and a "Pay Amazon Prime Visa"
 * task with the statement's due date (so it lands on the Calendar) unless
 * the card is paid by AutoPay. */

interface FolderMeta {
  vault?: { note?: { noteId?: string; written?: string[] }; links?: Record<string, string> };
  payTask?: { year: number; taskId: string };
  billing?: BillingFacts | null;
  card?: CardFacts;
}

const NEW_STATEMENT_GRACE_DAYS = 10;
const UTILIZATION_WARN_PCT = 30;

export async function loadAmazonData(env: Env, folderId: string) {
  const [stmtRes, txnRes, fileRes] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM statements WHERE folder_row_id = ? ORDER BY period_end ASC').bind(folderId),
    env.DB.prepare('SELECT statement_id, txn_date, description, kind, amount FROM statement_transactions WHERE folder_row_id = ? ORDER BY txn_date ASC, position ASC').bind(folderId),
    env.DB.prepare('SELECT * FROM statement_files WHERE folder_row_id = ? ORDER BY file_name ASC').bind(folderId),
  ]);
  const stmts: AmazonStmtRow[] = ((stmtRes.results ?? []) as Record<string, string>[]).map((r) => ({
    id: r.id,
    fileId: r.file_id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    values: JSON.parse(r.values_json) as AmazonValues,
    checks: JSON.parse(r.checks_json),
  }));
  stmts.forEach((s, i) => s.checks.push(...crossCheckAmazon(i ? stmts[i - 1] : null, s)));
  const txns: AmazonTxnRow[] = ((txnRes.results ?? []) as Record<string, unknown>[]).map((r) => ({
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
const pts = (n: number) => n.toLocaleString('en-US');
const ptsValue = (n: number) => fmtMoney(n / 100);

/** Months between the first and last statement with neither a statement
 * nor a file dated in them (an unreadable file is flagged on its own). */
function missingMonths(stmts: AmazonStmtRow[], files: { file_name: string }[]): string[] {
  if (stmts.length < 2) return [];
  const have = new Set(stmts.map((s) => s.periodEnd.slice(0, 7)));
  for (const f of files) {
    const m = f.file_name.match(/(\d{4})\.(\d{2})\.\d{2}/);
    if (m) have.add(`${m[1]}-${m[2]}`);
  }
  const out: string[] = [];
  for (let d = addMonths(stmts[0].periodEnd, 1); d < stmts[stmts.length - 1].periodEnd; d = addMonths(d, 1)) {
    if (!have.has(d.slice(0, 7))) out.push(d.slice(0, 7));
  }
  return out;
}

export async function deriveAmazon(env: Env, folder: FolderRow): Promise<void> {
  const template = templateById('amazon')!;
  const today = easternToday();
  const { stmts, txns, files } = await loadAmazonData(env, folder.id);
  const s = summarizeAmazon(stmts, txns, today);
  const latest = s.latest;
  const lv = stmts[stmts.length - 1]?.values ?? null;
  const fileUrl = (fileId: string) => files.find((f) => f.file_id === fileId)?.web_url ?? null;
  const name = template.account.nickname;

  // ---- Vault entry ----
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
      { label: 'Card', value: lv?.accountLast ? `Visa ••${lv.accountLast}` : null },
      { label: 'Issuer', value: template.account.institution },
      { label: 'Customer Service', value: template.account.phone ?? null },
    ]);
  }

  // ---- Flags ----
  const flags: { key: string; severity: 'warn' | 'info'; message: string }[] = [];
  for (const f of files) {
    if (f.status === 'unreadable' || f.status === 'failed') flags.push({ key: `file:${f.file_id}`, severity: 'warn', message: `Couldn’t read “${f.file_name}”: ${f.error ?? 'unknown error'} — re-download it from chase.com` });
    if (f.status === 'duplicate') flags.push({ key: `dup:${f.file_id}`, severity: 'info', message: `“${f.file_name}” is a duplicate — ${f.error}` });
  }
  for (const st of stmts) {
    for (const c of st.checks.filter((c) => !c.ok)) {
      flags.push({ key: `check:${st.periodEnd}:${c.name}`, severity: 'warn', message: `${fmtMdy(st.periodEnd)} ${name} statement failed “${c.name}” (${c.detail})` });
    }
  }
  const gaps = missingMonths(stmts, files);
  for (const ym of gaps) flags.push({ key: `gap:${ym}`, severity: 'warn', message: `No ${name} statement for ${monthName(ym)} in the Drive folder — download it from chase.com (Statements)` });
  if (latest && s.nextStatementExpected && daysBetween(s.nextStatementExpected, today) > NEW_STATEMENT_GRACE_DAYS) {
    flags.push({
      key: `missing_after:${latest.closingDate}`,
      severity: 'warn',
      message: `No ${name} statement in Drive since ${fmtMdy(latest.closingDate)} — the one closing ${fmtMdy(s.nextStatementExpected)} should be on chase.com`,
    });
  }
  if (latest && lv) {
    const when = fmtMdy(latest.closingDate);
    if (latest.interest > 0.005) flags.push({ key: `interest:${latest.closingDate}`, severity: 'warn', message: `Chase charged ${fmtMoney(latest.interest)} interest on the ${when} statement — pay the full statement balance to stop it` });
    for (const c of s.charges.filter((c) => c.kind === 'fee' && c.date >= latest.openingDate && c.date <= latest.closingDate)) {
      flags.push({ key: `fee:${c.date}:${c.amount}`, severity: 'warn', message: `Chase charged a ${c.description.toLowerCase()} of ${fmtMoney(c.amount)} on ${fmtMdy(c.date)} — call ${template.account.phone} and ask for it to be waived` });
    }
    if (latest.carried > 0.005) {
      flags.push({ key: `carried:${latest.closingDate}`, severity: 'warn', message: `The ${fmtMoney(latest.previousBalance)} balance from the previous statement wasn’t paid in full by ${when} (${fmtMoney(latest.carried)} carried over)` });
    }
    if ((lv.pastDue ?? 0) > 0.005) flags.push({ key: `past_due:${latest.closingDate}`, severity: 'warn', message: `The ${when} statement shows ${fmtMoney(lv.pastDue!)} past due` });
    for (const c of s.changes.filter((c) => c.date === latest.closingDate)) {
      const what = c.what === 'apr' ? 'Purchase APR' : c.what === 'credit_line' ? 'Credit line' : c.what === 'cash_line' ? 'Cash access line' : 'Rewards rate';
      flags.push({ key: `change:${c.what}:${c.date}`, severity: 'info', message: `${what} changed from ${c.from} to ${c.to} on the ${when} statement` });
    }
    if (s.utilization !== null && s.utilization >= UTILIZATION_WARN_PCT) {
      flags.push({ key: `utilization:${latest.closingDate}`, severity: 'info', message: `${s.utilization.toFixed(0)}% of the ${fmtMoney(s.creditLine ?? 0)} credit line was in use at the ${when} closing — over 30% can lower a credit score` });
    }
  }

  // ---- Billing snapshot → payer flags + payment Quick Facts ----
  // A card's "bill" is its statement balance. The statement only says
  // AutoPay when a Chase AutoPay payment posts ("AUTOMATIC PAYMENT").
  const billing = billingFromBills(
    s.statements.map((r, i) => ({ date: r.closingDate, amount: r.newBalance, totalDue: r.newBalance, dueDate: r.dueDate, autopay: stmts[i].values.autopay }))
  );
  meta.billing = billing;
  // ---- Card snapshot → card Quick Facts (cardFacts.ts, synced by engine.derive) ----
  if (lv) {
    const earn = (lv.points?.earned ?? [])
      .filter((e) => e.rate !== null && categoryOf(e.label) !== null && categoryOf(e.label) !== 'Bonuses')
      .map((e) => ({ rate: e.rate!, category: categoryOf(e.label)! }));
    meta.card = {
      last4: lv.accountLast,
      network: template.account.network ?? null,
      creditLine: lv.creditLine,
      purchaseApr: lv.apr.purchases,
      cashLine: lv.cashLine,
      statementRewards: earn,
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
        : s.status === 'paid'
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
          ['Last Payment', latest.paid > 0.005 ? `${fmtMoney(latest.paid)}${latest.carried < 0.005 ? ' — paid in full' : ''}` : 'None this statement'],
          ['Paid in Full', s.paidInFullStreak ? `${s.paidInFullStreak} statement${s.paidInFullStreak === 1 ? '' : 's'} in a row` : 'Not on the latest statement'],
          ['Credit Line', s.creditLine !== null ? `${fmtMoney(s.creditLine)}${s.availableCredit !== null ? ` · ${fmtMoney(s.availableCredit)} available` : ''}${s.utilization !== null ? ` · ${s.utilization.toFixed(1)}% used` : ''}` : '—'],
          ['Purchase APR', s.purchaseApr !== null ? `${s.purchaseApr}% (variable)` : '—'],
          ['Next Statement', s.nextStatementExpected ? `Closes around ${fmtMdy(s.nextStatementExpected)}` : '—'],
        ]),
      ],
    });
    if (s.pointsBalance !== null) {
      const cats = s.categories.filter((c) => c.last12 > 0);
      sections.push({
        key: 'rewards',
        match: (h) => /^(Rewards|Points)\b/i.test(h),
        heading: 'Rewards',
        blocks: [
          kv([
            ['Points Available', `${pts(s.pointsBalance)} (${ptsValue(s.pointsBalance)})`],
            [`Earned in ${today.slice(0, 4)}`, `${pts(s.ytdPointsEarned)} (${ptsValue(s.ytdPointsEarned)})`],
            ['Earned All-Time', `${pts(s.lifetimePointsEarned)} (${ptsValue(s.lifetimePointsEarned)}) since ${s.firstStatement ? shortMonth(s.firstStatement) : '—'}`],
            ['Redeemed All-Time', `${pts(s.lifetimePointsRedeemed)}${s.rewardCredits > 0.005 ? ` · ${fmtMoney(s.rewardCredits)} as statement credits` : ''}${s.shopWithPoints > 0.005 ? ` · ${fmtMoney(s.shopWithPoints)} at Amazon checkout` : ''}`],
            ['Effective Rate (12 Mo)', s.rewardRate !== null ? `${s.rewardRate.toFixed(2)}% back on ${fmtMoney(s.last12Net)} of spending` : '—'],
          ]),
          ...(cats.length ? [table(['Category (Last 12 Statements)', 'Points', 'Value'], cats.map((c) => [c.category, pts(c.last12), ptsValue(c.last12)]))] : []),
        ],
      });
    }
    sections.push({
      key: 'years',
      match: (h) => /^Spend(ing)? by Year$/i.test(h.trim()),
      heading: 'Spend by Year',
      blocks: [
        table(
          ['Year', 'Purchases', 'Refunds', 'Net', 'At Amazon', 'Points'],
          [...s.years].reverse().map((y) => [String(y.year), fmtMoney(y.purchases), fmtMoney(y.refunds), fmtMoney(y.net), fmtMoney(y.amazon), pts(y.pointsEarned)])
        ),
        para([bold('Since '), `${s.firstStatement ? shortMonth(s.firstStatement) : '—'}: ${fmtMoney(s.lifetimeNet)} net spending across ${stmts.length} statements.`]),
      ],
    });
    sections.push({
      key: 'statements',
      match: (h) => /^(Recent )?Statements$/i.test(h.trim()),
      heading: 'Recent Statements',
      blocks: [
        table(
          ['Closing', 'Balance', 'Paid', 'Purchases', 'Due', ''],
          [...s.statements]
            .reverse()
            .slice(0, 12)
            .map((r) => {
              const url = fileUrl(r.fileId);
              return [fmtMdy(r.closingDate), fmtMoney(r.newBalance), fmtMoney(r.paid), fmtMoney(r.purchases), r.dueDate ? fmtMdy(r.dueDate) : '—', url ? link('View', url) : ''];
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
          ? bullets(
              [...s.charges].reverse().map((c) => `${fmtMdy(c.date)}: ${c.kind === 'credit' ? 'statement credit' : c.description.toLowerCase()} ${fmtMoney(Math.abs(c.amount))}`)
            )
          : para('None — never charged a fee or interest.'),
        para(`All-time: ${fmtMoney(s.totalFees)} in fees, ${fmtMoney(s.totalInterest)} in interest, ${fmtMoney(s.totalStatementCredits)} in statement credits.`),
      ],
    });
  }
  // The purchase APR is variable (it follows the prime rate), so its many
  // moves are one summary line; every other term change is listed.
  const history: string[] = s.changes
    .filter((c) => c.what !== 'apr')
    .map((c) => `${fmtMdy(c.date)}: ${c.what === 'credit_line' ? 'Credit line' : c.what === 'cash_line' ? 'Cash access line' : 'Rewards'} ${c.from} → ${c.to}`);
  const aprMoves = s.changes.filter((c) => c.what === 'apr');
  const firstApr = stmts.find((x) => x.values.apr.purchases !== null)?.values.apr.purchases;
  if (aprMoves.length && firstApr != null) {
    const lastMove = aprMoves[aprMoves.length - 1];
    history.unshift(`Purchase APR (variable): ${firstApr}% at the first statement → ${s.purchaseApr}% now — ${aprMoves.length} changes, latest ${fmtMdy(lastMove.date)} (${lastMove.from} → ${lastMove.to})`);
  }
  for (const ym of gaps) history.push(`${monthName(ym)}: statement missing from Drive`);
  if (s.carriedStatements.length) history.push(`Statements that carried a balance or charged interest: ${s.carriedStatements.map(shortMonth).join(', ')}`);
  sections.push({
    key: 'history',
    match: (h) => /^Change History$/i.test(h.trim()),
    heading: 'Change History',
    blocks: [history.length ? bullets(history) : para('No changes yet.')],
  });
  const intro = [
    heading(2, 'Account'),
    kv([
      ['Card', `Amazon Prime Visa (${template.account.institution})${lv?.accountLast ? ` ••${lv.accountLast}` : ''}`],
      ['Card Since', s.firstStatement ? `${shortMonth(s.firstStatement)} (first statement in Drive)` : '—'],
      ['Contact', template.account.site ? [link(template.account.site.replace(/^https?:\/\/(www\.)?/, ''), template.account.site), ` · ${template.account.phone ?? ''}`] : template.account.phone ?? '—'],
    ]),
  ];
  meta.vault.note = await syncAutoNote(env, entry.id, meta.vault.note, 'Account Details', intro, sections);
  meta.vault.links = await syncManagedLinks(env, entry.id, meta.vault.links, [
    { key: 'site', title: 'Chase · Amazon Prime Visa', url: template.account.site ?? null },
    { key: 'dashboard', title: 'Finance Dashboard', url: `${appOrigin(env)}/finance/${folder.id}` },
    { key: 'folder', title: `Drive Folder · ${folder.folder_name}`, url: folder.folder_url },
  ]);

  // ---- Reminder: pay the statement balance by its due date ----
  // One task per statement (keyed by its closing month), with the due date
  // so it shows on the Calendar. Skipped when the card is on AutoPay (per
  // the statement or Mike's payer setting). An open task is cleared when
  // the next statement arrives — that statement then shows whether it was
  // paid (and raises the interest / carried-balance flags if not).
  const payer = await loadPayer(env, entry.id);
  const onAutopay = lv?.autopay === true || payer?.mode === 'autopay';
  const key = latest ? Number(latest.closingDate.slice(0, 7).replace('-', '')) : 0;
  // A new task is only made while the due date is still ahead (going live
  // after it passed shouldn't create an overdue chore); one already made
  // stays until the next statement arrives or Mike checks it off.
  const haveTask = meta.payTask?.year === key;
  const due = latest && latest.dueDate && latest.newBalance > 0.005 && !onAutopay && (haveTask || latest.dueDate >= today) ? latest : null;
  if (meta.payTask && meta.payTask.year !== key) {
    await syncReminderTask(env, meta.payTask, meta.payTask.year, null);
    meta.payTask = undefined;
  }
  const want = due ? { title: `Pay ${name} (${fmtMoney(due.newBalance)}) by ${fmtMdy(due.dueDate!)}`, due: due.dueDate!, parentId: entry.id } : null;
  if (want || meta.payTask) meta.payTask = await syncReminderTask(env, meta.payTask, key, want);
  await env.DB.prepare('UPDATE statement_folders SET meta_json = ? WHERE id = ?').bind(JSON.stringify(meta), folder.id).run();
}
