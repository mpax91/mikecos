import type { Env } from '../types';
import { fmtMdy, fmtMoney } from './common';
import type { FolderRow } from './engine';
import { appOrigin, easternToday, ensureVaultEntry, seedFacts, syncAutoNote, syncFlags, syncManagedLinks, syncReminderTask } from './engine';
import type { AutoSection } from './engine';
import { bold, bullets, heading, kv, link, para, table } from './vaultDoc';
import { crossCheckAdt } from './templates/adt';
import type { AdtValues } from './templates/adt';
import { templateById } from './templates';
import { summarizeAdt, unpaidCarry } from './adtSummary';
import { billingFromBills, payerFlags } from '../accountPayers';
import { highBillFlag } from './anomalies';
import type { BillingFacts } from '../accountPayers';
import type { AdtStmtRow, AdtTxnRow } from './adtSummary';

/** ADT outputs: Vault entry "ADT Home Security" (per the Vault entry
 * standard in docs/statement-templates/README.md), flags (unreadable /
 * duplicate files, failed math, past-due or carried balance on the latest
 * bill, a rate change on the latest bill, no new bill for 45 days) and a
 * "Pay ADT" task when the latest bill isn't on automatic payment. */

interface FolderMeta {
  vault?: { note?: { noteId?: string; written?: string[] }; links?: Record<string, string> };
  payTask?: { year: number; taskId: string };
  billing?: BillingFacts | null;
}

/** No new bill this many days after the last invoice date → flag. */
const NEW_BILL_GRACE_DAYS = 45;

export async function loadAdtData(env: Env, folderId: string) {
  const [stmtRes, txnRes, fileRes] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM statements WHERE folder_row_id = ? ORDER BY period_end ASC').bind(folderId),
    env.DB.prepare('SELECT * FROM statement_transactions WHERE folder_row_id = ? ORDER BY txn_date ASC, position ASC').bind(folderId),
    env.DB.prepare('SELECT * FROM statement_files WHERE folder_row_id = ? ORDER BY file_name ASC').bind(folderId),
  ]);
  const stmts: AdtStmtRow[] = ((stmtRes.results ?? []) as Record<string, string>[]).map((r) => ({
    id: r.id,
    fileId: r.file_id,
    periodEnd: r.period_end,
    values: JSON.parse(r.values_json) as AdtValues,
    checks: JSON.parse(r.checks_json),
  }));
  stmts.forEach((s, i) => s.checks.push(...crossCheckAdt(i ? stmts[i - 1] : null, s)));
  const txns: AdtTxnRow[] = ((txnRes.results ?? []) as Record<string, unknown>[]).map((r) => ({
    date: r.txn_date as string,
    description: r.description as string,
    kind: r.kind as string,
    amount: r.amount as number,
  }));
  const files = (fileRes.results ?? []) as { file_id: string; file_name: string; web_url: string | null; status: string; error: string | null; statement_id: string | null }[];
  return { stmts, txns, files };
}

const shortMonth = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
const periodText = (a: string | null, b: string | null) => (a && b ? `${fmtMdy(a)} – ${fmtMdy(b)}` : '—');

