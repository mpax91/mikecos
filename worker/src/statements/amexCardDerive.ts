import type { Env } from '../types';
import { fmtMdy, fmtMoney } from './common';
import type { FolderRow } from './engine';
import { appOrigin, easternToday, ensureVaultEntry, seedFacts, syncAutoNote, syncFlags, syncManagedLinks } from './engine';
import type { AutoSection } from './engine';
import { bold, bullets, heading, kv, link, para, table } from './vaultDoc';
import { crossCheckAmexCard } from './templates/amexCard';
import type { AmexCardValues } from './templates/amexCard';
import { templateById } from './templates';
import { summarizeAmexCard } from './amexCardSummary';
import type { AmexCardStmtRow, AmexCardTxnRow } from './amexCardSummary';
import { addMonths } from './adtSummary';
import { billingFromBills, payerFlags } from '../accountPayers';
import { cardChargeFlags } from './anomalies';
import type { BillingFacts } from '../accountPayers';
import type { CardFacts } from '../cardFacts';
import { rewardsFromAmexCard } from './rewards';
import type { CardRewards } from './rewards';

/** Amex Blue Cash Everyday outputs: Vault entry "Amex Blue Cash Everyday"
 * (Vault entry standard, docs/statement-templates/README.md), flags
 * (unreadable / duplicate files, failed math, missing months, no new
 * statement 10 days after the expected closing, interest / a fee / a
 * carried balance on the latest statement, the purchase APR sitting at the
 * penalty rate, an APR or credit-line change, utilization ≥ 30%, duplicate
 * charges and subscription price increases, payer flags), the billing
 * snapshot (Payment Quick Facts + Bills & Due Dates) and the card snapshot
 * (Card Quick Facts). Pay reminders come from Bills & Due Dates. */

interface FolderMeta {
  vault?: { note?: { noteId?: string; written?: string[] }; links?: Record<string, string> };
  billing?: BillingFacts | null;
  card?: CardFacts;
  rewards?: CardRewards; // → Rewards on Finance + the redeem reminder (engine.derive)
  rewardsName?: string;
}

const NEW_STATEMENT_GRACE_DAYS = 10;
const UTILIZATION_WARN_PCT = 30;
/** Missing months older than this are rolled into one info flag (Amex
 * keeps ~7 years online, but a years-old gap isn't an action item). */
const RECENT_GAP_MONTHS = 13;

