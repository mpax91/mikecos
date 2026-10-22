import type { Env } from '../types';
import { fmtMdy, fmtMoney } from './common';
import type { FolderRow } from './engine';
import { appOrigin, easternToday, ensureVaultEntry, seedFacts, syncAutoNote, syncFlags, syncManagedLinks } from './engine';
import type { AutoSection } from './engine';
import { bold, bullets, kv, link, para, table } from './vaultDoc';
import type { TspValues } from './templates/tsp';
import { templateById } from './templates';
import { summarizeTsp } from './tspSummary';
import type { TspContext, TspStmtRow, TspTxnRow } from './tspSummary';

/** Thrift Savings Plan outputs: Vault entry "Thrift Savings Plan" (auto note
 * "Account & Performance"), flags. No Tax Packet lines — nothing is
 * withdrawn, so no 1099-R. Analysis lives in tspSummary.ts. */

interface FolderMeta {
  vault?: { note?: { noteId?: string; written?: string[] }; links?: Record<string, string> };
}

/** Quarterly statements post ~a week after the quarter; the Q4/annual one in late January–February. */
const NEW_STATEMENT_GRACE_DAYS = 135;

export async function loadTspData(env: Env, folderId: string) {
  const [stmtRes, txnRes, fileRes] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM statements WHERE folder_row_id = ? ORDER BY period_end ASC').bind(folderId),
    env.DB.prepare('SELECT txn_date, description, kind, amount, units, account FROM statement_transactions WHERE folder_row_id = ? ORDER BY txn_date ASC, position ASC').bind(folderId),
    env.DB.prepare('SELECT * FROM statement_files WHERE folder_row_id = ? ORDER BY file_name ASC').bind(folderId),
  ]);
  const stmts: TspStmtRow[] = ((stmtRes.results ?? []) as Record<string, string>[]).map((r) => ({
    id: r.id,
    fileId: r.file_id,
    periodEnd: r.period_end,
    date: r.period_end.slice(0, 10),
    start: (r.period_start ?? r.period_end).slice(0, 10),
    values: JSON.parse(r.values_json) as TspValues,
    checks: JSON.parse(r.checks_json),
  }));
  const txns: TspTxnRow[] = ((txnRes.results ?? []) as Record<string, unknown>[]).map((r) => ({
    date: r.txn_date as string,
    description: r.description as string,
    kind: r.kind as string,
    amount: r.amount as number,
    units: (r.units as number | null) ?? null,
    account: (r.account as string | null) ?? null,
  }));
  const files = (fileRes.results ?? []) as { file_id: string; file_name: string; web_url: string | null; status: string; error: string | null; statement_id: string | null }[];
  return { stmts, txns, files };
}

/** Mike's birth date (Social Security statements) and the retirement age set
 * on Merrill's Retirement tab (else 60). Missing pieces stay null/default. */
