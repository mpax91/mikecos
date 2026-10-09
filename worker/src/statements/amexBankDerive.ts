import type { Env } from '../types';
import { fmtMdy, fmtMoney } from './common';
import type { FolderRow } from './engine';
import { appOrigin, easternToday, ensureVaultEntry, seedFacts, syncAutoNote, syncFlags, syncManagedLinks } from './engine';
import type { AutoSection } from './engine';
import { bold, bullets, heading, kv, link, para, table } from './vaultDoc';
import { crossCheckAmexBank } from './templates/amexBank';
import type { AmexBankValues } from './templates/amexBank';
import { templateById } from './templates';
import { amexLabel, summarizeAmexBank } from './amexBankSummary';
import type { AmexStmtRow, AmexTxnRow } from './amexBankSummary';
import { syncTaxPacketSection } from './taxPacket';

/** American Express High Yield Savings outputs: Vault entry "American
 * Express Savings" (Savings ••8815), flags (unreadable / duplicate files —
 * the 2011–2012 image-only scans as ONE info flag —, failed math, a missing
 * month, no new statement, a fee, an APY change / fall on the latest
 * statement) and a Tax Packet section (interest; 1099-INT expected when
 * the year's interest is $10 or more). Cash Placement reads it through
 * CASH_SOURCES (cross-bank savings rule only — there's no checking here). */

interface FolderMeta {
  vault?: { note?: { noteId?: string; written?: string[] }; links?: Record<string, string> };
}

/** Statements are dated the 10th; flag when the next one is this late. */
const NEW_STATEMENT_GRACE_DAYS = 10;
/** APY falling this much (percentage points) over the last three
 * statements is worth a look at other high-yield rates. */
const APY_DROP_PP = 0.25;
/** A 1099-INT is issued when a year's interest is at least this. */
const FORM_1099_INT_MIN = 10;

