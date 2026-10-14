import type { Env } from '../types';
import { fmtMdy, fmtMoney, round2 } from './common';
import type { FolderRow } from './engine';
import { appOrigin, easternToday, ensureVaultEntry, seedFacts, syncAutoNote, syncFlags, syncManagedLinks } from './engine';
import type { AutoSection } from './engine';
import { bold, bullets, heading, kv, link, para, table } from './vaultDoc';
import { crossCheckUsaa } from './templates/usaa';
import type { UsaaValues } from './templates/usaa';
import { templateById } from './templates';
import { summarizeUsaa, USAA_CATEGORIES } from './usaaSummary';
import type { UsaaStmtRow, UsaaTxnRow } from './usaaSummary';
import { syncTaxPacketSection } from './taxPacket';

/** USAA checking outputs: Vault entry "USAA Checking" (auto note "Account
 * Details"), flags (unreadable / duplicate files, failed math, a missing
 * month, no new statement, a fee / returned item / negative balance on the
 * latest statement) and a Tax Packet section (interest; 1099-INT only when
 * the year's interest reaches $10). Cash Placement reads it through
 * CASH_SOURCES — it has no savings of its own, so idle cash is compared
 * with Mike's best savings account at another bank. */

interface FolderMeta {
  vault?: { note?: { noteId?: string; written?: string[] }; links?: Record<string, string> };
}

/** Statements close mid-month; flag when the next one is this late. */
const NEW_STATEMENT_GRACE_DAYS = 10;
/** A 1099-INT is issued when a year's interest is at least this. */
const FORM_1099_INT_MIN = 10;

export async function loadUsaaData(env: Env, folderId: string) {
  const [stmtRes, txnRes, fileRes] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM statements WHERE folder_row_id = ? ORDER BY period_end ASC').bind(folderId),
    env.DB.prepare('SELECT txn_date, description, kind, amount FROM statement_transactions WHERE folder_row_id = ? ORDER BY txn_date ASC, position ASC').bind(folderId),
    env.DB.prepare('SELECT * FROM statement_files WHERE folder_row_id = ? ORDER BY file_name ASC').bind(folderId),
  ]);
  const stmts: UsaaStmtRow[] = ((stmtRes.results ?? []) as Record<string, string>[]).map((r) => ({
    id: r.id,
    fileId: r.file_id,
    periodEnd: r.period_end,
    values: JSON.parse(r.values_json) as UsaaValues,
    checks: JSON.parse(r.checks_json),
  }));
  stmts.forEach((s, i) => s.checks.push(...crossCheckUsaa(i ? stmts[i - 1] : null, s)));
  const txns: UsaaTxnRow[] = ((txnRes.results ?? []) as Record<string, unknown>[]).map((r) => ({
    date: r.txn_date as string,
    description: r.description as string,
    kind: r.kind as string,
    amount: r.amount as number,
  }));
  const files = (fileRes.results ?? []) as { file_id: string; file_name: string; web_url: string | null; status: string; error: string | null; statement_id: string | null }[];
  return { stmts, txns, files };
}

const monthName = (ym: string) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortMonth = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
const pct = (n: number | null) => (n === null ? '—' : `${n.toFixed(2)}%`);