export async function tspContext(env: Env, today: string): Promise<TspContext> {
  let birthDate: string | null = null;
  let retireAge = 60;
  try {
    const row = await env.DB.prepare('SELECT data_json FROM ssa_statements ORDER BY statement_date DESC LIMIT 1').first<{ data_json: string }>();
    if (row) birthDate = (JSON.parse(row.data_json) as { birth_date?: string | null }).birth_date ?? null;
  } catch {
    /* Social Security page not set up */
  }
  try {
    const row = await env.DB.prepare(`SELECT settings_json FROM statement_folders WHERE template_id = 'merrill' AND status = 'live' LIMIT 1`).first<{ settings_json: string | null }>();
    const age = row?.settings_json ? Number(JSON.parse(row.settings_json).retireAge) : NaN;
    if (Number.isFinite(age) && age >= 40 && age <= 80) retireAge = Math.round(age);
  } catch {
    /* Merrill not live */
  }
  return { today, birthDate, retireAge, advisoryRate: null };
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
const pctTxt = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${x.toFixed(1)}%`);

export async function deriveTsp(env: Env, folder: FolderRow): Promise<void> {
  const template = templateById('tsp')!;
  const today = easternToday();
  const { stmts, txns, files } = await loadTspData(env, folder.id);
  const s = summarizeTsp(stmts, txns, await tspContext(env, today));
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
      { label: 'Plan', value: 'Thrift Savings Plan (Uniformed Services) · Traditional' },
      { label: 'ThriftLine', value: template.account.phone ?? null },
    ]);
  }

  // ---- Flags ----
  const flags: { key: string; severity: 'warn' | 'info'; message: string }[] = [];
  for (const f of files) {
    if (f.status === 'unreadable' || f.status === 'failed') flags.push({ key: `file:${f.file_id}`, severity: 'warn', message: `Couldn’t read “${f.file_name}”: ${f.error ?? 'unknown error'}` });
    if (f.status === 'duplicate') flags.push({ key: `dup:${f.file_id}`, severity: 'info', message: `“${f.file_name}” is a duplicate — ${f.error}` });
  }
  for (const st of stmts) {
    for (const c of st.checks.filter((c) => !c.ok)) flags.push({ key: `check:${st.periodEnd}:${c.name}`, severity: 'warn', message: `${fmtMdy(st.date)} TSP statement failed “${c.name}” (${c.detail})` });
  }
  if (s.asOf && daysBetween(s.asOf, today) > NEW_STATEMENT_GRACE_DAYS) {
    flags.push({ key: `missing_after:${s.asOf}`, severity: 'warn', message: `No TSP statement in Drive since ${fmtMdy(s.asOf)} — download the latest from My Account at tsp.gov` });
  }
  if (s.beneficiary === false) {
    flags.push({ key: 'beneficiary:none', severity: 'warn', message: 'No TSP beneficiary on file — without one it’s paid by the legal order (spouse first). Designate online at tsp.gov if you want someone else named.' });
  }
  const oldGaps = s.missingQuarters.filter((d) => daysBetween(d, today) > 400);
  if (oldGaps.length) flags.push({ key: `gaps_old:${oldGaps.length}`, severity: 'info', message: `${oldGaps.length} older quarter${oldGaps.length > 1 ? 's' : ''} not covered by a statement in Drive (${oldGaps.join(', ')})` });
  for (const d of s.missingQuarters.filter((x) => daysBetween(x, today) <= 400)) flags.push({ key: `gap:${d.slice(0, 7)}`, severity: 'info', message: `No TSP statement in Drive covers the quarter ending ${fmtMdy(d)}` });
  await syncFlags(env, folder.id, flags);

  // ---- Auto note ----
  meta.vault = meta.vault ?? {};
  const sections: AutoSection[] = [];
  if (s.asOf) {
    sections.push({
      key: 'account',
      match: (h) => /^Balance\b|^Account\b/i.test(h),
      heading: `Balance as of ${fmtMdy(s.asOf)}`,
      blocks: [
        kv([
          ['Balance', fmtMoney(s.balance)],
          ['Invested In', s.current.map((f) => `${f.fund} ${Math.round(f.pct)}%${f.shares !== null ? ` (${f.shares} shares @ $${f.price})` : ''}`).join(' · ') || '—'],
          ['New Money Goes To', s.election ? Object.entries(s.election).map(([f, p]) => `${f} ${p}%`).join(' · ') : '—'],
          ['Put In (Lifetime)', `${fmtMoney(s.contributions.lifetime)} traditional (pre-tax)${s.contributions.roth ? ` + ${fmtMoney(s.contributions.roth)} Roth` : ''}`],
          ['Beneficiary', s.beneficiary === false ? 'None designated — paid by the legal order (spouse, children, parents, estate)' : s.beneficiary ? 'Designated' : '—'],
        ]),
      ],
    });
  }
  if (s.returns) {
    const r = s.returns;
    const lf = s.vsFunds.find((f) => f.held);
    sections.push({
      key: 'performance',
      match: (h) => /^Performance\b/i.test(h),
      heading: 'Performance',
      blocks: [
        table(
          ['', 'YTD', '1 Year', '3 Years / yr', '5 Years / yr', '10 Years / yr', 'Since Start / yr'],
          [
            ['Your account', pctTxt(r.ytd), pctTxt(r.y1), pctTxt(r.y3), pctTxt(r.y5), pctTxt(r.y10), pctTxt(r.since)],
            ...(lf ? [[`${lf.fund} (TSP)`, pctTxt(lf.ytd), pctTxt(lf.y1), pctTxt(lf.y3), pctTxt(lf.y5), '—', '—']] : []),
          ]
        ),
        para(`Time-weighted from the statements since ${r.sinceDate ? fmtMdy(r.sinceDate) : '—'}. Fund figures as printed by the TSP${s.vsFundsAsOf ? ` (as of ${fmtMdy(s.vsFundsAsOf)})` : ''}.`),
      ],
    });
  }
  if (s.years.length) {
    sections.push({
      key: 'years',
      match: (h) => /^By Year\b/i.test(h),
      heading: 'By Year',
      blocks: [table(['Year', 'Start', 'End', 'Gain', 'Return'], [...s.years].reverse().map((y) => [`${y.year}${y.partial ? ' (part)' : ''}`, fmtMoney(y.start), fmtMoney(y.end), fmtMoney(y.gain), pctTxt(y.ret)]))],
    });
  }
  if (s.insights.length) {
    sections.push({ key: 'check', match: (h) => /^Things to Check\b/i.test(h), heading: 'Things to Check', blocks: [bullets(s.insights.map((i) => [bold(`${i.title}. `), i.detail]))] });
  }
  if (stmts.length) {
    sections.push({
      key: 'statements',
      match: (h) => /^(Recent )?Statements$/i.test(h.trim()),
      heading: 'Recent Statements',
      blocks: [
        table(
          ['Statement', 'Balance', ''],
          [...stmts]
            .sort((a, b) => b.date.localeCompare(a.date))
            .slice(0, 8)
            .map((st) => [`${fmtMdy(st.date)}${st.values.kind === 'annual' ? ' · Annual' : st.values.kind === 'interim' ? ' · On Demand' : ''}`, fmtMoney(st.values.closing), fileUrl(st.fileId) ? link('View', fileUrl(st.fileId)!) : '']),
        ),
      ],
    });
  }
  const intro = [kv([['Plan', 'Thrift Savings Plan (Uniformed Services)'], ['Contact', [link('tsp.gov', template.account.site!), ` · ThriftLine ${template.account.phone}`]]])];
  meta.vault.note = await syncAutoNote(env, entry.id, meta.vault.note, 'Account & Performance', intro, sections);
  const latest = s.latest;
  meta.vault.links = await syncManagedLinks(env, entry.id, meta.vault.links, [
    { key: 'site', title: 'TSP My Account', url: 'https://www.tsp.gov' },
    { key: 'dashboard', title: 'Finance Dashboard', url: `${appOrigin(env)}/finance/${folder.id}` },
    { key: 'folder', title: `Drive Folder · ${folder.folder_name}`, url: folder.folder_url },
    { key: 'latest', title: latest ? `Latest Statement · ${fmtMdy(latest.date)}` : 'Latest Statement', url: latest ? fileUrl(latest.fileId) : null, live: true },
  ]);
  await env.DB.prepare('UPDATE statement_folders SET meta_json = ? WHERE id = ?').bind(JSON.stringify(meta), folder.id).run();
}