export async function deriveAdt(env: Env, folder: FolderRow): Promise<void> {
  const template = templateById('adt')!;
  const today = easternToday();
  const { stmts, txns, files } = await loadAdtData(env, folder.id);
  const s = summarizeAdt(stmts, txns, today);
  const latest = s.latest;
  const latestValues = stmts[stmts.length - 1]?.values;
  const fileUrl = (fileId: string) => files.find((f) => f.file_id === fileId)?.web_url ?? null;

  // ---- Vault entry ----
  let meta: FolderMeta = {};
  try {
    meta = folder.meta_json ? JSON.parse(folder.meta_json) : {};
  } catch {
    meta = {};
  }
  const entry = await ensureVaultEntry(env, folder.vault_entry_id, template.account.nickname);
  if (entry.id !== folder.vault_entry_id) {
    await env.DB.prepare('UPDATE statement_folders SET vault_entry_id = ?, updated_at = ? WHERE id = ?').bind(entry.id, new Date().toISOString(), folder.id).run();
  }
  if (entry.created) {
    meta.vault = {};
    await seedFacts(env, entry.id, [
      { label: 'Account', value: latestValues?.accountLast ? `••${latestValues.accountLast}` : null },
      { label: 'Customer Service', value: template.account.phone ?? null },
    ]);
  }

  // ---- Flags ----
  const flags: { key: string; severity: 'warn' | 'info'; message: string }[] = [];
  for (const f of files) {
    if (f.status === 'unreadable' || f.status === 'failed') flags.push({ key: `file:${f.file_id}`, severity: 'warn', message: `Couldn’t read “${f.file_name}”: ${f.error ?? 'unknown error'}` });
    if (f.status === 'duplicate') flags.push({ key: `dup:${f.file_id}`, severity: 'info', message: `“${f.file_name}” is a duplicate — ${f.error}` });
  }
  for (const st of stmts) {
    for (const c of st.checks.filter((c) => !c.ok)) {
      flags.push({ key: `check:${st.periodEnd}:${c.name}`, severity: 'warn', message: `${fmtMdy(st.periodEnd)} ADT bill failed “${c.name}” (${c.detail})` });
    }
  }
  if (latest && latestValues) {
    if (latest.dueNote === 'Past Due' || unpaidCarry(latestValues)) {
      flags.push({
        key: `past_due:${latest.invoiceDate}`,
        severity: 'warn',
        message: `The ${fmtMdy(latest.invoiceDate)} ADT bill shows ${fmtMoney(latest.totalDue)} due including an unpaid ${fmtMoney(latest.previousBalance)} from last month — check the card on file at MyADT.com`,
      });
    }
    const prevRate = s.rateHistory.length > 1 ? s.rateHistory[s.rateHistory.length - 2] : null;
    const cur = s.rateHistory[s.rateHistory.length - 1];
    if (prevRate && cur && cur.from === latest.invoiceDate) {
      const svc = cur.services !== prevRate.services && cur.services ? ` (now ${cur.services})` : '';
      flags.push({ key: `rate:${cur.from}`, severity: 'info', message: `ADT monthly charge changed from ${fmtMoney(prevRate.rate)} to ${fmtMoney(cur.rate)} on the ${fmtMdy(cur.from)} bill${svc}` });
    }
    if (daysBetween(latest.invoiceDate, today) > NEW_BILL_GRACE_DAYS) {
      flags.push({ key: `missing_after:${latest.invoiceDate}`, severity: 'warn', message: `No ADT bill in the Drive folder since ${fmtMdy(latest.invoiceDate)} — download the latest from MyADT.com` });
    }
  }
  // ---- Bill higher than normal (anomalies.ts) ----
  const high = highBillFlag(template.account.nickname, s.bills.map((b) => ({ date: b.invoiceDate, amount: b.billed })));
  if (high) flags.push(high);
  // ---- Billing snapshot → payer flags (account_payers) ----
  const billing = billingFromBills(
    s.bills.map((b) => ({ date: b.invoiceDate, amount: b.billed, totalDue: b.totalDue, dueDate: b.dueDate, autopay: b.autopay }))
  );
  meta.billing = billing;
  flags.push(...(await payerFlags(env, entry.id, template.account.nickname, billing)));
  await syncFlags(env, folder.id, flags);

  meta.vault = meta.vault ?? {};

  const sections: AutoSection[] = [];
  if (latest) {
    const payLine =
      s.status === 'credit'
        ? `Credit of ${fmtMoney(-latest.totalDue)} — nothing to pay`
        : s.status === 'paid'
          ? 'Nothing due'
          : `${latest.autopay ? 'Automatic payment' : 'Due'}${latest.dueDate ? ` ${fmtMdy(latest.dueDate)}` : latest.dueNote ? ` (${latest.dueNote})` : ''}`;
    sections.push({
      key: 'current',
      match: (h) => /^(Current|Latest) Bill\b/i.test(h),
      heading: `Current Bill as of ${fmtMdy(latest.invoiceDate)}`,
      blocks: [
        kv([
          ['Amount', fmtMoney(latest.totalDue)],
          ['Payment', payLine],
          ['Service Period', periodText(latest.servicePeriodStart, latest.servicePeriodEnd)],
          ['Monthly Rate', s.monthlyRate !== null ? `${fmtMoney(s.monthlyRate)} + tax${s.monthlyWithTax !== null ? ` = ${fmtMoney(s.monthlyWithTax)}` : ''} (since ${shortMonth(s.rateSince!)})` : '—'],
          ['Services', latest.services ?? s.rateHistory[s.rateHistory.length - 1]?.services ?? '—'],
          ['Next Bill', s.nextBillExpected ? `Around ${fmtMdy(s.nextBillExpected)}` : '—'],
        ]),
      ],
    });
    sections.push({
      key: 'rates',
      match: (h) => /^(Monthly )?Rate History$/i.test(h.trim()),
      heading: 'Rate History',
      blocks: [
        table(
          ['From', 'Monthly Rate', 'Bills', 'Services'],
          [...s.rateHistory].reverse().map((r) => [shortMonth(r.from), fmtMoney(r.rate), String(r.bills), r.services ?? '—'])
        ),
      ],
    });
    sections.push({
      key: 'years',
      match: (h) => /^Spend by Year$/i.test(h.trim()),
      heading: 'Spend by Year',
      blocks: [
        table(
          ['Year', 'Bills', 'Billed', 'Avg per Bill'],
          [...s.years].reverse().map((y) => [String(y.year), String(y.bills), fmtMoney(y.billed), y.bills ? fmtMoney(y.billed / y.bills) : '—'])
        ),
        para([bold('Since '), `${s.firstInvoice ? shortMonth(s.firstInvoice) : '—'}: ${fmtMoney(s.lifetimeBilled)} billed across ${s.bills.length} bills.`]),
      ],
    });
    sections.push({
      key: 'statements',
      match: (h) => /^(Recent )?(Statements|Bills)$/i.test(h.trim()),
      heading: 'Recent Bills',
      blocks: [
        table(
          ['Invoice', 'Service Period', 'Billed', 'Total Due', ''],
          [...s.bills]
            .reverse()
            .slice(0, 12)
            .map((b) => {
              const url = fileUrl(b.fileId);
              return [fmtMdy(b.invoiceDate), periodText(b.servicePeriodStart, b.servicePeriodEnd), fmtMoney(b.billed), fmtMoney(b.totalDue), url ? link('View', url) : ''];
            })
        ),
        para(`All ${s.bills.length} bills are on the Finance dashboard.`),
      ],
    });
  }
  const history: string[] = [];
  for (let i = 1; i < s.rateHistory.length; i++) {
    const a = s.rateHistory[i - 1], b = s.rateHistory[i];
    history.push(`${fmtMdy(b.from)}: monthly rate ${fmtMoney(a.rate)} → ${fmtMoney(b.rate)}${a.services !== b.services && b.services ? ` (${b.services})` : ''}`);
  }
  if (s.pastDueBills.length) history.push(`Bills with an unpaid balance carried over: ${s.pastDueBills.map(shortMonth).filter((x, i, arr) => arr.indexOf(x) === i).join(', ')}`);
  sections.push({
    key: 'history',
    match: (h) => /^Change History$/i.test(h.trim()),
    heading: 'Change History',
    blocks: [history.length ? bullets(history) : para('No changes yet.')],
  });
  const intro = [
    heading(2, 'Account'),
    kv([
      ['Provider', template.account.institution],
      ['Account', latestValues?.accountLast ? `••${latestValues.accountLast}` : '—'],
      ['Customer Since', s.firstInvoice ? `${shortMonth(s.firstInvoice)} (first bill in Drive)` : '—'],
      ['Contact', template.account.site ? [link(template.account.site.replace(/^https?:\/\/(www\.)?/, ''), template.account.site), ` · ${template.account.phone ?? ''}`] : template.account.phone ?? '—'],
    ]),
  ];
  meta.vault.note = await syncAutoNote(env, entry.id, meta.vault.note, 'Account Details', intro, sections);
  meta.vault.links = await syncManagedLinks(env, entry.id, meta.vault.links, [
    { key: 'site', title: 'MyADT', url: template.account.site ?? null },
    { key: 'dashboard', title: 'Finance Dashboard', url: `${appOrigin(env)}/finance/${folder.id}` },
    { key: 'folder', title: `Drive Folder · ${folder.folder_name}`, url: folder.folder_url },
  ]);

  // ---- Reminder: only when the latest bill isn't on automatic payment ----
  // One task per bill (keyed by its invoice month): kept until Mike checks
  // it off; an open one is cleared when the next bill arrives (that bill
  // then shows any unpaid balance and raises the past-due flag instead).
  const due = latest && latest.dueDate && !latest.autopay && latest.totalDue > 0.005 ? latest : null;
  const key = latest ? Number(latest.invoiceDate.slice(0, 7).replace('-', '')) : 0;
  if (meta.payTask && meta.payTask.year !== key) {
    await syncReminderTask(env, meta.payTask, meta.payTask.year, null);
    meta.payTask = undefined;
  }
  const want = due ? { title: `Pay ADT Bill (${fmtMoney(due.totalDue)}) by ${fmtMdy(due.dueDate!)}`, due: due.dueDate!, parentId: entry.id } : null;
  if (want || meta.payTask) meta.payTask = await syncReminderTask(env, meta.payTask, key, want);
  await env.DB.prepare('UPDATE statement_folders SET meta_json = ? WHERE id = ?').bind(JSON.stringify(meta), folder.id).run();
}
