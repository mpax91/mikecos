import type { Env } from '../types';
import { fmtMdy, fmtMoney } from './common';
import type { FolderRow } from './engine';
import { appOrigin, easternToday, ensureVaultEntry, seedFacts, syncAutoNote, syncFlags, syncManagedLinks } from './engine';
import type { AutoSection } from './engine';
import { bold, bullets, heading, kv, link, para, table } from './vaultDoc';
import { crossCheckBofaCard } from './templates/bofaCard';
import type { BofaCardValues } from './templates/bofaCard';
import { templateById } from './templates';
import { bofaGaps, summarizeBofaCard } from './bofaCardSummary';
import type { BofaCardStmtRow, BofaCardTxnRow } from './bofaCardSummary';
import { addMonths } from './adtSummary';
import { billingFromBills, payerFlags } from '../accountPayers';
import { cardChargeFlags } from './anomalies';
import type { BillingFacts } from '../accountPayers';
import type { CardFacts } from '../cardFacts';
import { rewardsFromBofaCard } from './rewards';
import type { CardRewards } from './rewards';

/** Bank of America Customized Cash Rewards outputs: Vault entry "BofA
 * Customized Cash Rewards" (Vault entry standard,
 * docs/statement-templates/README.md), flags (unreadable / duplicate files,
 * failed math, missing months — quiet no-activity months excluded — no new
 * statement 10 days after the expected closing, interest / a fee / a
 * carried balance on the latest statement, the purchase APR at the penalty
 * rate, an APR or credit-line change, utilization ≥ 30%, duplicate charges
 * and subscription price increases, payer flags), the billing snapshot
 * (Payment Quick Facts + Bills & Due Dates), the card snapshot (Card Quick
 * Facts) and the cash back (Card Rewards + the redeem reminder). */

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

