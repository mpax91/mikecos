import type { Env } from '../types';
import { fmtMdy, fmtMoney } from './common';
import type { FolderRow } from './engine';
import { appOrigin, easternToday, ensureVaultEntry, seedFacts, syncAutoNote, syncFlags, syncManagedLinks, syncReminderTask } from './engine';
import type { AutoNoteState, AutoSection } from './engine';
import { bullets, heading, kv, link, para, table } from './vaultDoc';
import { syncTaxPacketSection } from './taxPacket';
import { crossCheckNy529 } from './templates/ny529';
import type { Ny529Values } from './templates/ny529';
import { templateById } from './templates';
import { DEFAULT_NY529_SETTINGS, summarizeNy529 } from './ny529Summary';
import type { Ny529Settings, StmtRow, TxnRow } from './ny529Summary';

/** NY 529 outputs: Vault note "NY 529 · Chase", flags (missed/changed AIP,
 * missing quarterly statement, failed math, unreadable files), the Dec 1
 * top-up reminder, the January limit check, and its Tax Packet lines. */

interface FolderMeta {
  vault?: { noteId?: string; note?: AutoNoteState; links?: Record<string, string> };
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
  // Auto projection rate switched to the account's own return: say so for
  // ~60 days after the first statement past the history threshold.
  const pj = s.projection;
  if (pj?.source === 'actual' && pj.actualFrom) {
    const firstQualifying = stmts.find((x) => x.periodEnd >= pj.actualFrom!);
    if (firstQualifying && addDays(firstQualifying.periodEnd, 60) >= today) {
      flags.push({
        key: `projection_actual:${firstQualifying.periodEnd}`,
        severity: 'info',
        message: `The 529 projection now uses your actual return (${pj.returnPct.toFixed(1)}%/yr since ${fmtMdy(s.actualReturn!.since)}) instead of the ${settings.projectionReturnPct}% placeholder`,
      });
    }
  }
  await syncFlags(env, folder.id, flags);

  // ---- Vault entry (one per account) ----
  // See docs/statement-templates/README.md. Quick Facts are Mike's (a few
  // evergreen ones seeded at creation, never touched again); Links are
  // created once (only Latest Statement stays current); the auto note's
  // owned sections refresh nightly and everything else in it is Mike's.
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
  const v = latest?.values;
  if (entry.created) {
    meta.vault = {};
    await seedFacts(env, entry.id, [
      { label: 'Account', value: v ? `••${v.accountLast}` : null },
      { label: 'Beneficiary', value: v?.beneficiary ?? null },
      { label: 'Plan Phone', value: template.account.phone ?? null },
    ]);
  }
  meta.vault = meta.vault ?? {};
  const asOfShort = s.asOf ? fmtMdy(s.asOf) : null;

