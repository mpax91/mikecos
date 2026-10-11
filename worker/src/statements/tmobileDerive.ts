import type { Env } from '../types';
import { fmtMdy, fmtMoney } from './common';
import type { FolderRow } from './engine';
import { appOrigin, easternToday, ensureVaultEntry, seedFacts, syncAutoNote, syncFlags, syncManagedLinks } from './engine';
import type { AutoSection } from './engine';
import { bold, bullets, heading, kv, link, para, table } from './vaultDoc';
import { crossCheckTmobile, tmobileLineName } from './templates/tmobile';
import type { TmobileValues } from './templates/tmobile';
import { templateById } from './templates';
import { carriedUnpaid, summarizeTmobile } from './tmobileSummary';
import { billingFromBills, payerFlags } from '../accountPayers';
import { highBillFlag } from './anomalies';
import type { BillingFacts } from '../accountPayers';
import type { TmobileStmtRow, TmobileTxnRow } from './tmobileSummary';

/** T-Mobile outputs: Vault entry "T-Mobile" (per the Vault entry standard in
 * docs/statement-templates/README.md), flags (unreadable / duplicate files,
 * failed math, a past-due balance or late fee on the latest bill, a plan or
 * line change, a phone's last installment coming up, no new bill for 45
 * days, a bill higher than usual, payer flags) and the billing snapshot
 * Bills & Due Dates reads (T-Mobile is on AutoPay → an Auto-Pay marker). */

interface FolderMeta {
  vault?: { note?: { noteId?: string; written?: string[] }; links?: Record<string, string> };
  billing?: BillingFacts | null;
}

const NEW_BILL_GRACE_DAYS = 45;

