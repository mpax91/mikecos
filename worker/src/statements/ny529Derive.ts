import type { Env } from '../types';
import { fmtMdy, fmtMoney } from './common';
import type { FolderRow } from './engine';
import { easternToday, ensureVaultEntry, syncFlags, syncManagedFacts, syncReminderTask } from './engine';
import { crossCheckNy529 } from './templates/ny529';
import type { Ny529Values } from './templates/ny529';
import { templateById } from './templates';
import { DEFAULT_NY529_SETTINGS, summarizeNy529 } from './ny529Summary';
import type { Ny529Settings, StmtRow, TxnRow } from './ny529Summary';

/** NY 529 outputs: Vault note "NY 529 · Chase", flags (missed/changed AIP,
 * missing quarterly statement, failed math, unreadable files), the Dec 1
 * top-up reminder, the January limit check, and its Tax Packet lines. */

interface FolderMeta {
  topupTask?: { year: number; taskId: string };
  limitTask?: { year: number; taskId: string };
}

export function ny529Settings(folder: FolderRow): Ny529Settings {
  try {
    return { ...DEFAULT_NY529_SETTINGS, ...(folder.settings_json ? JSON.parse(folder.settings_json) : {}) };
  } catch {
    return DEFAULT_NY529_SETTINGS;
  }
}