  const history: string[] = [];
  for (const c of s.aipChanges) history.push(`${fmtMdy(c.date)}: monthly deposit ${fmtMoney(c.from)} → ${fmtMoney(c.to)}`);
  for (let i = 1; i < stmts.length; i++) {
    const a = stmts[i - 1].values, b = stmts[i].values;
    const pa = a.holdings.map((h) => h.portfolio).join(', '), pb = b.holdings.map((h) => h.portfolio).join(', ');
    if (pa !== pb) history.push(`${fmtMdy(stmts[i].periodEnd)}: portfolio ${pa} → ${pb}`);
    if (a.beneficiary !== b.beneficiary) history.push(`${fmtMdy(stmts[i].periodEnd)}: beneficiary ${a.beneficiary} → ${b.beneficiary}`);
  }
  const dashUrl = `${appOrigin(env)}/finance/${folder.id}`;
  const sections: AutoSection[] = [];
  if (latest) {
    sections.push(
      {
        key: 'balances',
        match: (h) => /^Balances\b/i.test(h),
        heading: `Balances as of ${asOfShort}`,
        blocks: [
          kv([
            ['Value', fmtMoney(s.value)],
            ['Contributed', fmtMoney(s.principal)],
            ['Earnings', `${fmtMoney(s.earnings)}${s.gainPct !== null ? ` (${s.gainPct > 0 ? '+' : ''}${s.gainPct.toFixed(2)}%)` : ''}`],
          ]),
        ],
      },
      {
        key: 'deduction',
        match: (h) => /NY Deduction$/i.test(h),
        heading: `${s.year} NY Deduction`,
        blocks: [
          kv([
            ['On Statements', `${fmtMoney(s.ytdContributions)}${s.ytdAsOf ? ` through ${fmtMdy(s.ytdAsOf)}` : ''}`],
            ['Projected by Dec 31', `${fmtMoney(s.projectedYearEnd)} (+${s.remainingDrafts} monthly deposits)`],
            ['Limit', `${fmtMoney(s.limit)}${(settings.limitConfirmedYear ?? 0) >= year ? ` (confirmed for ${year})` : ' (not yet confirmed this year)'}`],
            ['Top-Up Needed', s.gap >= 1 ? `${fmtMoney(s.gap)} by Dec 31 — reminder Dec 1` : 'None — on pace'],
          ]),
        ],
      },
      {
        key: 'statements',
        match: (h) => /^Statements$/i.test(h.trim()),
        heading: 'Statements',
        blocks: [
          table(
            ['Quarter', 'Ending Value', 'Contributions', 'Return', ''],
            [...s.quarters].reverse().map((q) => {
              const url = fileUrl(q.fileId);
              return [
                `Q${Math.ceil(Number(q.periodEnd.slice(5, 7)) / 3)} ${q.periodEnd.slice(0, 4)}`,
                fmtMoney(q.ending),
                fmtMoney(q.contributions),
                q.returnPct === null ? '—' : `${q.returnPct > 0 ? '+' : ''}${q.returnPct.toFixed(2)}%`,
                url ? link('View', url) : '',
              ];
            })
          ),
        ],
      }
    );
  }
  sections.push({
    key: 'history',
    match: (h) => /^Change History$/i.test(h.trim()),
    heading: 'Change History',
    blocks: [history.length ? bullets(history) : para('No changes yet.')],
  });
  // Seeded only when the note is first created; Mike's from then on.
  const intro = [
    heading(2, 'Account'),
    kv([
      ['Plan', template.account.institution],
      ['Account Type', v?.accountType ?? template.account.type],
      ['Account Owner', v?.owner ?? '—'],
      ['Beneficiary', v?.beneficiary ?? '—'],
      ['Account', v ? `••${v.accountLast}` : '—'],
      ['Portfolio', s.portfolio ?? '—'],
      ['Monthly AIP', s.aip ? `${fmtMoney(s.aip.amount)} around the ${ordinal(s.aip.day)} (since ${fmtMdy(s.aip.startedOn)})` : 'None found'],
      ['Plan Contact', template.account.site ? [link(template.account.site.replace(/^https?:\/\/(www\.)?/, ''), template.account.site), ` · ${template.account.phone ?? ''}`] : template.account.phone ?? '—'],
    ]),
  ];
  const noteState = await syncAutoNote(env, entry.id, meta.vault.note ?? (meta.vault.noteId ? { noteId: meta.vault.noteId, written: ['balances', 'deduction', 'statements', 'history'] } : undefined), 'Account Details', intro, sections);
  meta.vault.note = noteState;
  delete meta.vault.noteId;
  meta.vault.links = await syncManagedLinks(env, entry.id, meta.vault.links, [
    { key: 'site', title: 'NY 529 Direct Plan', url: template.account.site ?? null },
    { key: 'dashboard', title: 'Finance Dashboard', url: dashUrl },
    // Latest Statement link retired (Mike, 2026-10-06): the Drive folder link covers it.
    { key: 'latest', title: 'Latest Statement', url: null },
    { key: 'folder', title: `Drive Folder · ${folder.folder_name}`, url: folder.folder_url },
  ]);

  // ---- Reminders ----
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

  // ---- Tax Packet section, per tax year with statements ----
  const years = [...new Set(stmts.map((x) => Number(x.periodEnd.slice(0, 4))))];
  for (const y of years) {
    const yearStmts = stmts.filter((x) => x.periodEnd.startsWith(String(y)));
    const last = yearStmts[yearStmts.length - 1];
    const q4 = yearStmts.find((x) => x.periodEnd === `${y}-12-31`);
    const q4Url = q4 ? fileUrl(q4.fileId) : null;
    await syncTaxPacketSection(env, y, folder.id, {
      title: template.account.nickname,
      blocks: [
        kv([
          ['Contributions', `${fmtMoney(last.values.ytdContributions)} through ${fmtMdy(last.periodEnd)}${q4 ? ' (full year)' : ''}`],
          ['NY Deductible', `${fmtMoney(Math.min(last.values.ytdContributions, settings.nyLimit))} (max ${fmtMoney(settings.nyLimit).replace(/\.00$/, '')}, joint)`],
          ['Q4 Statement', q4Url ? link('View in Drive', q4Url) : `Not in Drive yet — expected early January ${y + 1}`],
        ]),
      ],
      expected: [{ label: `NY 529 Q4 ${y} statement`, received: !!q4 }],
      links: q4Url ? [{ key: 'q4', title: `NY 529 · Q4 ${y} Statement`, url: q4Url }] : [],
    });
  }
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