export async function loadBofaCardData(env: Env, folderId: string) {
  const [stmtRes, txnRes, fileRes] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM statements WHERE folder_row_id = ? ORDER BY period_end ASC').bind(folderId),
    env.DB.prepare('SELECT statement_id, txn_date, description, kind, amount FROM statement_transactions WHERE folder_row_id = ? ORDER BY txn_date ASC, position ASC').bind(folderId),
    env.DB.prepare('SELECT * FROM statement_files WHERE folder_row_id = ? ORDER BY file_name ASC').bind(folderId),
  ]);
  const stmts: BofaCardStmtRow[] = ((stmtRes.results ?? []) as Record<string, string>[]).map((r) => ({
    id: r.id,
    fileId: r.file_id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    values: JSON.parse(r.values_json) as BofaCardValues,
    checks: JSON.parse(r.checks_json),
  }));
  stmts.forEach((s, i) => s.checks.push(...crossCheckBofaCard(i ? stmts[i - 1] : null, s)));
  const txns: BofaCardTxnRow[] = ((txnRes.results ?? []) as Record<string, unknown>[]).map((r) => ({
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
/** "2024-11, 2024-12, 2025-01" → "Nov 2024 – Jan 2025"-style runs. */
function monthRuns(months: string[]): string {
  const runs: string[][] = [];
  for (const m of months) {
    const last = runs[runs.length - 1];
    if (last && addMonths(`${last[last.length - 1]}-15`, 1).slice(0, 7) === m) last.push(m);
    else runs.push([m]);
  }
  return runs.map((r) => (r.length === 1 ? shortMonth(`${r[0]}-15`) : `${shortMonth(`${r[0]}-15`)} – ${shortMonth(`${r[r.length - 1]}-15`)}`)).join(', ');
}

export async function deriveBofaCard(env: Env, folder: FolderRow): Promise<void> {
  const template = templateById('bofaCard')!;
  const today = easternToday();
  const { stmts, txns, files } = await loadBofaCardData(env, folder.id);
  const s = summarizeBofaCard(stmts, txns, today);
  const latest = s.latest;
  const lv = stmts[stmts.length - 1]?.values ?? null;
  const fileUrl = (fileId: string) => files.find((f) => f.file_id === fileId)?.web_url ?? null;
  const name = template.account.nickname;
  const phone = template.account.phone ?? '';
  const site = 'bankofamerica.com';

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
      { label: 'Card', value: lv?.accountLast ? `Customized Cash Rewards ••${lv.accountLast}` : null },
      { label: 'Issuer', value: template.account.institution },
      { label: 'Customer Service', value: phone || null },
    ]);
  }

  // ---- Flags ----
  const flags: { key: string; severity: 'warn' | 'info'; message: string }[] = [];
  for (const f of files) {
    if (f.status === 'unreadable' || f.status === 'failed') flags.push({ key: `file:${f.file_id}`, severity: 'warn', message: `Couldn’t read “${f.file_name}”: ${f.error ?? 'unknown error'} — re-download it from ${site} (Statements & Documents)` });
    if (f.status === 'duplicate') flags.push({ key: `dup:${f.file_id}`, severity: 'info', message: `“${f.file_name}” is a duplicate — ${f.error}. The statement for its own month may still be missing.` });
  }
  for (const st of stmts) {
    for (const c of st.checks.filter((c) => !c.ok)) {
      flags.push({ key: `check:${st.periodEnd}:${c.name}`, severity: 'warn', message: `${fmtMdy(st.periodEnd)} ${name} statement failed “${c.name}” (${c.detail})` });
    }
  }
  const gaps = bofaGaps(stmts, files);
  const recentCut = addMonths(today, -RECENT_GAP_MONTHS).slice(0, 7);
  const oldGaps = gaps.missing.filter((ym) => ym < recentCut);
  for (const ym of gaps.missing.filter((ym) => ym >= recentCut)) {
    flags.push({ key: `gap:${ym}`, severity: 'warn', message: `No ${name} statement for ${monthName(ym)} in the Drive folder — download it from ${site} (Statements & Documents)` });
  }
  if (oldGaps.length) {
    flags.push({
      key: `gaps_old:${oldGaps.length}:${oldGaps[oldGaps.length - 1]}`,
      severity: 'info',
      message: `${oldGaps.length} older ${name} statement${oldGaps.length === 1 ? ' is' : 's are'} missing from Drive (${monthRuns(oldGaps)}). Bank of America keeps about 7 years of statements online.`,
    });
  }
  // A $0 balance with no activity means no statement that month — only
  // expect the next one when the latest balance isn't zero.
  const expectNext = !!latest && Math.abs(latest.newBalance) >= 0.005;
  if (latest && expectNext && s.nextStatementExpected && daysBetween(s.nextStatementExpected, today) > NEW_STATEMENT_GRACE_DAYS) {
    flags.push({
      key: `missing_after:${latest.closingDate}`,
      severity: 'warn',
      message: `No ${name} statement in Drive since ${fmtMdy(latest.closingDate)} — the one closing ${fmtMdy(s.nextStatementExpected)} should be on ${site}`,
    });
  }
  if (latest && lv) {
    const when = fmtMdy(latest.closingDate);
    if (latest.interest > 0.005) flags.push({ key: `interest:${latest.closingDate}`, severity: 'warn', message: `Bank of America charged ${fmtMoney(latest.interest)} interest on the ${when} statement — pay the full statement balance to stop it` });
    for (const c of s.charges.filter((c) => c.kind === 'fee' && c.date >= latest.openingDate && c.date <= latest.closingDate)) {
      flags.push({ key: `fee:${c.date}:${c.amount}`, severity: 'warn', message: `Bank of America charged a ${c.description.toLowerCase()} of ${fmtMoney(c.amount)} on ${fmtMdy(c.date)} — call ${phone} and ask for it to be waived` });
    }
    if (latest.carried > 0.005) {
      flags.push({ key: `carried:${latest.closingDate}`, severity: 'warn', message: `The ${fmtMoney(latest.previousBalance)} balance from the previous statement wasn’t paid in full by ${when} (${fmtMoney(latest.carried)} carried over)` });
    }
    if (s.onPenaltyApr) {
      flags.push({ key: `penalty_apr:${latest.closingDate}`, severity: 'warn', message: `Purchases are at the ${s.purchaseApr}% penalty APR — pay on time and call ${phone} to ask for the standard rate back` });
    }
    for (const c of s.changes.filter((c) => c.date === latest.closingDate && c.what !== 'penalty_on')) {
      const what = c.what === 'apr' ? 'Purchase APR' : c.what === 'penalty_off' ? 'Purchase APR (back from the penalty rate)' : c.what === 'credit_line' ? 'Credit limit' : 'Cash credit line';
      flags.push({ key: `change:${c.what}:${c.date}`, severity: 'info', message: `${what} changed from ${c.from} to ${c.to} on the ${when} statement` });
    }
    if (s.utilization !== null && s.utilization >= UTILIZATION_WARN_PCT) {
      flags.push({ key: `utilization:${latest.closingDate}`, severity: 'info', message: `${s.utilization.toFixed(0)}% of the ${fmtMoney(s.creditLine ?? 0)} credit limit was in use at the ${when} closing — over 30% can lower a credit score` });
    }
    if (latest.newBalance < -0.005) {
      flags.push({ key: `credit_balance:${latest.closingDate}`, severity: 'info', message: `A ${fmtMoney(-latest.newBalance)} credit balance is sitting on the card (${when}) — it’s used up by new purchases, or call ${phone} to have it refunded` });
    }
  }

  flags.push(...cardChargeFlags(name, stmts.map((x) => x.id), txns));

  // ---- Billing snapshot → payer flags + payment Quick Facts + Bills ----
  const billing = billingFromBills(
    s.statements.map((r, i) => {
      const next = s.statements[i + 1];
      const paid = r.newBalance <= 0.005 ? true : next ? next.carried <= 0.005 : null;
      // A credit balance is a $0 bill, not a negative one.
      const owed = Math.max(0, r.newBalance);
      return { date: r.closingDate, amount: owed, totalDue: owed, dueDate: r.dueDate, autopay: r.autopay, paid };
    })
  );
  meta.billing = billing;
  meta.rewards = rewardsFromBofaCard(s, today);
  meta.rewardsName = name;
  if (lv) {
    meta.card = {
      last4: lv.accountLast,
      network: s.cardType ?? template.account.network ?? null,
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
        : s.status === 'paid' || !s.nextDue
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
          ['Last Payment', latest.paid > 0.005 ? `${fmtMoney(latest.paid)}${latest.autopay ? ' (AutoPay)' : ''}${latest.carried < 0.005 ? ' — paid in full' : ''}` : 'None this statement'],
          ['Paid in Full', s.paidInFullStreak ? `${s.paidInFullStreak} statement${s.paidInFullStreak === 1 ? '' : 's'} in a row` : 'Not on the latest statement'],
          ['Credit Limit', s.creditLine !== null ? `${fmtMoney(s.creditLine)}${s.availableCredit !== null ? ` · ${fmtMoney(s.availableCredit)} available` : ''}${s.utilization !== null ? ` · ${s.utilization.toFixed(1)}% used` : ''}` : '—'],
          ['Purchase APR', s.purchaseApr !== null ? `${s.purchaseApr}% (variable)${s.onPenaltyApr ? ' — penalty rate' : ''}` : '—'],
          ['Next Statement', s.nextStatementExpected ? (expectNext ? `Closes around ${fmtMdy(s.nextStatementExpected)}` : `Only if there’s activity — closes around ${fmtMdy(s.nextStatementExpected)}`) : '—'],
        ]),
      ],
    });
    if (s.cashBackAvailable !== null) {
      sections.push({
        key: 'rewards',
        match: (h) => /^(Rewards|Cash Back)\b/i.test(h),
        heading: 'Cash Back',
        blocks: [
          kv([
            ['Available', `${fmtMoney(s.cashBackAvailable)}${s.cashBackAsOf ? ` as of ${fmtMdy(s.cashBackAsOf)}` : ''}`],
            [`Earned in ${today.slice(0, 4)}`, fmtMoney(s.ytdCashBackEarned)],
            ['Earned All-Time', `${s.lifetimeBridged > 0.005 ? 'About ' : ''}${fmtMoney(s.lifetimeCashBackEarned)} since ${s.firstStatement ? shortMonth(s.firstStatement) : '—'}`],
            ['Redeemed All-Time', fmtMoney(s.lifetimeCashBackRedeemed)],
            ['Effective Rate (12 Mo)', s.rewardRate !== null ? `${s.rewardRate.toFixed(2)}% back on ${fmtMoney(s.last12Net)} of spending` : '—'],
          ]),
          para('Each statement prints the month’s base cash back, category bonus and Preferred Rewards relationship bonus.'),
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
          [...s.years].reverse().map((y) => [String(y.year), fmtMoney(y.purchases), fmtMoney(y.refunds), fmtMoney(y.net), fmtMoney(y.cashBackEarned), fmtMoney(y.fees + y.interest)])
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
          ? bullets([...s.charges].reverse().map((c) => `${fmtMdy(c.date)}: ${c.kind === 'credit' ? `${c.description.toLowerCase()} (credit)` : c.description.toLowerCase()} ${fmtMoney(Math.abs(c.amount))}`))
          : para('None — never charged a fee or interest.'),
        para(`All-time: ${fmtMoney(s.totalFees)} in fees, ${fmtMoney(s.totalInterest)} in interest.`),
      ],
    });
  }
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
          : `${fmtMdy(c.date)}: ${c.what === 'credit_line' ? 'Credit limit' : 'Cash credit line'} ${c.from} → ${c.to}`
    );
  }
  for (const f of s.lateFees) history.push(`${fmtMdy(f.date)}: late payment fee ${fmtMoney(f.amount)}`);
  for (const y of s.years) {
    if (y.hiddenFees) history.push(`${y.year}: ${fmtMoney(y.hiddenFees)} in fees on a statement missing from Drive (from the year-to-date total)`);
    if (y.hiddenInterest) history.push(`${y.year}: ${fmtMoney(y.hiddenInterest)} in interest on a statement missing from Drive (from the year-to-date total)`);
  }
  if (gaps.missing.length) history.push(`Statements missing from Drive: ${monthRuns(gaps.missing)}`);
  if (gaps.quiet.length) history.push(`No statement issued (no activity, $0 balance): ${monthRuns(gaps.quiet)}`);
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
      ['Card', `Customized Cash Rewards ${s.cardType ?? 'Visa'} (${template.account.institution})${lv?.accountLast ? ` ••${lv.accountLast}` : ''}`],
      ['Card Since', s.firstStatement ? `${shortMonth(s.firstStatement)} (first statement in Drive)` : '—'],
      ['Contact', template.account.site ? [link(template.account.site.replace(/^https?:\/\/(www\.)?/, ''), template.account.site), ` · ${phone}`] : phone || '—'],
    ]),
  ];
  meta.vault.note = await syncAutoNote(env, entry.id, meta.vault.note, 'Account Details', intro, sections);
  meta.vault.links = await syncManagedLinks(env, entry.id, meta.vault.links, [
    { key: 'site', title: 'Bank of America · Credit Card', url: template.account.site ?? null },
    { key: 'dashboard', title: 'Finance Dashboard', url: `${appOrigin(env)}/finance/${folder.id}` },
    { key: 'folder', title: `Drive Folder · ${folder.folder_name}`, url: folder.folder_url },
  ]);
  await env.DB.prepare('UPDATE statement_folders SET meta_json = ? WHERE id = ?').bind(JSON.stringify(meta), folder.id).run();
}
