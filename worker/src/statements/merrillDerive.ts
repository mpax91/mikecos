import type { Env } from '../types';
import { fmtMdy, fmtMoney } from './common';
import type { FolderRow } from './engine';
import { appOrigin, easternToday, ensureVaultEntry, seedFacts, syncAutoNote, syncFlags, syncManagedLinks } from './engine';
import type { AutoSection } from './engine';
import { bold, bullets, kv, link, para, table } from './vaultDoc';
import type { MlValues } from './templates/merrill';
import { templateById } from './templates';
import { KIDDIE_PARENT, summarizeMerrill, TYPE_LABEL } from './merrillSummary';
import type { MerrillSummary, MlContext, MlStmtRow, MlTxnRow } from './merrillSummary';
import { loadMarket, refreshMarket } from './market';
import { syncTaxPacketSection } from './taxPacket';

/** Merrill Lynch outputs: Vault entry "Merrill Lynch" (auto note "Accounts &
 * Performance"), flags, a Tax Packet section (CMA + Chase's UTMA), and the
 * nightly benchmark-price refresh. Analysis lives in merrillSummary.ts. */

interface FolderMeta {
  vault?: { note?: { noteId?: string; written?: string[] }; links?: Record<string, string> };
}

export interface MerrillSettings {
  /** Plan's retirement age — drives the glide-path reference (dashboard Plan tab). */
  retireAge: number;
}
export const DEFAULT_MERRILL_SETTINGS: MerrillSettings = { retireAge: 60 };

export function merrillSettings(folder: FolderRow): MerrillSettings {
  try {
    const s = folder.settings_json ? JSON.parse(folder.settings_json) : {};
    const age = Number(s.retireAge);
    return { retireAge: Number.isFinite(age) && age >= 40 && age <= 80 ? Math.round(age) : DEFAULT_MERRILL_SETTINGS.retireAge };
  } catch {
    return DEFAULT_MERRILL_SETTINGS;
  }
}

/** Monthly packages close the last business day; the next one is in Drive ~a week later. */
const NEW_STATEMENT_GRACE_DAYS = 45;

export async function loadMerrillData(env: Env, folderId: string) {
  const [stmtRes, txnRes, fileRes] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM statements WHERE folder_row_id = ? ORDER BY period_end ASC').bind(folderId),
    env.DB.prepare('SELECT txn_date, description, kind, amount, units, account FROM statement_transactions WHERE folder_row_id = ? ORDER BY txn_date ASC, position ASC').bind(folderId),
    env.DB.prepare('SELECT * FROM statement_files WHERE folder_row_id = ? ORDER BY file_name ASC').bind(folderId),
  ]);
  const stmts: MlStmtRow[] = ((stmtRes.results ?? []) as Record<string, string>[]).map((r) => ({
    id: r.id,
    fileId: r.file_id,
    periodEnd: r.period_end,
    date: r.period_end.slice(0, 10),
    values: JSON.parse(r.values_json) as MlValues,
    checks: JSON.parse(r.checks_json),
  }));
  const txns: MlTxnRow[] = ((txnRes.results ?? []) as Record<string, unknown>[]).map((r) => ({
    date: r.txn_date as string,
    description: r.description as string,
    kind: r.kind as string,
    amount: r.amount as number,
    units: (r.units as number | null) ?? null,
    account: (r.account as string | null) ?? null,
  }));
  const files = (fileRes.results ?? []) as { file_id: string; file_name: string; web_url: string | null; status: string; error: string | null; statement_id: string | null; modified_at: string | null }[];
  return { stmts, txns, files };
}

/** Context from elsewhere in MikeOS: Mike's birth date (Social Security
 * statements) and latest AGI (Finance → Taxes). Missing pieces stay null. */