export async function loadTmobileData(env: Env, folderId: string) {
  const [stmtRes, txnRes, fileRes] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM statements WHERE folder_row_id = ? ORDER BY period_end ASC').bind(folderId),
    env.DB.prepare('SELECT * FROM statement_transactions WHERE folder_row_id = ? ORDER BY txn_date ASC, position ASC').bind(folderId),
    env.DB.prepare('SELECT * FROM statement_files WHERE folder_row_id = ? ORDER BY file_name ASC').bind(folderId),
  ]);
  const stmts: TmobileStmtRow[] = ((stmtRes.results ?? []) as Record<string, string>[]).map((r) => ({
    id: r.id,
    fileId: r.file_id,
    periodEnd: r.period_end,
    values: JSON.parse(r.values_json) as TmobileValues,
    checks: JSON.parse(r.checks_json),
  }));
  stmts.forEach((s, i) => s.checks.push(...crossCheckTmobile(i ? stmts[i - 1] : null, s)));
  const txns: TmobileTxnRow[] = ((txnRes.results ?? []) as Record<string, unknown>[]).map((r) => ({
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
const gb = (n: number | null) => (n === null ? '—' : `${n.toFixed(n >= 10 ? 1 : 2)} GB`);

export async function deriveTmobile(env: Env, folder: FolderRow): Promise<void> {
  const template = templateById('tmobile')!;
  const today = easternToday();
  const { stmts, txns, files } = await loadTmobileData(env, folder.id);
  const s = summarizeTmobile(stmts, txns, today);
  const latest = s.latest;
  const latestValues = stmts[stmts.length - 1]?.values;
  const prevValues = stmts.length > 1 ? stmts[stmts.length - 2].values : null;
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
    const active = s.lines.filter((l) => l.active);
    await seedFacts(env, entry.id, [
      { label: 'Account', value: latestValues?.account || null },
      { label: 'Lines', value: active.length ? active.map((l) => `${l.name} ${l.number}`).join(' · ') : null },
      { label: 'Customer Service', value: `${template.account.phone} · 611 from a T-Mobile phone` },
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
      flags.push({ key: `check:${st.periodEnd}:${c.name}`, severity: 'warn', message: `${fmtMdy(st.periodEnd)} T-Mobile bill failed “${c.name}” (${c.detail})` });
    }
  }
  if (latest && latestValues) {
    if (carriedUnpaid(latestValues)) {
      flags.push({
        key: `past_due:${latest.billDate}`,
        severity: 'warn',
        message: `The ${fmtMdy(latest.billDate)} T-Mobile bill shows ${fmtMoney(latest.totalDue)} due, including ${fmtMoney(latestValues.balance)} unpaid from last month — check the AutoPay card at t-mobile.com`,
      });
    }
    if (latestValues.lateFee) {
      flags.push({ key: `fee:late:${latest.billDate}`, severity: 'warn', message: `T-Mobile charged a ${fmtMoney(latestValues.lateFee)} late fee on the ${fmtMdy(latest.billDate)} bill` });
    }
    if (prevValues) {
      const acct = (v: TmobileValues) => v.accountRow?.plans ?? v.plans;
      if (prevValues.plan !== latestValues.plan || Math.abs(acct(prevValues) - acct(latestValues)) > 0.005) {
        flags.push({
          key: `plan:${latest.billDate}`,
          severity: 'info',
          message: `T-Mobile plan changed on the ${fmtMdy(latest.billDate)} bill: ${prevValues.plan ?? 'plan'} ${fmtMoney(acct(prevValues))} → ${latestValues.plan ?? 'plan'} ${fmtMoney(acct(latestValues))}`,
        });
      }
      for (const l of latestValues.lines) {
        const was = prevValues.lines.find((x) => x.digits === l.digits);
        if (!was) flags.push({ key: `line:${latest.billDate}:${l.digits}`, severity: 'info', message: `New ${l.type ?? ''} line ${l.number} on the ${fmtMdy(latest.billDate)} T-Mobile bill (${fmtMoney(l.total)} this month)`.replace('  ', ' ') });
        else if (/removed/i.test(l.status ?? '') && !/removed/i.test(was.status ?? '')) {
          flags.push({ key: `line:${latest.billDate}:${l.digits}`, severity: 'info', message: `${tmobileLineName(l.number, l.type)} ${l.number} was removed on the ${fmtMdy(latest.billDate)} T-Mobile bill` });
        }
      }
    }
    for (const d of s.devices.filter((x) => x.active && x.installment !== null && x.of !== null && x.of - x.installment <= 1)) {
      const net = Math.max(0, d.monthlyCharge);
      flags.push({
        key: `device_payoff:${d.id}`,
        severity: 'info',
        message: `${d.device}${d.lineName ? ` (${d.lineName})` : ''} has ${d.of! - d.installment! === 0 ? 'its last installment on this bill' : `one installment left (${fmtMoney(d.balance ?? 0)})`} — the T-Mobile bill drops by about ${fmtMoney(net)} after${d.payoffExpected ? ` ${shortMonth(d.payoffExpected)}` : ''}`,
      });
    }
    if (daysBetween(latest.billDate, today) > NEW_BILL_GRACE_DAYS) {
      flags.push({ key: `missing_after:${latest.billDate}`, severity: 'warn', message: `No T-Mobile bill in the Drive folder since ${fmtMdy(latest.billDate)} — download the latest PDF from t-mobile.com (Bill → Download)` });
    }
  }
  const high = highBillFlag(template.account.nickname, s.bills.map((b) => ({ date: b.billDate, amount: b.billed })));
  if (high) flags.push(high);
  // ---- Billing snapshot → Bills & Due Dates + payer flags ----
  const billing = billingFromBills(
    s.bills.map((b, i) => {
      // Paid = the next bill carries nothing unpaid from this one.
      const next = s.bills[i + 1];
      const paid = b.totalDue <= 0.005 ? true : next ? next.balance <= 0.005 : null;
      return { date: b.billDate, amount: b.billed, totalDue: b.totalDue, dueDate: b.dueDate, autopay: b.autopay, paid };
    })
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
          : `${latest.autopay ? `AutoPay${latestValues?.autopayDate ? ` ${fmtMdy(latestValues.autopayDate)}` : ''}${latest.autopayCard ? ` (${latest.autopayCard})` : ''}` : 'Due'}${latest.dueDate ? ` · due ${fmtMdy(latest.dueDate)}` : latest.dueNote ? ` (${latest.dueNote})` : ''}`;
    sections.push({
      key: 'current',
      match: (h) => /^(Current|Latest) Bill\b/i.test(h),
      heading: `Current Bill as of ${fmtMdy(latest.billDate)}`,
      blocks: [
        kv([
          ['Amount', fmtMoney(latest.totalDue)],
          ['Payment', payLine],
          ['Plan', s.plan ? `${s.plan} · ${fmtMoney(latestValues?.accountRow?.plans ?? latest.plans)}/mo for ${latest.lines} line${latest.lines === 1 ? '' : 's'}` : '—'],
          ['Breakdown', `Plans ${fmtMoney(latest.plans)} · Equipment ${fmtMoney(latest.equipment)} · Services ${fmtMoney(latest.services)}${latest.oneTime ? ` · One-Time ${fmtMoney(latest.oneTime)}` : ''}`],
          ['Service Period', periodText(latest.servicePeriodStart, latest.servicePeriodEnd)],
          ['Next Bill', s.nextBillExpected ? `Around ${fmtMdy(s.nextBillExpected)}` : '—'],
        ]),
      ],
    });
    sections.push({
      key: 'lines',
      match: (h) => /^Lines$/i.test(h.trim()),
      heading: 'Lines',
      blocks: [
        table(
          ['Line', 'Number', 'Type', 'Monthly', 'Phone', 'Data (12-Mo Avg)', 'Since'],
          s.lines.map((l) => [
            l.active ? l.name : `${l.name} (ended ${shortMonth(l.lastBill)})`,
            l.number,
            l.type ?? '—',
            l.active ? fmtMoney(l.monthly) : '—',
            l.device ?? '—',
            gb(l.avgDataGb12),
            shortMonth(l.firstBill),
          ])
        ),
        para('Monthly = the line’s own charges + an even share of the account plan charge.'),
      ],
    });
    const devs = s.devices.filter((d) => d.active);
    sections.push({
      key: 'devices',
      match: (h) => /^(Devices|Phones|Device Payments)$/i.test(h.trim()),
      heading: 'Device Payments',
      blocks: [
        devs.length
          ? table(
              ['Device', 'Line', 'Installment', 'Balance Left', 'Monthly', 'Paid Off'],
              devs.map((d) => [
                d.device,
                d.lineName ?? '—',
                d.installment !== null ? `${d.installment} of ${d.of}` : '—',
                d.balance !== null ? fmtMoney(d.balance) : '—',
                `${fmtMoney(d.monthlyCharge)}${d.monthlyCredit ? ` (after ${fmtMoney(-d.monthlyCredit)} promo)` : ''}`,
                d.payoffExpected ? shortMonth(d.payoffExpected) : '—',
              ])
            )
          : para('No phones on installment plans.'),
      ],
    });
    sections.push({
      key: 'years',
      match: (h) => /^Spend by Year$/i.test(h.trim()),
      heading: 'Spend by Year',
      blocks: [
        table(
          ['Year', 'Bills', 'Billed', 'Avg per Bill', 'Plans', 'Equipment'],
          [...s.years].reverse().map((y) => [String(y.year), String(y.bills), fmtMoney(y.billed), y.bills ? fmtMoney(y.billed / y.bills) : '—', fmtMoney(y.plans), fmtMoney(y.equipment)])
        ),
        para([bold('Since '), `${s.firstBill ? shortMonth(s.firstBill) : '—'}: ${fmtMoney(s.lifetimeBilled)} billed across ${s.bills.length} bills (${fmtMoney(s.lifetimeEquipment)} of it for phones).`]),
      ],
    });
    sections.push({
      key: 'statements',
      match: (h) => /^(Recent )?(Statements|Bills)$/i.test(h.trim()),
      heading: 'Recent Bills',
      blocks: [
        table(
          ['Bill Date', 'Billed', 'Total Due', 'Data', ''],
          [...s.bills]
            .reverse()
            .slice(0, 12)
            .map((b) => {
              const url = fileUrl(b.fileId);
              return [fmtMdy(b.billDate), fmtMoney(b.billed), fmtMoney(b.totalDue), gb(b.dataGb), url ? link('View', url) : ''];
            })
        ),
        para(`All ${s.bills.length} bills are on the Finance dashboard.`),
      ],
    });
  }
  const history: string[] = [];
  for (let i = 1; i < s.planHistory.length; i++) {
    const a = s.planHistory[i - 1], b = s.planHistory[i];
    history.push(`${fmtMdy(b.from)}: ${b.plan ?? 'plan'} — Plans ${fmtMoney(a.plans)} → ${fmtMoney(b.plans)}, ${b.lines} line${b.lines === 1 ? '' : 's'}`);
  }
  for (const d of [...s.devices].sort((x, y) => x.firstBill.localeCompare(y.firstBill))) {
    history.push(`${fmtMdy(d.firstBill)}: ${d.device}${d.lineName ? ` (${d.lineName})` : ''} on a ${d.of ?? '?'}-month installment plan${d.paidOff ? ` — done ${shortMonth(d.lastBill)}` : ''}`);
  }
  if (s.pastDueBills.length) history.push(`Bills with an unpaid balance carried over: ${s.pastDueBills.map(shortMonth).join(', ')}`);
  for (const f of s.lateFees) history.push(`${fmtMdy(f.date)}: ${fmtMoney(f.amount)} late fee`);
  history.sort();
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
      ['Account', latestValues?.account || '—'],
      ['Customer Since', s.firstBill ? `${shortMonth(s.firstBill)} (first bill in Drive)` : '—'],
      ['Contact', template.account.site ? [link('t-mobile.com', template.account.site), ` · ${template.account.phone ?? ''} · 611`] : template.account.phone ?? '—'],
    ]),
  ];
  meta.vault.note = await syncAutoNote(env, entry.id, meta.vault.note, 'Account Details', intro, sections);
  meta.vault.links = await syncManagedLinks(env, entry.id, meta.vault.links, [
    { key: 'site', title: 'T-Mobile Account', url: 'https://account.t-mobile.com' },
    { key: 'dashboard', title: 'Finance Dashboard', url: `${appOrigin(env)}/finance/${folder.id}` },
    { key: 'folder', title: `Drive Folder · ${folder.folder_name}`, url: folder.folder_url },
  ]);
  await env.DB.prepare('UPDATE statement_folders SET meta_json = ? WHERE id = ?').bind(JSON.stringify(meta), folder.id).run();
}
