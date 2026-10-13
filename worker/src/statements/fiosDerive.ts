import type { Env } from '../types';
import { fmtMdy, fmtMoney } from './common';
import type { FolderRow } from './engine';
import { appOrigin, easternToday, ensureVaultEntry, seedFacts, syncAutoNote, syncFlags, syncManagedLinks } from './engine';
import type { AutoSection } from './engine';
import { bold, bullets, heading, kv, link, para, table } from './vaultDoc';
import { crossCheckFios } from './templates/fios';
import type { FiosValues } from './templates/fios';
import { templateById } from './templates';
import { summarizeFios } from './fiosSummary';
import { billingFromBills, payerFlags } from '../accountPayers';
import { highBillFlag } from './anomalies';
import type { BillingFacts } from '../accountPayers';
import type { FiosStmtRow, FiosTxnRow } from './fiosSummary';

/** Verizon Fios outputs: Vault entry "Verizon Fios" (Vault entry standard in
 * docs/statement-templates/README.md), flags (unreadable / duplicate files,
 * failed math, past due / late fee on the latest bill, plan or price change
 * on the latest bill, the price guarantee ending within 90 days, no new bill
 * for 45 days, higher-than-usual bill, payer) and the billing snapshot for
 * Bills & Due Dates + payment Quick Facts. */

interface FolderMeta {
  vault?: { note?: { noteId?: string; written?: string[] }; links?: Record<string, string> };
  billing?: BillingFacts | null;
}

const NEW_BILL_GRACE_DAYS = 45;
/** Warn this many days before Verizon's price guarantee runs out. */
export const PRICE_LOCK_WARN_DAYS = 90;