export async function merrillContext(env: Env, folder: FolderRow, today: string): Promise<MlContext> {
  const market = await loadMarket(env);
  let birthDate: string | null = null;
  let agi: MlContext['agi'] = null;
  try {
    const row = await env.DB.prepare('SELECT data_json FROM ssa_statements ORDER BY statement_date DESC LIMIT 1').first<{ data_json: string }>();
    if (row) birthDate = (JSON.parse(row.data_json) as { birth_date?: string | null }).birth_date ?? null;
  } catch {
    /* Social Security page not set up */
  }
  try {
    const row = await env.DB.prepare('SELECT year, data_json FROM tax_returns ORDER BY year DESC LIMIT 1').first<{ year: number; data_json: string }>();
    if (row) {
      const d = JSON.parse(row.data_json) as { federal?: { agi?: number | null } };
      if (typeof d.federal?.agi === 'number') agi = { year: row.year, agi: d.federal.agi };
    }
  } catch {
    /* Taxes not set up */
  }
  return { today, market: market.rows, birthDate, agi, retireAge: merrillSettings(folder).retireAge };
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
const pctTxt = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);

export async function deriveMerrill(env: Env, folder: FolderRow): Promise<void> {
  const template = templateById('merrill')!;
  const today = easternToday();
  // Benchmarks: refresh public index prices (at most every 20h); a failure keeps the old ones.
  await refreshMarket(env).catch((err) => console.error('Benchmark refresh failed', err));
  const { stmts, txns, files } = await loadMerrillData(env, folder.id);
  const s = summarizeMerrill(stmts, txns, await merrillContext(env, folder, today));
  const latest = stmts.filter((x) => x.values.kind === 'household').slice(-1)[0] ?? null;
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
      { label: 'Accounts', value: [...s.accounts, ...(s.chase ? [s.chase] : [])].map((a) => `${TYPE_LABEL[a.type]} ••${a.last4}`).join(' · ') || null },
      { label: '24-Hour Assistance', value: template.account.phone ?? null },
    ]);
  }

  // ---- Flags ----
  const flags: { key: string; severity: 'warn' | 'info'; message: string }[] = [];
  for (const f of files) {
    if (f.status === 'unreadable' || f.status === 'failed') flags.push({ key: `file:${f.file_id}`, severity: 'warn', message: `Couldn’t read “${f.file_name}”: ${f.error ?? 'unknown error'}` });
    if (f.status === 'duplicate') flags.push({ key: `dup:${f.file_id}`, severity: 'info', message: `“${f.file_name}” is a duplicate — ${f.error}` });
  }
  for (const st of stmts) {
    if (st.values.partial) {
      flags.push({ key: `partial:${st.date}`, severity: 'info', message: `${fmtMdy(st.date)} Merrill statement: only the summary pages have text (account pages are scanned) — returns for that month use the package total` });
      continue;
    }
    for (const c of st.checks.filter((c) => !c.ok)) flags.push({ key: `check:${st.periodEnd}:${c.name}`, severity: 'warn', message: `${fmtMdy(st.date)} Merrill statement failed “${c.name}” (${c.detail})` });
  }
  if (latest && daysBetween(latest.date, today) > NEW_STATEMENT_GRACE_DAYS) {
    flags.push({ key: `missing_after:${latest.date}`, severity: 'warn', message: `No Merrill statement in Drive since ${fmtMdy(latest.date)} — download the latest from MyMerrill (Statements & Documents)` });
  }
  for (const w of s.taxes.washSales.filter((w) => daysBetween(w.sold, today) <= 75)) {
    flags.push({
      key: `wash:${w.account}:${w.sold}:${w.name}`,
      severity: 'warn',
      message: `Possible wash sale: ${w.name} sold at a loss in the ${TYPE_LABEL[w.type]} on ${fmtMdy(w.sold)} and bought again within 30 days in the ${w.buys.map((b) => TYPE_LABEL[b.type]).join(' / ')}${w.permanent ? ' — an IRA buy makes the loss permanent' : ''}`,
    });
  }
  // Performance / fee / harvest findings live in the dashboard's Things to Check — not repeated as flags.
  await syncFlags(env, folder.id, flags);

  // ---- Auto note ----
  meta.vault = meta.vault ?? {};
  const sections: AutoSection[] = [];
  const all = [...s.accounts, ...(s.chase ? [s.chase] : [])];
  if (all.length) {
    sections.push({
      key: 'accounts',
      match: (h) => /^Accounts\b/i.test(h),
      heading: `Accounts as of ${fmtMdy(s.asOf ?? today)}`,
      blocks: [
        table(
          ['Account', 'Value', 'Strategy', 'Stocks / Bonds / Cash'],
          all.map((a) => [`${a.label} ••${a.last4}`, fmtMoney(a.value), a.strategy ?? '—', `${Math.round(a.allocation.equity * 100)} / ${Math.round(a.allocation.fixed * 100)} / ${Math.round(a.allocation.cash * 100)}`])
        ),
        para([bold('Household total '), `${fmtMoney(s.total)}${s.chase ? ` (Chase’s UTMA ${fmtMoney(s.chase.value)} kept separate)` : ''}.`]),
      ],
    });
  }
  if (s.household) {
    const r = s.household.returns;
    sections.push({
      key: 'performance',
      match: (h) => /^Performance\b/i.test(h),
      heading: 'Performance (After Fees)',
      blocks: [
        table(
          ['', 'YTD', '1 Year', '3 Years / yr', 'Since Start / yr'],
          [
            ['Household (net of fees)', pctTxt(r.net.ytd), pctTxt(r.net.y1), pctTxt(r.net.y3), pctTxt(r.net.since)],
            ['Same mix in index funds', pctTxt(r.blend.ytd), pctTxt(r.blend.y1), pctTxt(r.blend.y3), pctTxt(r.blend.since)],
            ['S&P 500', pctTxt(r.spy.ytd), pctTxt(r.spy.y1), pctTxt(r.spy.y3), pctTxt(r.spy.since)],
          ]
        ),
        para(`Time-weighted, monthly. Since ${r.net.sinceStart ?? '—'}. Benchmarks: index funds in each account’s own stock/bond/cash mix (VTI, VXUS, AGG, BIL) and the S&P 500 (SPY), dividends reinvested.`),
      ],
    });
    const f = s.household.fees;
    sections.push({
      key: 'fees',
      match: (h) => /^Fees\b/i.test(h),
      heading: 'Advisory Fees',
      blocks: [
        kv([
          ['Last 12 Months', `${fmtMoney(f.trailing12)}${f.rate12 !== null ? ` (${f.rate12.toFixed(2)}%/yr)` : ''}`],
          ['This Year', fmtMoney(f.ytd)],
          ['Since Start', fmtMoney(f.allTime)],
        ]),
        table(['Year', 'Fees', 'Rate'], [...f.byYear].reverse().map((y) => [String(y.year), fmtMoney(y.fees), y.rate !== null ? `${y.rate.toFixed(2)}%` : '—'])),
      ],
    });
  }
  if (s.taxes.years.length) {
    sections.push({
      key: 'taxes',
      match: (h) => /^Taxable Accounts\b/i.test(h),
      heading: 'Taxable Accounts — Gains & Income',
      blocks: [
        table(
          ['Year', 'Short-Term', 'Long-Term', 'Losses Harvested', 'Taxable Income'],
          [...s.taxes.years].reverse().map((y) => [`${y.year}${y.partial ? ' (YTD)' : ''}`, fmtMoney(y.st), fmtMoney(y.lt), fmtMoney(y.lossesHarvested), fmtMoney(y.taxableIncome)])
        ),
        para(`Unrealized losses that could be harvested now: ${fmtMoney(-s.taxes.harvest.total)}.`),
      ],
    });
  }
  if (s.questions.length) {
    sections.push({ key: 'questions', match: (h) => /^Questions for\b/i.test(h), heading: 'Questions for the Advisor', blocks: [bullets(s.questions.map((q) => q.text))] });
  }
  if (stmts.length) {
    sections.push({
      key: 'statements',
      match: (h) => /^(Recent )?Statements$/i.test(h.trim()),
      heading: 'Recent Statements',
      blocks: [
        table(
          ['Statement', 'Value', ''],
          [...stmts]
            .reverse()
            .slice(0, 12)
            .map((st) => [`${fmtMdy(st.date)}${st.values.kind === 'chase' ? ' · Chase' : ''}`, st.values.total !== null ? fmtMoney(st.values.total) : '—', fileUrl(st.fileId) ? link('View', fileUrl(st.fileId)!) : ''])
        ),
      ],
    });
  }
  const intro = [kv([['Advisor', 'Merrill Lynch Investment Advisory Program'], ['Contact', [link('MyMerrill', template.account.site!), ` · ${template.account.phone}`]]])];
  meta.vault.note = await syncAutoNote(env, entry.id, meta.vault.note, 'Accounts & Performance', intro, sections);
  const latestFile = latest ? fileUrl(latest.fileId) : null;
  meta.vault.links = await syncManagedLinks(env, entry.id, meta.vault.links, [
    { key: 'site', title: 'MyMerrill', url: template.account.site ?? null },
    { key: 'dashboard', title: 'Finance Dashboard', url: `${appOrigin(env)}/finance/${folder.id}` },
    { key: 'folder', title: `Drive Folder · ${folder.folder_name}`, url: folder.folder_url },
    { key: 'latest', title: latest ? `Latest Statement · ${fmtMdy(latest.date)}` : 'Latest Statement', url: latestFile, live: true },
  ]);
  await env.DB.prepare('UPDATE statement_folders SET meta_json = ? WHERE id = ?').bind(JSON.stringify(meta), folder.id).run();

  // ---- Tax Packet (this year and last) ----
  await syncMerrillTaxPacket(env, folder, s, today);
}