export async function deriveUsaa(env: Env, folder: FolderRow): Promise<void> {
  const template = templateById('usaa')!;
  const today = easternToday();
  const { stmts, txns, files } = await loadUsaaData(env, folder.id);
  const s = summarizeUsaa(stmts, txns, today);
  const latest = stmts[stmts.length - 1] ?? null;
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
      { label: 'Checking', value: s.last4 ? `••${s.last4}` : null },
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
      flags.push({ key: `check:${st.periodEnd}:${c.name}`, severity: 'warn', message: `${fmtMdy(st.periodEnd)} USAA statement failed “${c.name}” (${c.detail})` });
    }
  }
  for (const ym of s.gaps) {
    flags.push({ key: `gap:${ym}`, severity: 'warn', message: `No USAA checking statement for ${monthName(ym)} in the Drive folder — download it from usaa.com (Documents → Statements)` });
  }
  if (latest && s.nextExpected && daysBetween(s.nextExpected, today) > NEW_STATEMENT_GRACE_DAYS) {
    flags.push({ key: `missing_after:${latest.periodEnd}`, severity: 'warn', message: `No USAA checking statement in Drive since ${fmtMdy(latest.periodEnd)} — the ${fmtMdy(s.nextExpected)} one should be on usaa.com` });
  }
  if (latest) {
    const from = latest.values.periodStart;
    for (const e of s.events.filter((e) => e.date >= from && e.date <= latest.periodEnd)) {
      if (e.kind === 'fee') flags.push({ key: `fee:${e.date}:${e.amount}`, severity: 'warn', message: `USAA charged a fee on ${fmtMdy(e.date)}: ${e.description} ${fmtMoney(e.amount)}` });
      if (e.kind === 'returned') flags.push({ key: `return:${e.date}:${e.amount}`, severity: 'warn', message: `A payment was returned on ${fmtMdy(e.date)}: ${e.description} ${fmtMoney(e.amount)}` });
      if (e.kind === 'overdrawn') flags.push({ key: `od:${e.date}`, severity: 'warn', message: `USAA checking went negative on ${fmtMdy(e.date)} (low ${fmtMoney(e.amount)}) — check upcoming card payments against the balance` });
    }
  }
  await syncFlags(env, folder.id, flags);

  // ---- Auto note "Account Details" ----
  meta.vault = meta.vault ?? {};
  const sections: AutoSection[] = [];
  const since12 = s.flows.filter((f) => f.date > `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`);
  if (latest) {
    const v = latest.values;
    sections.push({
      key: 'balance',
      match: (h) => /^Balance\b/i.test(h),
      heading: `Balance as of ${fmtMdy(latest.periodEnd)}`,
      blocks: [
        kv([
          [s.label, fmtMoney(v.ending)],
          ['Average Daily Balance', v.avgDailyBalance !== null ? fmtMoney(v.avgDailyBalance) : '—'],
          ['Lowest Day', v.lowBalance !== null ? `${fmtMoney(v.lowBalance)}${v.lowDate ? ` (${fmtMdy(v.lowDate)})` : ''}` : '—'],
          ['APY Earned', pct(s.apy)],
          ['Last Statement', `${fmtMoney(v.credits)} in · ${fmtMoney(v.debits)} out`],
        ]),
        para(`Next statement around ${s.nextExpected ? fmtMdy(s.nextExpected) : '—'}.`),
      ],
    });
    if (since12.length) {
      const totals = new Map<string, number>();
      for (const f of since12) for (const [k, val] of Object.entries(f.byCategory)) totals.set(k, round2((totals.get(k) ?? 0) + (val ?? 0)));
      const rows = USAA_CATEGORIES.filter((c) => totals.has(c) && Math.abs(totals.get(c)!) >= 0.01).map((c) => [c, fmtMoney(totals.get(c)!)]);
      sections.push({
        key: 'flows',
        match: (h) => /^Money In (&|and) Out/i.test(h),
        heading: 'Money In & Out (12 Months)',
        blocks: [table(['Category', 'Net'], rows), para('Transfers are between Mike’s own accounts (USAA savings, Ally, Amex savings, Robinhood, PayPal).')],
      });
    }
    if (s.issuers.length) {
      sections.push({
        key: 'cards',
        match: (h) => /^Card Payments/i.test(h),
        heading: 'Card Payments (12 Months)',
        blocks: [table(['Card', 'Payments', 'Total', 'Last'], s.issuers.map((i) => [i.issuer, String(i.count), fmtMoney(i.total), `${fmtMoney(i.lastAmount)} on ${fmtMdy(i.lastDate)}`]))],
      });
    }
    if (s.recurring.length) {
      sections.push({
        key: 'recurring',
        match: (h) => /^Recurring/i.test(h),
        heading: 'Recurring Payments',
        blocks: [table(['Payee', 'Usual Day', 'Last'], s.recurring.map((r) => [r.payee, String(r.typicalDay), `${fmtMoney(r.lastAmount)} on ${fmtMdy(r.lastDate)}`]))],
      });
    }
    sections.push({
      key: 'interest',
      match: (h) => /^Interest by Year$/i.test(h.trim()),
      heading: 'Interest by Year',
      blocks: [
        table(
          ['Year', 'Interest'],
          [...s.interestYears].reverse().slice(0, 10).map((y) => [`${y.year}${y.december ? '' : ' (partial)'}`, fmtMoney(y.total)])
        ),
        para([bold('Since '), `${s.firstStatement ? shortMonth(s.firstStatement) : '—'}: ${fmtMoney(s.interestLifetime)} interest earned.`]),
      ],
    });
    sections.push({
      key: 'statements',
      match: (h) => /^(Recent )?Statements$/i.test(h.trim()),
      heading: 'Recent Statements',
      blocks: [
        table(
          ['Statement', 'In', 'Out', 'Balance', ''],
          [...stmts]
            .reverse()
            .slice(0, 12)
            .map((st) => {
              const url = fileUrl(st.fileId);
              return [fmtMdy(st.periodEnd), fmtMoney(st.values.credits), fmtMoney(st.values.debits), fmtMoney(st.values.ending), url ? link('View', url) : ''];
            })
        ),
        para(`All ${stmts.length} statements are on the Finance dashboard.`),
      ],
    });
  }
  const history: string[] = [];
  if (s.firstStatement) history.push(`${fmtMdy(s.firstStatement)}: first statement in Drive (${s.label})`);
  let product: string | null = null;
  for (const st of stmts) {
    if (st.values.product && st.values.product !== product) {
      if (product) history.push(`${fmtMdy(st.periodEnd)}: account shown as ${st.values.product} (was ${product})`);
      product = st.values.product;
    }
  }
  const firstModern = stmts.find((x) => x.values.era === 'modern');
  if (firstModern && stmts[0]?.values.era === 'classic') history.push(`${fmtMdy(firstModern.periodEnd)}: statements switched to the current layout`);
  for (const e of s.events) history.push(`${fmtMdy(e.date)}: ${e.kind === 'overdrawn' ? e.description : `${e.description} ${fmtMoney(e.amount)}`}`);
  for (const ym of s.gaps) history.push(`${monthName(ym)}: statement missing from Drive`);
  history.sort((a, b) => Date.parse(a.split(':')[0]) - Date.parse(b.split(':')[0]));
  sections.push({
    key: 'history',
    match: (h) => /^Change History$/i.test(h.trim()),
    heading: 'Change History',
    blocks: [history.length ? bullets(history.slice(-40)) : para('No changes yet.')],
  });
  const intro = [
    heading(2, 'Account'),
    kv([
      ['Bank', template.account.institution],
      ['Account', s.product ? `${s.product} ••${s.last4 ?? ''}` : s.label],
      ['Owner', s.holder ?? '—'],
      ['Contact', template.account.site ? [link('usaa.com', template.account.site), ` · ${template.account.phone ?? ''}`] : template.account.phone ?? '—'],
    ]),
  ];
  meta.vault.note = await syncAutoNote(env, entry.id, meta.vault.note, 'Account Details', intro, sections);
  meta.vault.links = await syncManagedLinks(env, entry.id, meta.vault.links, [
    { key: 'site', title: 'USAA', url: template.account.site ?? null },
    { key: 'dashboard', title: 'Finance Dashboard', url: `${appOrigin(env)}/finance/${folder.id}` },
    { key: 'folder', title: `Drive Folder · ${folder.folder_name}`, url: folder.folder_url },
  ]);
  await env.DB.prepare('UPDATE statement_folders SET meta_json = ? WHERE id = ?').bind(JSON.stringify(meta), folder.id).run();

  // ---- Tax Packet: interest for this year and last ----
  const thisYear = Number(today.slice(0, 4));
  for (const y of s.interestYears.filter((y) => y.year >= thisYear - 1)) {
    const yearStmts = stmts.filter((x) => x.periodEnd.startsWith(String(y.year)));
    const last = yearStmts[yearStmts.length - 1];
    const form = files.find((f) => /1099/.test(f.file_name) && f.file_name.includes(String(y.year)));
    const needsForm = y.total >= FORM_1099_INT_MIN;
    await syncTaxPacketSection(env, y.year, folder.id, {
      title: template.account.nickname,
      blocks: [
        kv([
          [`Interest · ${s.label}`, `${fmtMoney(y.total)} ${y.december ? '(full year)' : `through ${fmtMdy(last.periodEnd)}`}`],
          ['Form 1099-INT', form?.web_url ? link('View in Drive', form.web_url) : needsForm ? `Expected from USAA by January 31, ${y.year + 1}` : 'Not expected (under $10 of interest)'],
        ]),
      ],
      expected: needsForm || form ? [{ label: `USAA 1099-INT ${y.year}`, received: !!form }] : [],
      links: form?.web_url ? [{ key: '1099int', title: `USAA · 1099-INT ${y.year}`, url: form.web_url }] : [],
    });
  }
}