export async function loadAmexCardData(env: Env, folderId: string) {
  const [stmtRes, txnRes, fileRes] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM statements WHERE folder_row_id = ? ORDER BY period_end ASC').bind(folderId),
    env.DB.prepare('SELECT statement_id, txn_date, description, kind, amount FROM statement_transactions WHERE folder_row_id = ? ORDER BY txn_date ASC, position ASC').bind(folderId),
    env.DB.prepare('SELECT * FROM statement_files WHERE folder_row_id = ? ORDER BY file_name ASC').bind(folderId),
  ]);
  const stmts: AmexCardStmtRow[] = ((stmtRes.results ?? []) as Record<string, string>[]).map((r) => ({
    id: r.id,
    fileId: r.file_id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    values: JSON.parse(r.values_json) as AmexCardValues,
    checks: JSON.parse(r.checks_json),
  }));
  stmts.forEach((s, i) => s.checks.push(...crossCheckAmexCard(i ? stmts[i - 1] : null, s)));
  const txns: AmexCardTxnRow[] = ((txnRes.results ?? []) as Record<string, unknown>[]).map((r) => ({
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

/** Months between the first and last statement with no statement. A file
 * that couldn't be read is flagged on its own (so its month isn't a gap);
 * a notice letter saved under a statement's name is Skipped and its month
 * IS a gap — the real statement for that month isn't in the folder. */
export function amexMissingMonths(stmts: AmexCardStmtRow[], files: { file_name: string; status: string }[]): string[] {
  if (stmts.length < 2) return [];
  const have = new Set(stmts.map((s) => s.periodEnd.slice(0, 7)));
  for (const f of files) {
    if (f.status === 'skipped') continue;
    const m = f.file_name.match(/(\d{4})\.(\d{2})/);
    if (m) have.add(`${m[1]}-${m[2]}`);
  }
  const out: string[] = [];
  for (let d = addMonths(stmts[0].periodEnd, 1); d < stmts[stmts.length - 1].periodEnd; d = addMonths(d, 1)) {
    if (!have.has(d.slice(0, 7))) out.push(d.slice(0, 7));
  }
  return out;
}

export async function deriveAmexCard(env: Env, folder: FolderRow): Promise<void> {
  const template = templateById('amexCard')!;
  const today = easternToday();
  const { stmts, txns, files } = await loadAmexCardData(env, folder.id);
  const s = summarizeAmexCard(stmts, txns, today);
  const latest = s.latest;
  const lv = stmts[stmts.length - 1]?.values ?? null;
  const fileUrl = (fileId: string) => files.find((f) => f.file_id === fileId)?.web_url ?? null;
  const name = template.account.nickname;
  const phone = template.account.phone ?? '';

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
      { label: 'Card', value: lv?.accountEnding ? `Blue Cash Everyday ••${lv.accountEnding.replace(/\D/g, '').slice(-5)}` : null },
      { label: 'Issuer', value: template.account.institution },
      { label: 'Customer Service', value: phone || null },
    ]);
  }

  // ---- Flags ----
  const flags: { key: string; severity: 'warn' | 'info'; message: string }[] = [];
  for (const f of files) {
    if (f.status === 'unreadable' || f.status === 'failed') flags.push({ key: `file:${f.file_id}`, severity: 'warn', message: `Couldn’t read “${f.file_name}”: ${f.error ?? 'unknown error'} — re-download it from americanexpress.com` });
    if (f.status === 'duplicate') flags.push({ key: `dup:${f.file_id}`, severity: 'info', message: `“${f.file_name}” is a duplicate — ${f.error}` });
  }
  for (const st of stmts) {
    for (const c of st.checks.filter((c) => !c.ok)) {
      flags.push({ key: `check:${st.periodEnd}:${c.name}`, severity: 'warn', message: `${fmtMdy(st.periodEnd)} ${name} statement failed “${c.name}” (${c.detail})` });
    }
  }
  const gaps = amexMissingMonths(stmts, files);
  const recentCut = addMonths(today, -RECENT_GAP_MONTHS).slice(0, 7);
  const oldGaps = gaps.filter((ym) => ym < recentCut);
  for (const ym of gaps.filter((ym) => ym >= recentCut)) {
    flags.push({ key: `gap:${ym}`, severity: 'warn', message: `No ${name} statement for ${monthName(ym)} in the Drive folder — download it from americanexpress.com (Statements & Activity)` });
  }
  if (oldGaps.length) {
    flags.push({
      key: `gaps_old:${oldGaps.length}:${oldGaps[oldGaps.length - 1]}`,
      severity: 'info',
      message: `${oldGaps.length} older ${name} statement${oldGaps.length === 1 ? ' is' : 's are'} missing from Drive (${oldGaps.map((ym) => shortMonth(`${ym}-15`)).join(', ')}) — some months hold an Amex notice letter instead. Amex keeps about 7 years of statements online.`,
    });
  }
  if (latest && s.nextStatementExpected && daysBetween(s.nextStatementExpected, today) > NEW_STATEMENT_GRACE_DAYS) {
    flags.push({
      key: `missing_after:${latest.closingDate}`,
      severity: 'warn',
      message: `No ${name} statement in Drive since ${fmtMdy(latest.closingDate)} — the one closing ${fmtMdy(s.nextStatementExpected)} should be on americanexpress.com`,
    });
  }
  if (latest && lv) {
    const when = fmtMdy(latest.closingDate);
    if (latest.interest > 0.005) flags.push({ key: `interest:${latest.closingDate}`, severity: 'warn', message: `Amex charged ${fmtMoney(latest.interest)} interest on the ${when} statement — pay the full statement balance to stop it` });
    for (const c of s.charges.filter((c) => c.kind === 'fee' && c.date >= latest.openingDate && c.date <= latest.closingDate)) {
      flags.push({ key: `fee:${c.date}:${c.amount}`, severity: 'warn', message: `Amex charged a ${c.description.toLowerCase()} of ${fmtMoney(c.amount)} on ${fmtMdy(c.date)} — call ${phone} and ask for it to be waived` });
    }
    if (latest.carried > 0.005) {
      flags.push({ key: `carried:${latest.closingDate}`, severity: 'warn', message: `The ${fmtMoney(latest.previousBalance)} balance from the previous statement wasn’t paid in full by ${when} (${fmtMoney(latest.carried)} carried over)` });
    }
    if (s.onPenaltyApr) {
      const since = [...s.changes].reverse().find((c) => c.what === 'penalty_on');
      flags.push({
        key: `penalty_apr:${since?.date ?? latest.closingDate}`,
        severity: 'warn',
        message: `Purchases are at the ${s.purchaseApr}% penalty APR${since ? ` (since the ${fmtMdy(since.date)} statement, after a late payment)` : ''} — it only costs money if a balance is carried; pay on time and call ${phone} to ask Amex to restore the standard rate`,
      });
    }
    for (const c of s.changes.filter((c) => c.date === latest.closingDate && c.what !== 'penalty_on')) {
      const what = c.what === 'apr' ? 'Purchase APR' : c.what === 'penalty_off' ? 'Purchase APR (back from the penalty rate)' : c.what === 'credit_line' ? 'Credit limit' : 'Cash advance limit';
      flags.push({ key: `change:${c.what}:${c.date}`, severity: 'info', message: `${what} changed from ${c.from} to ${c.to} on the ${when} statement` });
    }
    if (s.utilization !== null && s.utilization >= UTILIZATION_WARN_PCT) {
      flags.push({ key: `utilization:${latest.closingDate}`, severity: 'info', message: `${s.utilization.toFixed(0)}% of the ${fmtMoney(s.creditLine ?? 0)} credit limit was in use at the ${when} closing — over 30% can lower a credit score` });
    }
  }

  // ---- Duplicate charges, subscription price increases (anomalies.ts) ----
  flags.push(...cardChargeFlags(name, stmts.map((x) => x.id), txns));

  // ---- Billing snapshot → payer flags + payment Quick Facts + Bills ----
  // A card's "bill" is its statement balance; "paid" = the next statement
  // shows it paid off in full.
  const billing = billingFromBills(
    s.statements.map((r, i) => {
      const next = s.statements[i + 1];
      const paid = r.newBalance <= 0.005 ? true : next ? next.carried <= 0.005 : null;
      return { date: r.closingDate, amount: r.newBalance, totalDue: r.newBalance, dueDate: r.dueDate, autopay: stmts[i].values.autopay, paid };
    })
  );
  meta.billing = billing;
  meta.rewards = rewardsFromAmexCard(s, today);
  meta.rewardsName = name;
  // ---- Card snapshot → Card Quick Facts (cardFacts.ts, synced by engine.derive) ----
  // The statement doesn't print earn rates; Rewards comes from the Wallet
  // card's Rewards card.
  if (lv) {
    meta.card = {
      last4: lv.accountLast,
      network: template.account.network ?? null,
      creditLine: lv.creditLine,
      purchaseApr: lv.apr.purchases,
      cashLine: lv.cashLine,
      statementRewards: [],
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
          ['Credit Limit', s.creditLine !== null ? `${fmtMoney(s.creditLine)}${s.availableCredit !== null ? ` · ${fmtMoney(s.availableCredit)} available` : ''}${s.utilization !== null ? ` · ${s.utilization.toFixed(1)}% used` : ''}` : '—'],
          ['Purchase APR', s.purchaseApr !== null ? `${s.purchaseApr}% (variable)${s.onPenaltyApr ? ' — penalty rate' : ''}` : '—'],
          ['Next Statement', s.nextStatementExpected ? `Closes around ${fmtMdy(s.nextStatementExpected)}` : '—'],
        ]),
      ],
    });
    if (s.rewardDollars !== null) {
      sections.push({
        key: 'rewards',
        match: (h) => /^(Rewards|Reward Dollars|Cash Back)\b/i.test(h),
        heading: 'Rewards',
        blocks: [
          kv([
            ['Reward Dollars', `${fmtMoney(s.rewardDollars)}${s.rewardDollarsAsOf ? ` as of ${fmtMdy(s.rewardDollarsAsOf)}` : ''}`],
            [`Earned in ${today.slice(0, 4)}`, fmtMoney(s.ytdRewardsEarned)],
            ['Earned All-Time', `About ${fmtMoney(s.lifetimeRewardsEarned)} since ${s.firstStatement ? shortMonth(s.firstStatement) : '—'}`],
            ['Redeemed All-Time', `${fmtMoney(s.lifetimeRewardsRedeemed)} as statement credits`],
            ['Effective Rate (12 Mo)', s.rewardRate !== null ? `${s.rewardRate.toFixed(2)}% back on ${fmtMoney(s.last12Net)} of spending` : '—'],
          ]),
          para('Amex posts a month’s cash back once its minimum payment is in, so the balance on each statement is as of the previous closing.'),
        ],
      });
    }
    sections.push({
      key: 'years',
      match: (h) => /^Spend(ing)? by Year$/i.test(h.trim()),
      heading: 'Spend by Year',
      blocks: [
        table(
          ['Year', 'Purchases', 'Refunds', 'Net', 'Cash Back', 'Fees & Interest'],
          [...s.years].reverse().map((y) => [String(y.year), fmtMoney(y.purchases), fmtMoney(y.refunds), fmtMoney(y.net), fmtMoney(y.rewardsEarned), fmtMoney(y.fees + y.interest)])
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
          ? bullets([...s.charges].reverse().map((c) => `${fmtMdy(c.date)}: ${c.kind === 'credit' ? 'statement credit' : c.description.toLowerCase()} ${fmtMoney(Math.abs(c.amount))}`))
          : para('None — never charged a fee or interest.'),
        para(`All-time: ${fmtMoney(s.totalFees)} in fees, ${fmtMoney(s.totalInterest)} in interest.`),
      ],
    });
  }
  // The purchase APR is variable (it follows the prime rate), so its many
  // moves are one summary line; penalty-rate periods and limit changes are
  // listed.
  const history: string[] = [];
  const aprMoves = s.changes.filter((c) => c.what === 'apr');
  const firstApr = stmts.find((x) => x.values.apr.purchases !== null)?.values.apr.purchases;
  if (aprMoves.length && firstApr != null) {
    const lastMove = aprMoves[aprMoves.length - 1];
    history.push(`Purchase APR (variable): ${firstApr}% at the first statement → ${s.purchaseApr}% now — ${aprMoves.length} changes, latest ${fmtMdy(lastMove.date)} (${lastMove.from} → ${lastMove.to})`);
  }
  for (const c of s.changes.filter((c) => c.what !== 'apr')) {
    history.push(
      c.what === 'penalty_on'
        ? `${fmtMdy(c.date)}: penalty APR ${c.to} applied (was ${c.from})`
        : c.what === 'penalty_off'
          ? `${fmtMdy(c.date)}: back from the penalty APR — ${c.from} → ${c.to}`
          : `${fmtMdy(c.date)}: ${c.what === 'credit_line' ? 'Credit limit' : 'Cash advance limit'} ${c.from} → ${c.to}`
    );
  }
  for (const f of s.lateFees) history.push(`${fmtMdy(f.date)}: late payment fee ${fmtMoney(f.amount)}`);
  if (gaps.length) history.push(`Statements missing from Drive: ${gaps.map((ym) => shortMonth(`${ym}-15`)).join(', ')}`);
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
      ['Card', `Blue Cash Everyday® (${template.account.institution})${lv?.accountEnding ? ` ••${lv.accountEnding.replace(/\D/g, '').slice(-5)}` : ''}`],
      ['Card Since', s.firstStatement ? `${shortMonth(s.firstStatement)} (first statement in Drive)` : '—'],
      ['Contact', template.account.site ? [link(template.account.site.replace(/^https?:\/\/(www\.)?/, ''), template.account.site), ` · ${phone}`] : phone || '—'],
    ]),
  ];
  meta.vault.note = await syncAutoNote(env, entry.id, meta.vault.note, 'Account Details', intro, sections);
  meta.vault.links = await syncManagedLinks(env, entry.id, meta.vault.links, [
    { key: 'site', title: 'American Express · Blue Cash Everyday', url: template.account.site ?? null },
    { key: 'dashboard', title: 'Finance Dashboard', url: `${appOrigin(env)}/finance/${folder.id}` },
    { key: 'folder', title: `Drive Folder · ${folder.folder_name}`, url: folder.folder_url },
  ]);
  await env.DB.prepare('UPDATE statement_folders SET meta_json = ? WHERE id = ?').bind(JSON.stringify(meta), folder.id).run();
}