async function syncMerrillTaxPacket(env: Env, folder: FolderRow, s: MerrillSummary, today: string) {
  const thisYear = Number(today.slice(0, 4));
  const cma = s.accounts.find((a) => a.type === 'cma');
  const ira = s.accounts.find((a) => a.type === 'ira');
  for (const y of s.taxes.years.filter((x) => x.year >= thisYear - 1)) {
    const rows: [string, string][] = [
      [`Realized gains · CMA${cma ? ` ••${cma.last4}` : ''}${s.chase ? ' + UTMA' : ''}`, `Short-term ${fmtMoney(y.st)} · long-term ${fmtMoney(y.lt)}${y.partial ? ' (year to date)' : ''}`],
      ['Taxable dividends & interest', fmtMoney(y.taxableIncome)],
      ['Losses harvested', fmtMoney(y.lossesHarvested)],
      ['Form 1099 (Consolidated)', `From Merrill by mid-February ${y.year + 1} — corrected 1099s often follow in March; wait for it before filing`],
    ];
    const rollover = ira?.rollovers.find((r) => r.year === y.year);
    if (rollover) rows.push([`IRA rollover deposits ${y.year}`, `${fmtMoney(rollover.amount)} — Form 5498 from Merrill in May; the old plan’s 1099-R should show code G (not taxable)`]);
    if (s.chase) {
      const inc = s.chase.income.byYear.find((b) => b.year === y.year)?.total ?? 0;
      rows.push([`Chase’s UTMA income ${y.year}`, `${fmtMoney(inc)} — under his own SSN; Form 8615 (kiddie tax) only if his unearned income tops ${fmtMoney(KIDDIE_PARENT)}`]);
    }
    await syncTaxPacketSection(env, y.year, folder.id, {
      title: 'Merrill Lynch',
      blocks: [kv(rows), para(`Wash sales across accounts aren’t on Merrill’s 1099 — check the Merrill dashboard’s Taxes tab (${s.taxes.washSales.filter((w) => w.sold.startsWith(String(y.year))).length} possible this year).`)],
      expected: [{ label: `Merrill Consolidated 1099 ${y.year}`, received: false }],
      links: [],
    });
  }
}