export async function loadNy529Data(env: Env, folderId: string) {
  const [stmtRes, txnRes, fileRes] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM statements WHERE folder_row_id = ? ORDER BY period_end ASC').bind(folderId),
    env.DB.prepare('SELECT * FROM statement_transactions WHERE folder_row_id = ? ORDER BY txn_date ASC, position ASC').bind(folderId),
    env.DB.prepare('SELECT * FROM statement_files WHERE folder_row_id = ? ORDER BY file_name ASC').bind(folderId),
  ]);
  const stmts: StmtRow[] = ((stmtRes.results ?? []) as Record<string, string>[]).map((r) => ({
    id: r.id,
    fileId: r.file_id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    values: JSON.parse(r.values_json) as Ny529Values,
    checks: JSON.parse(r.checks_json),
  }));
  // Fold the between-statement checks into each statement's own list.
  stmts.forEach((s, i) => s.checks.push(...crossCheckNy529(i ? stmts[i - 1] : null, s)));
  const txns: TxnRow[] = ((txnRes.results ?? []) as Record<string, unknown>[]).map((r) => ({
    date: r.txn_date as string,
    description: r.description as string,
    kind: r.kind as string,
    amount: r.amount as number,
    units: r.units as number | null,
    unitPrice: r.unit_price as number | null,
  }));
  const files = (fileRes.results ?? []) as {
    file_id: string;
    file_name: string;
    web_url: string | null;
    status: string;
    error: string | null;
    statement_id: string | null;
  }[];
  return { stmts, txns, files };
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (ym: string) => `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

function quarterEndsBetween(fromExclusive: string, toInclusive: string): string[] {
  const ends: string[] = [];
  for (let y = Number(fromExclusive.slice(0, 4)); y <= Number(toInclusive.slice(0, 4)); y++) {
    for (const md of ['03-31', '06-30', '09-30', '12-31']) {
      const d = `${y}-${md}`;
      if (d > fromExclusive && d <= toInclusive) ends.push(d);
    }
  }
  return ends;
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** A quarterly statement counts as missing this many days after quarter end. */
const STATEMENT_GRACE_DAYS = 21;

export async function deriveNy529(env: Env, folder: FolderRow): Promise<void> {
  const template = templateById('ny529')!;
  const settings = ny529Settings(folder);
  const today = easternToday();
  const { stmts, txns, files } = await loadNy529Data(env, folder.id);
  const s = summarizeNy529(stmts, txns, settings, today);
  const latest = stmts[stmts.length - 1];
  const fileUrl = (fileId: string) => files.find((f) => f.file_id === fileId)?.web_url ?? null;

  // ---- Flags ----
  const flags: { key: string; severity: 'warn' | 'info'; message: string }[] = [];
  for (const f of files) {
    if (f.status === 'unreadable' || f.status === 'failed') flags.push({ key: `file:${f.file_id}`, severity: 'warn', message: `Couldn’t read “${f.file_name}”: ${f.error ?? 'unknown error'}` });
    if (f.status === 'duplicate') flags.push({ key: `dup:${f.file_id}`, severity: 'info', message: `“${f.file_name}” is a duplicate — ${f.error}` });
  }
  for (const st of stmts) {
    for (const c of st.checks.filter((c) => !c.ok)) {
      flags.push({ key: `check:${st.periodEnd}:${c.name}`, severity: 'warn', message: `${fmtMdy(st.periodEnd)} statement failed “${c.name}” (${c.detail})` });
    }
  }
  for (const m of s.missedMonths) flags.push({ key: `aip_missed:${m}`, severity: 'warn', message: `No monthly deposit (AIP) found in ${monthLabel(m)}` });
  for (const c of s.aipChanges) flags.push({ key: `aip_changed:${c.date}`, severity: 'info', message: `Monthly deposit changed from ${fmtMoney(c.from)} to ${fmtMoney(c.to)} on ${fmtMdy(c.date)}` });
  if (stmts.length) {
    const lastDue = addDays(today, -STATEMENT_GRACE_DAYS);
    const have = new Set(stmts.map((x) => x.periodEnd));
    for (const q of quarterEndsBetween(stmts[0].periodEnd, lastDue)) {
      if (!have.has(q)) {
        const qn = Math.ceil(Number(q.slice(5, 7)) / 3);
        flags.push({ key: `missing:${q}`, severity: 'warn', message: `Q${qn} ${q.slice(0, 4)} statement (period ending ${fmtMdy(q)}) hasn’t shown up in the 529 folder` });
      }
    }
  }
  const year = Number(today.slice(0, 4));
  const needsLimitConfirm = (settings.limitConfirmedYear ?? 0) < year;
  if (needsLimitConfirm && today.slice(5, 7) <= '03') {
    flags.push({ key: `limit_confirm:${year}`, severity: 'info', message: `Confirm the ${year} NY 529 deduction limit (currently ${fmtMoney(settings.nyLimit)}) in Settings → Statements` });
  }
  await syncFlags(env, folder.id, flags);

  // ---- Vault note (one per account) ----
  const entry = await ensureVaultEntry(env, folder.vault_entry_id, template.account.nickname);
  if (entry.id !== folder.vault_entry_id) {
    await env.DB.prepare('UPDATE statement_folders SET vault_entry_id = ?, updated_at = ? WHERE id = ?').bind(entry.id, new Date().toISOString(), folder.id).run();
  }
  const history: string[] = [];
  for (const c of s.aipChanges) history.push(`${fmtMdy(c.date)}: monthly deposit ${fmtMoney(c.from)} → ${fmtMoney(c.to)}`);
  for (let i = 1; i < stmts.length; i++) {
    const a = stmts[i - 1].values, b = stmts[i].values;
    const pa = a.holdings.map((h) => h.portfolio).join(', '), pb = b.holdings.map((h) => h.portfolio).join(', ');
    if (pa !== pb) history.push(`${fmtMdy(stmts[i].periodEnd)}: portfolio ${pa} → ${pb}`);
    if (a.beneficiary !== b.beneficiary) history.push(`${fmtMdy(stmts[i].periodEnd)}: beneficiary ${a.beneficiary} → ${b.beneficiary}`);
  }
  const v = latest?.values;
  await syncManagedFacts(
    env,
    entry.id,
    [
      { key: 'plan', label: 'Plan', value: template.account.institution },
      { key: 'type', label: 'Account Type', value: v?.accountType ?? template.account.type },
      { key: 'owner', label: 'Account Owner', value: v?.owner ?? null },
      { key: 'beneficiary', label: 'Beneficiary', value: v?.beneficiary ?? null },
      { key: 'account', label: 'Account', value: v ? `••${v.accountLast}` : null },
      { key: 'portfolio', label: 'Portfolio', value: s.portfolio },
      { key: 'value', label: 'Value', value: latest ? fmtMoney(s.value) : null },
      { key: 'contributed', label: 'Contributed', value: latest ? fmtMoney(s.principal) : null },
      { key: 'earnings', label: 'Earnings', value: latest ? fmtMoney(s.earnings) : null },
      { key: 'asof', label: 'Values As Of', value: s.asOf ? fmtMdy(s.asOf) : null },
      { key: 'aip', label: 'Monthly Deposit (AIP)', value: s.aip ? fmtMoney(s.aip.amount) : null },
      { key: 'aip_day', label: 'Deposit Day', value: s.aip ? `Around the ${ordinal(s.aip.day)}` : null },
      { key: 'ytd', label: `${s.year} Contributions`, value: fmtMoney(s.ytdContributions) },
      { key: 'limit', label: `${s.year} NY Deduction Limit`, value: fmtMoney(s.limit) },
      { key: 'projected', label: `${s.year} Projected by Dec 31`, value: fmtMoney(s.projectedYearEnd) },
      { key: 'gap', label: `${s.year} Top-Up Needed`, value: fmtMoney(s.gap) },
      { key: 'site', label: 'Plan Website', value: template.account.site ?? null },
      { key: 'phone', label: 'Plan Phone', value: template.account.phone ?? null },
      { key: 'last_stmt', label: 'Last Statement', value: latest ? fileUrl(latest.fileId) : null },
      { key: 'folder', label: 'Drive Folder', value: folder.folder_url },
      { key: 'history', label: 'Change History', value: history.length ? history.slice(-5).join(' · ') : null },
    ],
    'ny529:'
  );

  // ---- Reminders ----
  let meta: FolderMeta = {};
  try {
    meta = folder.meta_json ? JSON.parse(folder.meta_json) : {};
  } catch {
    meta = {};
  }
  const topup =
    s.gap >= 1 && s.aip // ignore sub-dollar rounding (12 × $833.33 = $9,999.96)
      ? {
          title: `NY 529: Contribute ${fmtMoney(s.gap)} by Dec 31 for the Full ${fmtMoney(s.limit).replace(/\.00$/, '')} NY Deduction`,
          due: `${year}-12-01`,
          parentId: entry.id,
        }
      : null;
  meta.topupTask = await syncReminderTask(env, meta.topupTask, year, topup);
  // January check: created during January only; kept until done, and
  // removed once the limit is confirmed in Settings.
  const limitTask = needsLimitConfirm
    ? { title: `Confirm This Year’s NY 529 Deduction Limit (Currently ${fmtMoney(settings.nyLimit).replace(/\.00$/, '')})`, due: `${year}-01-15`, parentId: entry.id }
    : null;
  if (today.slice(5, 7) === '01' || meta.limitTask?.year === year) meta.limitTask = await syncReminderTask(env, meta.limitTask, year, limitTask);
  await env.DB.prepare('UPDATE statement_folders SET meta_json = ? WHERE id = ?').bind(JSON.stringify(meta), folder.id).run();

  // ---- Tax Packet lines, per tax year with statements ----
  const years = [...new Set(stmts.map((x) => Number(x.periodEnd.slice(0, 4))))];
  for (const y of years) {
    const yearStmts = stmts.filter((x) => x.periodEnd.startsWith(String(y)));
    const last = yearStmts[yearStmts.length - 1];
    const q4 = yearStmts.find((x) => x.periodEnd === `${y}-12-31`);
    const packet = await ensureTaxPacket(env, y);
    await syncManagedFacts(
      env,
      packet,
      [
        { key: 'contrib', label: 'NY 529 Contributions (Chase)', value: fmtMoney(last.values.ytdContributions) },
        { key: 'contrib_asof', label: 'NY 529 Contributions Through', value: fmtMdy(last.periodEnd) },
        { key: 'deductible', label: 'NY 529 Deductible (Max)', value: fmtMoney(Math.min(last.values.ytdContributions, settings.nyLimit)) },
        { key: 'q4', label: 'NY 529 Q4 Statement', value: q4 ? fileUrl(q4.fileId) : `Not in Drive yet — expected early January ${y + 1}` },
      ],
      `ny529:${folder.id}:`
    );
  }
}

async function ensureTaxPacket(env: Env, year: number): Promise<string> {
  const row = await env.DB.prepare('SELECT vault_entry_id FROM statement_tax_packets WHERE year = ?').bind(year).first<{ vault_entry_id: string }>();
  const entry = await ensureVaultEntry(env, row?.vault_entry_id ?? null, `Tax Packet · ${year}`);
  if (entry.id !== row?.vault_entry_id) {
    await env.DB.prepare('INSERT INTO statement_tax_packets (year, vault_entry_id) VALUES (?, ?) ON CONFLICT(year) DO UPDATE SET vault_entry_id = excluded.vault_entry_id').bind(year, entry.id).run();
  }
  return entry.id;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}
