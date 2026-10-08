import type { Env } from '../types';
import { fmtMdy, fmtMoney } from './common';
import type { FolderRow } from './engine';
import { appOrigin, easternToday, ensureVaultEntry, seedFacts, syncAutoNote, syncFlags, syncManagedLinks } from './engine';
import type { AutoSection } from './engine';
import { bold, bullets, heading, kv, link, para, table } from './vaultDoc';
import { crossCheckAlly } from './templates/ally';
import type { AllyValues } from './templates/ally';
import { templateById } from './templates';
import { accountLabel, summarizeAlly } from './allySummary';
import type { AllyStmtRow, AllyTxnRow } from './allySummary';
import { syncTaxPacketSection } from './taxPacket';

/** Ally Bank outputs: one Vault entry "Ally Bank" covering every account on
 * the combined statement (Checking ••5585 + Savings ••4477), flags
 * (unreadable / duplicate files, failed math, a missing month, no new
 * statement, fees / overdraft transfers / returned items on the latest
 * statement, a falling savings APY) and a Tax Packet section (interest by
 * account; 1099-INT expected when the year's interest is $10 or more). */

interface FolderMeta {
  vault?: { note?: { noteId?: string; written?: string[] }; links?: Record<string, string> };
}

/** Statements are dated the 25th; flag when the next one is this late. */
const NEW_STATEMENT_GRACE_DAYS = 10;
/** Savings APY earned falling this much (percentage points) over the last
 * three statements is worth a look at other high-yield rates. */
const APY_DROP_PP = 0.25;
/** Ally issues a 1099-INT when a year's interest is at least this. */
const FORM_1099_INT_MIN = 10;