export async function loadFiosData(env: Env, folderId: string) {
  const [stmtRes, txnRes, fileRes] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM statements WHERE folder_row_id = ? ORDER BY period_end ASC').bind(folderId),
    env.DB.prepare('SELECT * FROM statement_transactions WHERE folder_row_id = ? ORDER BY txn_date ASC, position ASC').bind(folderId),
    env.DB.prepare('SELECT * FROM statement_files WHERE folder_row_id = ? ORDER BY file_name ASC').bind(folderId),
  ]);
  const stmts: FiosStmtRow[] = ((stmtRes.results ?? []) as Record<string, string>[]).map((r) => ({
    id: r.id,
    fileId: r.file_id,
    periodEnd: r.period_end,
    values: JSON.parse(r.values_json) as FiosValues,
    checks: JSON.parse(r.checks_json),
  }));
  stmts.forEach((s, i) => s.checks.push(...crossCheckFios(i ? stmts[i - 1] : null, s)));
  const txns: FiosTxnRow[] = ((txnRes.results ?? []) as Record<string, unknown>[]).map((r) => ({
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
export const speedText = (mbps: number | null) => (mbps === null ? '—' : mbps >= 1000 ? `${mbps / 1000} Gig` : `${mbps} Mbps`);

export async function deriveFios(env: Env, folder: FolderRow): Promise<void> {
  const template = templateById('fios')!;
  const name = template.account.nickname;
  const today = easternToday();
  const { stmts, txns, files } = await loadFiosData(env, folder.id);
  const s = summarizeFios(stmts, txns, today);
  const latest = s.latest;
  const latestValues = stmts[stmts.length - 1]?.values;
  const fileUrl = (fileId: string) => files.find((f) => f.file_id === fileId)?.web_url ?? null;

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
      { label: 'Account', value: latestValues?.account || null },
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
      flags.push({ key: `check:${st.periodEnd}:${c.name}`, severity: 'warn', message: `${fmtMdy(st.periodEnd)} Verizon Fios bill failed “${c.name}” (${c.detail})` });
    }
  }
  if (latest && latestValues) {
    if (s.status === 'past_due') {
      flags.push({
        key: `past_due:${latest.billDate}`,
        severity: 'warn',
        message: `The ${fmtMdy(latest.billDate)} Verizon Fios bill shows ${fmtMoney(latest.totalDue)} due including an unpaid ${fmtMoney(latest.previousBalance + latest.payments)} from last month — check Auto Pay in My Verizon`,
      });
    }
    if (latest.lateFee > 0) flags.push({ key: `fee:late:${latest.billDate}`, severity: 'warn', message: `Verizon charged a ${fmtMoney(latest.lateFee)} late fee on the ${fmtMdy(latest.billDate)} Fios bill` });
    const prevPlan = s.planHistory.length > 1 ? s.planHistory[s.planHistory.length - 2] : null;
    const curPlan = s.planHistory[s.planHistory.length - 1];
    if (prevPlan && curPlan && curPlan.from === latest.billDate) {
      flags.push({ key: `plan:${curPlan.from}`, severity: 'info', message: `Fios plan changed from ${prevPlan.plan} to ${curPlan.plan} on the ${fmtMdy(curPlan.from)} bill` });
    }
    const prevPrice = s.priceHistory.length > 1 ? s.priceHistory[s.priceHistory.length - 2] : null;
    const curPrice = s.priceHistory[s.priceHistory.length - 1];
    if (prevPrice && curPrice && curPrice.from === latest.billDate && !(curPlan && curPlan.from === latest.billDate)) {
      flags.push({ key: `rate:${curPrice.from}`, severity: 'info', message: `Fios monthly price changed from ${fmtMoney(prevPrice.amount)} to ${fmtMoney(curPrice.amount)} on the ${fmtMdy(curPrice.from)} bill` });
    }
    if (s.priceGuaranteeUntil) {
      const left = daysBetween(today, s.priceGuaranteeUntil);
      if (left <= PRICE_LOCK_WARN_DAYS && left >= -60) {
        flags.push({
          key: `price_lock:${s.priceGuaranteeUntil}`,
          severity: 'warn',
          message: `Verizon’s price guarantee on ${s.plan ?? 'your Fios plan'} ${left >= 0 ? 'ends' : 'ended'} ${fmtMdy(s.priceGuaranteeUntil)} — call Verizon about a new rate before the price goes up`,
        });
      }
    }
    if (s.autopayDiscount.endedOn && s.autopayDiscount.amount) {
      flags.push({
        key: `autopay_discount:${s.autopayDiscount.endedOn}`,
        severity: 'info',
        message: `The ${fmtMoney(s.autopayDiscount.amount)} Auto-Pay discount stopped on the ${fmtMdy(s.autopayDiscount.endedOn)} Fios bill (about ${fmtMoney(s.autopayDiscount.extraPaid)} more since) — worth asking Verizon to restore it (it needs Auto Pay from a bank account or Verizon Visa)`,
      });
    }
    if (daysBetween(latest.billDate, today) > NEW_BILL_GRACE_DAYS) {
      flags.push({ key: `missing_after:${latest.billDate}`, severity: 'warn', message: `No Verizon Fios bill in the Drive folder since ${fmtMdy(latest.billDate)} — download the latest PDF from My Verizon (Bill → Download)` });
    }
  }
  const high = highBillFlag(name, s.bills.map((b) => ({ date: b.billDate, amount: b.billed })));
  if (high) flags.push(high);
  const billing = billingFromBills(
    s.bills.map((b, i) => {
      const next = s.bills[i + 1];
      const paid = b.totalDue <= 0.005 ? true : next ? next.previousBalance + next.payments <= 0.005 : null;
      return { date: b.billDate, amount: b.billed, totalDue: b.totalDue, dueDate: b.dueDate, autopay: b.autopay, paid };
    })
  );
  meta.billing = billing;
  flags.push(...(await payerFlags(env, entry.id, name, billing)));
  await syncFlags(env, folder.id, flags);

  // ---- Vault note ----
  meta.vault = meta.vault ?? {};
  const sections: AutoSection[] = [];
  if (latest) {
    const payLine =
      s.status === 'credit'
        ? `Credit of ${fmtMoney(-latest.totalDue)} — nothing to pay`
        : s.status === 'paid'
          ? 'Nothing due'
          : latest.autopay
            ? `Auto Pay${latest.autopayDate ? ` on ${fmtMdy(latest.autopayDate)}` : ''}${latest.dueDate ? ` (due ${fmtMdy(latest.dueDate)})` : ''}`
            : `Due${latest.dueDate ? ` ${fmtMdy(latest.dueDate)}` : ''}`;
    sections.push({
      key: 'current',
      match: (h) => /^(Current|Latest) Bill\b/i.test(h),
      heading: `Current Bill as of ${fmtMdy(latest.billDate)}`,
      blocks: [
        kv([
          ['Amount', fmtMoney(latest.totalDue)],
          ['Payment', payLine],
          ['Service Period', periodText(latest.servicePeriodStart, latest.servicePeriodEnd)],
          ['Plan', s.plan ? `${s.plan} (${speedText(s.speedMbps)})` : '—'],
          ['Monthly', s.monthly !== null ? `${fmtMoney(s.monthly)}${s.listPrice !== null && s.listPrice > s.monthly ? ` (list ${fmtMoney(s.listPrice)}, discounts ${fmtMoney(s.listPrice - s.monthly)})` : ''}` : '—'],
          ['Price Guarantee', s.priceGuaranteeUntil ? `Through ${fmtMdy(s.priceGuaranteeUntil)}` : '—'],
          ['Included', s.addOns.length ? s.addOns.join(', ') : '—'],
          ['Next Bill', s.nextBillExpected ? `Around ${fmtMdy(s.nextBillExpected)}` : '—'],
        ]),
      ],
    });
    sections.push({
      key: 'plans',
      match: (h) => /^Plan History$/i.test(h.trim()),
      heading: 'Plan History',
      blocks: [
        table(
          ['From', 'Plan', 'Speed', 'Monthly', 'Bills'],
          [...s.planHistory].reverse().map((p) => [shortMonth(p.from), p.plan, speedText(p.speedMbps), fmtMoney(p.regular), String(p.bills)])
        ),
      ],
    });
    sections.push({
      key: 'years',
      match: (h) => /^Spend by Year$/i.test(h.trim()),
      heading: 'Spend by Year',
      blocks: [
        table(
          ['Year', 'Bills', 'Billed', 'Avg per Bill', 'Discounts'],
          [...s.years].reverse().map((y) => [String(y.year), String(y.bills), fmtMoney(y.billed), y.bills ? fmtMoney(y.billed / y.bills) : '—', fmtMoney(y.discounts)])
        ),
        para([bold('Since '), `${s.firstBill ? shortMonth(s.firstBill) : '—'}: ${fmtMoney(s.lifetimeBilled)} billed across ${s.bills.length} bills, ${fmtMoney(s.lifetimeDiscounts)} in discounts.`]),
      ],
    });
    sections.push({
      key: 'statements',
      match: (h) => /^(Recent )?(Statements|Bills)$/i.test(h.trim()),
      heading: 'Recent Bills',
      blocks: [
        table(
          ['Bill Date', 'Service Period', 'Billed', 'Total Due', ''],
          [...s.bills]
            .reverse()
            .slice(0, 12)
            .map((b) => {
              const url = fileUrl(b.fileId);
              return [fmtMdy(b.billDate), periodText(b.servicePeriodStart, b.servicePeriodEnd), fmtMoney(b.billed), fmtMoney(b.totalDue), url ? link('View', url) : ''];
            })
        ),
        para(`All ${s.bills.length} bills are on the Finance dashboard.`),
      ],
    });
  }
  const history: [string, string][] = [];
  for (let i = 1; i < s.planHistory.length; i++) {
    const a = s.planHistory[i - 1], b = s.planHistory[i];
    history.push([b.from, `${fmtMdy(b.from)}: plan ${a.plan} → ${b.plan} (${fmtMoney(a.regular)} → ${fmtMoney(b.regular)} a month)`]);
  }
  for (let i = 1; i < s.priceHistory.length; i++) {
    const a = s.priceHistory[i - 1], b = s.priceHistory[i];
    if (s.planHistory.some((p) => p.from === b.from)) continue;
    history.push([b.from, `${fmtMdy(b.from)}: monthly ${fmtMoney(a.amount)} → ${fmtMoney(b.amount)}${s.autopayDiscount.endedOn === b.from ? ' (Auto-Pay discount stopped)' : ''}`]);
  }
  for (const d of s.pastDueBills) history.push([d, `${fmtMdy(d)}: bill past due`]);
  for (const b of s.bills.filter((b) => b.lateFee > 0)) history.push([b.billDate, `${fmtMdy(b.billDate)}: ${fmtMoney(b.lateFee)} late fee`]);
  history.sort((a, b) => a[0].localeCompare(b[0]));
  sections.push({
    key: 'history',
    match: (h) => /^Change History$/i.test(h.trim()),
    heading: 'Change History',
    blocks: [history.length ? bullets(history.map((h) => h[1])) : para('No changes yet.')],
  });
  const intro = [
    heading(2, 'Account'),
    kv([
      ['Provider', template.account.institution],
      ['Account', latestValues?.account || '—'],
      ['Customer Since', s.firstBill ? `${shortMonth(s.firstBill)} (first bill in Drive)` : '—'],
      ['Contact', template.account.site ? [link('verizon.com/home', template.account.site), ` · ${template.account.phone ?? ''}`] : template.account.phone ?? '—'],
    ]),
  ];
  meta.vault.note = await syncAutoNote(env, entry.id, meta.vault.note, 'Account Details', intro, sections);
  meta.vault.links = await syncManagedLinks(env, entry.id, meta.vault.links, [
    { key: 'site', title: 'My Verizon (Fios)', url: template.account.site ?? null },
    { key: 'dashboard', title: 'Finance Dashboard', url: `${appOrigin(env)}/finance/${folder.id}` },
    { key: 'folder', title: `Drive Folder · ${folder.folder_name}`, url: folder.folder_url },
  ]);
  await env.DB.prepare('UPDATE statement_folders SET meta_json = ? WHERE id = ?').bind(JSON.stringify(meta), folder.id).run();
}