export async function loadAmexBankData(env: Env, folderId: string) {
  const [stmtRes, txnRes, fileRes] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM statements WHERE folder_row_id = ? ORDER BY period_end ASC').bind(folderId),
    env.DB.prepare('SELECT txn_date, description, kind, amount FROM statement_transactions WHERE folder_row_id = ? ORDER BY txn_date ASC, position ASC').bind(folderId),
    env.DB.prepare('SELECT * FROM statement_files WHERE folder_row_id = ? ORDER BY file_name ASC').bind(folderId),
  ]);
  const stmts: AmexStmtRow[] = ((stmtRes.results ?? []) as Record<string, string>[]).map((r) => ({
    id: r.id,
    fileId: r.file_id,
    periodEnd: r.period_end,
    values: JSON.parse(r.values_json) as AmexBankValues,
    checks: JSON.parse(r.checks_json),
  }));
  stmts.forEach((s, i) => s.checks.push(...crossCheckAmexBank(i ? stmts[i - 1] : null, s)));
  const txns: AmexTxnRow[] = ((txnRes.results ?? []) as Record<string, unknown>[]).map((r) => ({
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
const fileDate = (name: string) => name.match(/(\d{4})\.(\d{2})\.(\d{2})/)?.slice(1, 4).join('-') ?? null;

export async function deriveAmexBank(env: Env, folder: FolderRow): Promise<void> {
  const template = templateById('amexBank')!;
  const today = easternToday();
  const { stmts, txns, files } = await loadAmexBankData(env, folder.id);
  const s = summarizeAmexBank(stmts, txns, today);
  const latest = stmts[stmts.length - 1] ?? null;
  const fileUrl = (fileId: string) => files.find((f) => f.file_id === fileId)?.web_url ?? null;
  const label = s.label;

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
      { label: 'Savings', value: s.last4 ? `••${s.last4}` : null },
      { label: 'Customer Service', value: template.account.phone ?? null },
    ]);
  }

  // ---- Flags ----
  const flags: { key: string; severity: 'warn' | 'info'; message: string }[] = [];
  // Image-only scans (no text at all) are one info flag, not one per file.
  const scans = files.filter((f) => f.status === 'unreadable' && /image-only/i.test(f.error ?? ''));
  if (scans.length) {
    const dates = scans.map((f) => fileDate(f.file_name)).filter((d): d is string => !!d).sort();
    const range = dates.length ? ` (${shortMonth(dates[0])} – ${shortMonth(dates[dates.length - 1])})` : '';
    flags.push({ key: `scans:${scans.length}`, severity: 'info', message: `${scans.length} American Express statement${scans.length === 1 ? ' is an image-only scan' : 's are image-only scans'}${range} — kept in Drive, but there’s no text to read` });
  }
  for (const f of files) {
    if (scans.includes(f)) continue;
    if (f.status === 'unreadable' || f.status === 'failed') flags.push({ key: `file:${f.file_id}`, severity: 'warn', message: `Couldn’t read “${f.file_name}”: ${f.error ?? 'unknown error'}` });
    if (f.status === 'duplicate') flags.push({ key: `dup:${f.file_id}`, severity: 'info', message: `“${f.file_name}” is a duplicate — ${f.error}` });
  }
  for (const st of stmts) {
    for (const c of st.checks.filter((c) => !c.ok)) {
      flags.push({ key: `check:${st.periodEnd}:${c.name}`, severity: 'warn', message: `${fmtMdy(st.periodEnd)} American Express statement failed “${c.name}” (${c.detail})` });
    }
  }
  for (const ym of s.gaps) {
    flags.push({ key: `gap:${ym}`, severity: 'warn', message: `No American Express statement for ${monthName(ym)} in the Drive folder — download it from personalsavings.americanexpress.com (Statements)` });
  }
  if (latest && s.nextExpected && daysBetween(s.nextExpected, today) > NEW_STATEMENT_GRACE_DAYS) {
    flags.push({ key: `missing_after:${latest.periodEnd}`, severity: 'warn', message: `No American Express statement in Drive since ${fmtMdy(latest.periodEnd)} — the ${fmtMdy(s.nextExpected)} one should be on the American Express site` });
  }
  if (latest) {
    const prevEnd = stmts[stmts.length - 2]?.periodEnd ?? '';
    for (const e of s.events.filter((e) => e.date > prevEnd && e.date <= latest.periodEnd)) {
      flags.push({ key: `fee:${e.date}:${e.amount}`, severity: 'info', message: `American Express charged a fee on ${fmtMdy(e.date)}: ${e.description} ${fmtMoney(e.amount)}` });
    }
    const change = s.rateChanges[s.rateChanges.length - 1];
    if (change && change.date === latest.periodEnd) {
      flags.push({ key: `apy_change:${change.date}`, severity: 'info', message: `${label} APY changed ${pct(change.from)} → ${pct(change.to)} on the ${fmtMdy(change.date)} statement` });
    }
    const pts = s.apyPoints;
    const cur = pts[pts.length - 1];
    const then = pts[pts.length - 4];
    if (cur && then && cur.date === latest.periodEnd && then.apy - cur.apy >= APY_DROP_PP) {
      flags.push({ key: `apy_drop:${s.last4}:${cur.date}`, severity: 'info', message: `${label} APY fell from ${pct(then.apy)} (${shortMonth(then.date)}) to ${pct(cur.apy)} — worth comparing high-yield savings rates` });
    }
  }
  await syncFlags(env, folder.id, flags);

  // ---- Auto note "Account Details" ----
  meta.vault = meta.vault ?? {};
  const sections: AutoSection[] = [];
  if (latest) {
    const v = latest.values;
    sections.push({
      key: 'balance',
      match: (h) => /^Balance\b/i.test(h),
      heading: `Balance as of ${fmtMdy(latest.periodEnd)}`,
      blocks: [
        kv([
          [label, fmtMoney(v.ending)],
          ['APY', `${pct(s.apy)}${v.rate !== null ? ` (rate ${v.rate.toFixed(3)}%)` : ''}`],
          [`Interest ${latest.periodEnd.slice(0, 4)}`, fmtMoney(s.interestYtd)],
          ['Last Statement', `${fmtMoney(v.credits)} in · ${fmtMoney(v.debits)} out · ${fmtMoney(v.interest)} interest`],
        ]),
        para(`Next statement around ${s.nextExpected ? fmtMdy(s.nextExpected) : '—'}.`),
      ],
    });
    sections.push({
      key: 'rates',
      match: (h) => /^Rate History$/i.test(h.trim()),
      heading: 'Rate History',
      blocks: s.rateChanges.length
        ? [
            table(
              ['Statement', 'APY'],
              [...s.rateChanges].reverse().slice(0, 12).map((c) => [fmtMdy(c.date), `${pct(c.from)} → ${pct(c.to)}`])
            ),
            para(`${s.rateChanges.length} rate changes since ${s.apyPoints[0] ? shortMonth(s.apyPoints[0].date) : '—'}; the full chart is on the Finance dashboard.`),
          ]
        : [para('No rate changes yet.')],
    });
    sections.push({
      key: 'interest',
      match: (h) => /^Interest by Year$/i.test(h.trim()),
      heading: 'Interest by Year',
      blocks: [
        table(
          ['Year', 'Interest', 'APY'],
          [...s.interestYears].reverse().map((y) => {
            const pts = s.apyPoints.filter((p) => p.date.startsWith(String(y.year)));
            const apy = pts.length ? (pts[0].apy === pts[pts.length - 1].apy ? pct(pts[0].apy) : `${pct(pts[0].apy)} → ${pct(pts[pts.length - 1].apy)}`) : '—';
            return [`${y.year}${y.december ? '' : ' (partial)'}`, fmtMoney(y.total), apy];
          })
        ),
        para([bold('Since '), `${s.firstStatement ? shortMonth(s.firstStatement) : '—'}: ${fmtMoney(s.interestLifetime)} interest earned (readable statements).`]),
      ],
    });
    sections.push({
      key: 'statements',
      match: (h) => /^(Recent )?Statements$/i.test(h.trim()),
      heading: 'Recent Statements',
      blocks: [
        table(
          ['Statement', 'In', 'Out', 'Interest', 'Balance', ''],
          [...stmts]
            .reverse()
            .slice(0, 12)
            .map((st) => {
              const url = fileUrl(st.fileId);
              const x = st.values;
              return [fmtMdy(st.periodEnd), fmtMoney(x.credits - x.interest), fmtMoney(x.debits), fmtMoney(x.interest), fmtMoney(x.ending), url ? link('View', url) : ''];
            })
        ),
        para(`All ${stmts.length} statements are on the Finance dashboard.`),
      ],
    });
  }
  const history: string[] = [];
  if (s.firstStatement) history.push(`${fmtMdy(s.firstStatement)}: first readable statement (${stmts[0].values.product ?? 'High Yield Savings'} ••${s.last4})`);
  const firstB = stmts.find((x) => x.values.era === 'B');
  if (firstB && stmts[0]?.values.era === 'A') history.push(`${fmtMdy(firstB.periodEnd)}: statements switched to the current layout (account shown as xxxxxxxx${s.last4})`);
  for (const e of s.events) history.push(`${fmtMdy(e.date)}: ${e.description} ${fmtMoney(e.amount)}`);
  for (const ym of s.gaps) history.push(`${monthName(ym)}: statement missing from Drive`);
  history.sort((a, b) => Date.parse(a.split(':')[0]) - Date.parse(b.split(':')[0]));
  sections.push({
    key: 'history',
    match: (h) => /^Change History$/i.test(h.trim()),
    heading: 'Change History',
    blocks: [history.length ? bullets(history) : para('No changes yet.')],
  });
  const intro = [
    heading(2, 'Account'),
    kv([
      ['Bank', template.account.institution],
      [label, s.product ?? 'High Yield Savings Account'],
      ['Owner', s.holders ?? '—'],
      ['Contact', template.account.site ? [link('personalsavings.americanexpress.com', template.account.site), ` · ${template.account.phone ?? ''}`] : template.account.phone ?? '—'],
    ]),
  ];
  meta.vault.note = await syncAutoNote(env, entry.id, meta.vault.note, 'Account Details', intro, sections);
  meta.vault.links = await syncManagedLinks(env, entry.id, meta.vault.links, [
    { key: 'site', title: 'American Express Savings', url: template.account.site ?? null },
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
          [`Interest · ${label}`, `${fmtMoney(y.total)} ${y.december ? '(full year)' : `through ${fmtMdy(last.periodEnd)}`}`],
          [
            'Form 1099-INT',
            form?.web_url
              ? link('View in Drive', form.web_url)
              : needsForm
                ? `Expected from American Express by January 31, ${y.year + 1}${y.december ? '' : ' (if the year’s interest is $10 or more)'}`
                : 'Not expected (under $10 of interest)',
          ],
        ]),
      ],
      expected: needsForm || form ? [{ label: `American Express 1099-INT ${y.year}`, received: !!form }] : [],
      links: form?.web_url ? [{ key: '1099int', title: `American Express · 1099-INT ${y.year}`, url: form.web_url }] : [],
    });
  }
}