export async function loadAllyData(env: Env, folderId: string) {
  const [stmtRes, txnRes, fileRes] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM statements WHERE folder_row_id = ? ORDER BY period_end ASC').bind(folderId),
    env.DB.prepare('SELECT txn_date, account, description, kind, amount FROM statement_transactions WHERE folder_row_id = ? ORDER BY txn_date ASC, position ASC').bind(folderId),
    env.DB.prepare('SELECT * FROM statement_files WHERE folder_row_id = ? ORDER BY file_name ASC').bind(folderId),
  ]);
  const stmts: AllyStmtRow[] = ((stmtRes.results ?? []) as Record<string, string>[]).map((r) => ({
    id: r.id,
    fileId: r.file_id,
    periodEnd: r.period_end,
    values: JSON.parse(r.values_json) as AllyValues,
    checks: JSON.parse(r.checks_json),
  }));
  stmts.forEach((s, i) => s.checks.push(...crossCheckAlly(i ? stmts[i - 1] : null, s)));
  const txns: AllyTxnRow[] = ((txnRes.results ?? []) as Record<string, unknown>[]).map((r) => ({
    date: r.txn_date as string,
    account: (r.account as string | null) ?? null,
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

export async function deriveAlly(env: Env, folder: FolderRow): Promise<void> {
  const template = templateById('ally')!;
  const today = easternToday();
  const { stmts, txns, files } = await loadAllyData(env, folder.id);
  const s = summarizeAlly(stmts, txns, today);
  const latest = stmts[stmts.length - 1] ?? null;
  const fileUrl = (fileId: string) => files.find((f) => f.file_id === fileId)?.web_url ?? null;
  const label = (last4: string) => {
    const a = s.accounts.find((x) => x.last4 === last4);
    return a ? accountLabel(a.kind, a.last4) : `••${last4}`;
  };

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
      ...s.accounts.filter((a) => a.open).map((a) => ({ label: a.label, value: `••${a.last4}` })),
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
      flags.push({ key: `check:${st.periodEnd}:${c.name}`, severity: 'warn', message: `${fmtMdy(st.periodEnd)} Ally statement failed “${c.name}” (${c.detail})` });
    }
  }
  for (const ym of s.gaps) {
    flags.push({ key: `gap:${ym}`, severity: 'warn', message: `No Ally statement for ${monthName(ym)} in the Drive folder — download it from ally.com (Statements & Documents)` });
  }
  if (latest && s.nextExpected && daysBetween(s.nextExpected, today) > NEW_STATEMENT_GRACE_DAYS) {
    flags.push({ key: `missing_after:${latest.periodEnd}`, severity: 'warn', message: `No Ally statement in Drive since ${fmtMdy(latest.periodEnd)} — the ${fmtMdy(s.nextExpected)} one should be on ally.com` });
  }
  if (latest) {
    const inLatest = (d: string) => d > (stmts[stmts.length - 2]?.periodEnd ?? '') && d <= latest.periodEnd;
    for (const e of s.events.filter((e) => inLatest(e.date))) {
      if (e.kind === 'fee') flags.push({ key: `fee:${e.date}:${e.account}:${e.amount}`, severity: 'info', message: `Ally charged a fee on ${fmtMdy(e.date)}: ${e.description} ${fmtMoney(e.amount)} (${label(e.account ?? '')})` });
      else if (/^Overdraft Transfer/.test(e.description) && e.amount > 0)
        flags.push({ key: `od:${e.date}:${e.account}`, severity: 'info', message: `Overdraft protection moved ${fmtMoney(e.amount)} into ${label(e.account ?? '')} on ${fmtMdy(e.date)} — checking ran short` });
      else if (/^ACH Return/.test(e.description)) flags.push({ key: `return:${e.date}:${e.account}:${e.amount}`, severity: 'warn', message: `An ACH item was returned on ${fmtMdy(e.date)} (${label(e.account ?? '')}, ${fmtMoney(e.amount)})` });
    }
    for (const a of latest.values.accounts) {
      if ((a.overdraftReturnedPeriod ?? 0) > 0) {
        flags.push({ key: `od_returned:${latest.periodEnd}:${a.last4}`, severity: 'warn', message: `${label(a.last4)} had ${fmtMoney(a.overdraftReturnedPeriod!)} in returned overdraft items on the ${fmtMdy(latest.periodEnd)} statement` });
      }
    }
    for (const last4 of new Set(s.apy.map((p) => p.last4))) {
      const pts = s.apy.filter((p) => p.last4 === last4);
      const cur = pts[pts.length - 1];
      const then = pts[pts.length - 4];
      if (cur && then && cur.date === latest.periodEnd && then.apy - cur.apy >= APY_DROP_PP) {
        flags.push({
          key: `apy_drop:${last4}:${cur.date}`,
          severity: 'info',
          message: `${label(last4)} APY earned fell from ${pct(then.apy)} (${shortMonth(then.date)}) to ${pct(cur.apy)} — worth comparing high-yield savings rates`,
        });
      }
    }
  }
  await syncFlags(env, folder.id, flags);

  // ---- Auto note "Account Details" ----
  meta.vault = meta.vault ?? {};
  const sections: AutoSection[] = [];
  if (latest) {
    sections.push({
      key: 'balances',
      match: (h) => /^Balances\b/i.test(h),
      heading: `Balances as of ${fmtMdy(latest.periodEnd)}`,
      blocks: [
        table(
          ['Account', 'Balance', 'APY Earned', `Interest ${latest.periodEnd.slice(0, 4)}`],
          [
            ...latest.values.accounts.map((a) => [label(a.last4), fmtMoney(a.ending), pct(a.apy), fmtMoney(a.interestYtd ?? 0)]),
            [bold('Total'), bold(fmtMoney(s.total)), '', bold(fmtMoney(latest.values.accounts.reduce((t, a) => t + (a.interestYtd ?? 0), 0)))],
          ]
        ),
        para(`Next statement around ${s.nextExpected ? fmtMdy(s.nextExpected) : '—'}.`),
      ],
    });
    sections.push({
      key: 'recurring',
      match: (h) => /^Recurring Payments$/i.test(h.trim()),
      heading: 'Recurring Payments',
      blocks: s.recurring.length
        ? [
            table(
              ['Payee', 'From', 'Last Amount', 'Usually Around', 'Last Paid'],
              s.recurring.map((r) => [r.payee, r.account ? label(r.account) : '—', fmtMoney(r.lastAmount), `the ${ordinal(r.typicalDay)}`, fmtMdy(r.lastDate)])
            ),
            para('Payees seen in at least 3 of the last 6 statements.'),
          ]
        : [para('None detected in the last 6 statements.')],
    });
    sections.push({
      key: 'interest',
      match: (h) => /^Interest by Year$/i.test(h.trim()),
      heading: 'Interest by Year',
      blocks: [
        table(
          ['Year', ...s.accounts.map((a) => label(a.last4)), 'Total', 'Savings APY'],
          [...s.interestYears].reverse().map((y) => {
            const pts = s.apy.filter((p) => p.date.startsWith(String(y.year)));
            const apy = pts.length ? (pts[0].apy === pts[pts.length - 1].apy ? pct(pts[0].apy) : `${pct(pts[0].apy)} → ${pct(pts[pts.length - 1].apy)}`) : '—';
            return [
              `${y.year}${y.statements < 12 ? ' (YTD)' : ''}`,
              ...s.accounts.map((a) => (y.byAccount[a.last4] !== undefined ? fmtMoney(y.byAccount[a.last4]) : '—')),
              fmtMoney(y.total),
              apy,
            ];
          })
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
          ['Statement', ...s.accounts.map((a) => label(a.last4)), 'Total', ''],
          [...stmts]
            .reverse()
            .slice(0, 12)
            .map((st) => {
              const url = fileUrl(st.fileId);
              return [
                fmtMdy(st.periodEnd),
                ...s.accounts.map((a) => {
                  const v = st.values.accounts.find((x) => x.last4 === a.last4);
                  return v ? fmtMoney(v.ending) : '—';
                }),
                fmtMoney(st.values.accounts.reduce((t, a) => t + a.ending, 0)),
                url ? link('View', url) : '',
              ];
            })
        ),
        para(`All ${stmts.length} statements are on the Finance dashboard.`),
      ],
    });
  }
  // Change History: account openings, product renames, notable events.
  const history: string[] = [];
  const lastName = new Map<string, string>();
  for (const st of stmts) {
    for (const a of st.values.accounts) {
      const nm = a.product ?? a.name;
      const prev = lastName.get(a.last4);
      if (prev === undefined) history.push(`${fmtMdy(st.periodEnd)}: ${label(a.last4)} first statement (${nm}${a.openDate ? `, opened ${fmtMdy(a.openDate)}` : ''})`);
      else if (prev !== nm) history.push(`${fmtMdy(st.periodEnd)}: ${label(a.last4)} renamed ${prev} → ${nm}`);
      lastName.set(a.last4, nm);
    }
  }
  for (const e of s.events) history.push(`${fmtMdy(e.date)}: ${e.description} ${fmtMoney(e.amount)} (${label(e.account ?? '')})`);
  for (const ym of s.gaps) history.push(`${monthName(ym)}: statement missing from Drive`);
  history.sort((a, b) => Date.parse(a.split(':')[0]) - Date.parse(b.split(':')[0]));
  sections.push({
    key: 'history',
    match: (h) => /^Change History$/i.test(h.trim()),
    heading: 'Change History',
    blocks: [history.length ? bullets(history) : para('No changes yet.')],
  });
  const holders = latest?.values.accounts.find((a) => a.holders)?.holders ?? null;
  const intro = [
    heading(2, 'Account'),
    kv([
      ['Bank', template.account.institution],
      ...s.accounts.map((a): [string, string] => [label(a.last4), [a.product, a.openDate ? `opened ${fmtMdy(a.openDate)}` : null, a.open ? null : 'no longer on statements'].filter(Boolean).join(' · ')]),
      ['Owners', holders ? `${holders}${latest?.values.accounts[0]?.ownership ? ` (${latest.values.accounts[0].ownership})` : ''}` : '—'],
      ['Contact', template.account.site ? [link('ally.com', template.account.site), ` · ${template.account.phone ?? ''}`] : template.account.phone ?? '—'],
    ]),
  ];
  meta.vault.note = await syncAutoNote(env, entry.id, meta.vault.note, 'Account Details', intro, sections);
  meta.vault.links = await syncManagedLinks(env, entry.id, meta.vault.links, [
    { key: 'site', title: 'Ally Bank', url: template.account.site ?? null },
    { key: 'dashboard', title: 'Finance Dashboard', url: `${appOrigin(env)}/finance/${folder.id}` },
    { key: 'folder', title: `Drive Folder · ${folder.folder_name}`, url: folder.folder_url },
  ]);
  await env.DB.prepare('UPDATE statement_folders SET meta_json = ? WHERE id = ?').bind(JSON.stringify(meta), folder.id).run();

  // ---- Tax Packet: interest by account, for this year and last ----
  // (older years are filed; a 1099-INT dropped in the folder — any PDF
  // with "1099" and the year in its name — is linked and checked off).
  const thisYear = Number(today.slice(0, 4));
  for (const y of s.interestYears.filter((y) => y.year >= thisYear - 1)) {
    const yearStmts = stmts.filter((x) => x.periodEnd.startsWith(String(y.year)));
    const last = yearStmts[yearStmts.length - 1];
    const full = last.periodEnd === `${y.year}-12-25` || yearStmts.length === 12;
    const form = files.find((f) => /1099/.test(f.file_name) && f.file_name.includes(String(y.year)));
    const needsForm = y.total >= FORM_1099_INT_MIN;
    await syncTaxPacketSection(env, y.year, folder.id, {
      title: template.account.nickname,
      blocks: [
        kv([
          ...s.accounts
            .filter((a) => y.byAccount[a.last4] !== undefined)
            .map((a): [string, string] => [`Interest · ${label(a.last4)}`, fmtMoney(y.byAccount[a.last4])]),
          ['Total Interest', `${fmtMoney(y.total)} ${full ? '(full year)' : `through ${fmtMdy(last.periodEnd)}`}`],
          [
            'Form 1099-INT',
            form?.web_url
              ? link('View in Drive', form.web_url)
              : needsForm
                ? `Expected from Ally by January 31, ${y.year + 1}${full ? '' : ' (if the year’s interest is $10 or more)'}`
                : 'Not expected (under $10 of interest)',
          ],
        ]),
      ],
      expected: needsForm || form ? [{ label: `Ally Bank 1099-INT ${y.year}`, received: !!form }] : [],
      links: form?.web_url ? [{ key: '1099int', title: `Ally Bank · 1099-INT ${y.year}`, url: form.web_url }] : [],
    });
  }
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}
